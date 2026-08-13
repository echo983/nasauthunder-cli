import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadCheckpoint, saveCheckpoint, type Checkpoint, type FileCheckpoint } from "./checkpoint.js";
import type { DecodedArticle, NntpClient, NntpPool } from "./nntp.js";
import {
  ARTICLE_PAYLOAD_SIZE, articleCount, calculateBytesGcid, calculateFileGcid, createReceipt, messageId, normalizeGcid,
  jumpTrailer, physicalSize, type ReceiptFile,
} from "./protocol.js";

const EMPTY_GCID = "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709";

export interface UploadOptions {
  checkpoint?: string;
  jump?: number;
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
}

export type ProgressEvent =
  | { type: "scan"; files: number }
  | { type: "hash"; path: string; index: number; total: number }
  | { type: "article"; path: string; completed: number; total: number; reused: boolean }
  | { type: "file"; path: string; gcid: string; reused: boolean }
  | { type: "receipt"; gcid: string; url: string };

export interface UploadResult {
  receiptGcid: string;
  receiptUrl: string;
  files: ReceiptFile[];
}

export interface VerifyResult { receiptGcid: string; files: number; available: number; missing: string[] }

interface LocalFile { absolute: string; relative: string; components: string[]; size: number; mtimeMs: number }
export interface ArchivePool {
  readonly config: { connections: number };
  run<T>(operation: (client: Pick<NntpClient, "read" | "post">) => Promise<T>): Promise<T>;
}

export async function uploadDirectory(rootInput: string, pool: ArchivePool, options: UploadOptions = {}): Promise<UploadResult> {
  const root = path.resolve(rootInput);
  const jump = options.jump ?? 0;
  if (!Number.isSafeInteger(jump) || jump < 0) throw new RangeError("jump generation must be a non-negative safe integer");
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new TypeError("upload target must be a directory");
  const checkpointPath = path.resolve(options.checkpoint ?? path.join(root, ".nasauthunder-checkpoint.json"));
  const localFiles = await scanDirectory(root, checkpointPath);
  if (localFiles.length === 0) throw new TypeError("directory contains no regular files");
  options.onProgress?.({ type: "scan", files: localFiles.length });
  const checkpoint = await loadCheckpoint(checkpointPath, root);
  const results: ReceiptFile[] = [];

  for (let index = 0; index < localFiles.length; index++) {
    abort(options.signal);
    const file = localFiles[index];
    options.onProgress?.({ type: "hash", path: file.relative, index: index + 1, total: localFiles.length });
    let saved = checkpoint.files[file.relative];
    if (!saved || saved.size !== file.size || saved.mtimeMs !== file.mtimeMs || saved.jump !== jump) {
      saved = {
        size: file.size, mtimeMs: file.mtimeMs, jump,
        gcid: await calculateFileGcid(file.absolute, file.size, jump), complete: [], committed: false,
      };
      checkpoint.files[file.relative] = saved;
      checkpoint.receiptGcid = undefined;
      await saveCheckpoint(checkpointPath, checkpoint);
    }
    const reused = await archiveFile(file, saved, checkpoint, checkpointPath, pool, options);
    results.push({ path: file.components, size: file.size, gcid: saved.gcid });
    options.onProgress?.({ type: "file", path: file.relative, gcid: saved.gcid, reused });
  }

  const created = createReceipt(results);
  const receiptGcid = calculateBytesGcid(created.bytes, jump);
  await archiveBytes(created.bytes, receiptGcid, jump, pool, options.signal);
  checkpoint.receiptGcid = receiptGcid;
  await saveCheckpoint(checkpointPath, checkpoint);
  const receiptUrl = `https://${receiptGcid}.ch13a.com`;
  options.onProgress?.({ type: "receipt", gcid: receiptGcid, url: receiptUrl });
  return { receiptGcid, receiptUrl, files: results };
}

async function archiveFile(
  file: LocalFile,
  saved: FileCheckpoint,
  checkpoint: Checkpoint,
  checkpointPath: string,
  pool: ArchivePool,
  options: UploadOptions,
): Promise<boolean> {
  const storageSize = physicalSize(file.size, saved.jump);
  if (storageSize === 0) return true;
  const count = articleCount(storageSize);
  const base = await pool.run((client) => client.read(messageId(saved.gcid, 0)));
  if (base) {
    if (base.identity.gcid !== normalizeGcid(saved.gcid) || base.identity.index !== 0
      || base.identity.fileSize !== storageSize || base.identity.articleCount !== count) throw new Error(`occupied base marker conflicts: ${file.relative}`);
    saved.committed = true;
    saved.complete = Array.from({ length: count }, (_, index) => index);
    await saveCheckpoint(checkpointPath, checkpoint);
    return true;
  }

  const completed = new Set(saved.complete.filter((index) => index > 0 && index < count));
  const pending = Array.from({ length: Math.max(0, count - 1) }, (_, offset) => offset + 1).filter((index) => !completed.has(index));
  await parallel(pending, pool.config.connections, async (index) => {
    abort(options.signal);
    const payload = await readPart(file.absolute, file.size, saved.jump, index);
    const result = await withRetries(() => pool.run((client) => client.post({ gcid: saved.gcid, index, fileSize: storageSize, articleCount: count }, payload)), options.signal);
    completed.add(index);
    saved.complete = [...completed].sort((a, b) => a - b);
    await saveCheckpoint(checkpointPath, checkpoint);
    options.onProgress?.({ type: "article", path: file.relative, completed: completed.size, total: count, reused: result === "exists" });
  });
  abort(options.signal);
  const basePayload = await readPart(file.absolute, file.size, saved.jump, 0);
  const current = await stat(file.absolute);
  if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) throw new Error(`file changed before commit marker: ${file.relative}`);
  await withRetries(() => pool.run((client) => client.post({ gcid: saved.gcid, index: 0, fileSize: storageSize, articleCount: count }, basePayload)), options.signal);
  const verified = await pool.run((client) => client.read(messageId(saved.gcid, 0)));
  if (!verified || verified.identity.fileSize !== storageSize || verified.identity.articleCount !== count) throw new Error(`base marker readback failed: ${file.relative}`);
  saved.committed = true;
  saved.complete = Array.from({ length: count }, (_, index) => index);
  await saveCheckpoint(checkpointPath, checkpoint);
  return false;
}

export async function verifyReceipt(receiptGcidInput: string, pool: ArchivePool, signal?: AbortSignal): Promise<VerifyResult> {
  const receiptGcid = normalizeGcid(receiptGcidInput);
  const base = await pool.run((client) => client.read(messageId(receiptGcid, 0)));
  if (!base || base.identity.gcid !== receiptGcid || base.identity.index !== 0) throw new Error("receipt base marker is unavailable or invalid");
  const parts: Uint8Array[] = [base.payload];
  for (let index = 1; index < base.identity.articleCount; index++) {
    abort(signal);
    const article = await pool.run((client) => client.read(messageId(receiptGcid, index)));
    if (!article || article.identity.gcid !== receiptGcid || article.identity.index !== index
      || article.identity.fileSize !== base.identity.fileSize || article.identity.articleCount !== base.identity.articleCount) throw new Error(`receipt article ${index} is unavailable or invalid`);
    parts.push(article.payload);
  }
  const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)));
  if (bytes.byteLength !== base.identity.fileSize || calculateBytesGcid(bytes) !== receiptGcid) throw new Error("receipt object GCID does not match its bytes");
  const receipt = parseReceipt(stripJumpTrailer(bytes));
  const missing: string[] = [];
  await parallel(receipt.files, pool.config.connections, async (file) => {
    abort(signal);
    if (file.size === 0 && file.gcid === EMPTY_GCID) return;
    const marker = await pool.run((client) => client.read(messageId(file.gcid, 0)));
    if (!marker || marker.identity.gcid !== file.gcid || !await matchesLogicalSize(marker, file.size, pool)) {
      missing.push(file.path.join("/"));
    }
  });
  missing.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  return { receiptGcid, files: receipt.files.length, available: receipt.files.length - missing.length, missing };
}

async function archiveBytes(bytes: Uint8Array, gcid: string, jump: number, pool: ArchivePool, signal?: AbortSignal): Promise<void> {
  const storageSize = physicalSize(bytes.byteLength, jump);
  const count = articleCount(storageSize);
  if (count === 0) return;
  const base = await pool.run((client) => client.read(messageId(gcid, 0)));
  if (base) {
    if (base.identity.gcid !== gcid || base.identity.fileSize !== storageSize || base.identity.articleCount !== count) throw new Error("receipt base marker conflicts");
    return;
  }
  await parallel(Array.from({ length: Math.max(0, count - 1) }, (_, offset) => offset + 1), pool.config.connections, async (index) => {
    abort(signal);
    const payload = virtualBytesPart(bytes, jump, index);
    await withRetries(() => pool.run((client) => client.post({ gcid, index, fileSize: storageSize, articleCount: count }, payload)), signal);
  });
  await withRetries(() => pool.run((client) => client.post({ gcid, index: 0, fileSize: storageSize, articleCount: count }, virtualBytesPart(bytes, jump, 0))), signal);
  if (!await pool.run((client) => client.read(messageId(gcid, 0)))) throw new Error("receipt base marker readback failed");
}

async function scanDirectory(root: string, checkpointPath: string): Promise<LocalFile[]> {
  const output: LocalFile[] = [];
  async function walk(current: string, components: string[]): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (absolute === checkpointPath || absolute.startsWith(`${checkpointPath}.`) && absolute.endsWith(".tmp")) continue;
      const next = [...components, entry.name];
      if (entry.isSymbolicLink()) throw new TypeError(`symbolic links are not accepted: ${next.join("/")}`);
      if (entry.isDirectory()) await walk(absolute, next);
      else if (entry.isFile()) {
        const value = await stat(absolute);
        output.push({ absolute, relative: next.join("/"), components: next, size: value.size, mtimeMs: value.mtimeMs });
      } else throw new TypeError(`unsupported filesystem entry: ${next.join("/")}`);
    }
  }
  await walk(root, []);
  return output;
}

async function readPart(location: string, size: number, jump: number, index: number): Promise<Uint8Array> {
  const start = index * ARTICLE_PAYLOAD_SIZE;
  const storageSize = physicalSize(size, jump);
  const length = Math.min(ARTICLE_PAYLOAD_SIZE, storageSize - start);
  const buffer = Buffer.alloc(length);
  const handle = await open(location, "r");
  try {
    const fileLength = Math.max(0, Math.min(length, size - start));
    if (fileLength > 0) {
      const { bytesRead } = await handle.read(buffer, 0, fileLength, start);
      if (bytesRead !== fileLength) throw new Error(`file changed during upload: ${location}`);
    }
    if (fileLength < length) {
      const trailer = jumpTrailer(jump);
      buffer.set(trailer.subarray(start + fileLength - size, start + length - size), fileLength);
    }
    return buffer;
  } finally { await handle.close(); }
}

function virtualBytesPart(bytes: Uint8Array, jump: number, index: number): Uint8Array {
  const start = index * ARTICLE_PAYLOAD_SIZE;
  const end = Math.min(physicalSize(bytes.byteLength, jump), start + ARTICLE_PAYLOAD_SIZE);
  const output = new Uint8Array(end - start);
  const fileLength = Math.max(0, Math.min(end, bytes.byteLength) - start);
  if (fileLength > 0) output.set(bytes.subarray(start, start + fileLength));
  if (start + fileLength < end) output.set(jumpTrailer(jump).subarray(start + fileLength - bytes.byteLength, end - bytes.byteLength), fileLength);
  return output;
}

async function matchesLogicalSize(
  marker: DecodedArticle,
  logicalSize: number,
  pool: ArchivePool,
): Promise<boolean> {
  if (marker.identity.fileSize === logicalSize) return marker.identity.articleCount === articleCount(logicalSize);
  if (marker.identity.fileSize !== logicalSize + 24
    || marker.identity.articleCount !== articleCount(marker.identity.fileSize)) return false;
  const lastIndex = marker.identity.articleCount - 1;
  const last = lastIndex === 0
    ? marker
    : await pool.run((client) => client.read(messageId(marker.identity.gcid, lastIndex)));
  if (last === null) return false;
  let tail = last.payload.slice(-24);
  if (tail.byteLength < 24 && lastIndex > 0) {
    const previousIndex = lastIndex - 1;
    const previous = previousIndex === 0
      ? marker
      : await pool.run((client) => client.read(messageId(marker.identity.gcid, previousIndex)));
    if (previous === null) return false;
    const left = previous.payload.slice(-(24 - tail.byteLength));
    const joined = new Uint8Array(left.byteLength + tail.byteLength);
    joined.set(left); joined.set(tail, left.byteLength); tail = joined;
  }
  return parseJumpFromPayload(tail);
}

function parseJumpFromPayload(payload: Uint8Array): boolean {
  if (payload.byteLength < 24) return false;
  const expected = jumpTrailer(1).subarray(0, 16);
  const start = payload.byteLength - 24;
  for (let index = 0; index < expected.byteLength; index++) if (payload[start + index] !== expected[index]) return false;
  return new DataView(payload.buffer, payload.byteOffset + payload.byteLength - 8, 8).getBigUint64(0, false) !== 0n;
}

function stripJumpTrailer(bytes: Uint8Array): Uint8Array {
  return parseJumpFromPayload(bytes) ? bytes.subarray(0, bytes.byteLength - 24) : bytes;
}

async function parallel<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> { for (;;) { const index = cursor++; if (index >= values.length) return; await operation(values[index]); } }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function withRetries<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    abort(signal);
    try { return await operation(); } catch (error) { last = error; if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt)); }
  }
  throw last;
}

function abort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new Error("operation aborted"); }

function parseReceipt(bytes: Uint8Array): { files: ReceiptFile[] } {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as { format?: unknown; files?: unknown };
  if (value.format !== "nasauthunder-receipt-v2" || !Array.isArray(value.files) || value.files.length === 0) throw new Error("invalid receipt document");
  return { files: value.files.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`invalid receipt file ${index}`);
    const row = entry as Record<string, unknown>;
    if (!Array.isArray(row.path) || row.path.length === 0 || row.path.some((part) => typeof part !== "string" || !part)
      || !Number.isSafeInteger(row.size) || (row.size as number) < 0 || typeof row.gcid !== "string") throw new Error(`invalid receipt file ${index}`);
    return { path: row.path as string[], size: row.size as number, gcid: normalizeGcid(row.gcid) };
  }) };
}
