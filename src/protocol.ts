import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const ARTICLE_PAYLOAD_SIZE = 716_800;
export const JUMP_TRAILER_SIZE = 24;
export const JUMP_MAGIC = Uint8Array.of(
  0x24, 0x3f, 0x6a, 0x88, 0x85, 0xa3, 0x08, 0xd3,
  0x13, 0x19, 0x8a, 0x2e, 0x03, 0x70, 0x73, 0x44,
);
const MIN_GCID_CHUNK = 0x40000;
const MAX_GCID_CHUNK = 0x200000;
const MAX_GCID_CHUNKS = 0x200;

export interface ArticleIdentity {
  gcid: string;
  index: number;
  fileSize: number;
  articleCount: number;
}

export interface ReceiptFile { path: string[]; size: number; gcid: string }
export interface ArchiveReceipt {
  format: "nasauthunder-receipt-v2";
  source: { type: "btih"; id: string };
  files: ReceiptFile[];
}

export function normalizeGcid(value: string): string {
  const normalized = value.toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) throw new TypeError("GCID must be 40 hexadecimal characters");
  return normalized;
}

export function articleCount(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("size must be a non-negative safe integer");
  return size === 0 ? 0 : Math.ceil(size / ARTICLE_PAYLOAD_SIZE);
}

export function messageId(gcid: string, index: number): string {
  const id = normalizeGcid(gcid);
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError("article index must be non-negative");
  return `<${id}${index === 0 ? "" : `.${index}`}@nasauthunder-v1.invalid>`;
}

export function gcidChunkSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("size must be a non-negative safe integer");
  let chunk = MIN_GCID_CHUNK;
  while (Math.floor(size / chunk) > MAX_GCID_CHUNKS && chunk < MAX_GCID_CHUNK) chunk *= 2;
  return chunk;
}

export function jumpTrailer(generation: number): Uint8Array {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError("jump generation must be a positive safe integer");
  const trailer = new Uint8Array(JUMP_TRAILER_SIZE);
  trailer.set(JUMP_MAGIC);
  new DataView(trailer.buffer).setBigUint64(16, BigInt(generation), false);
  return trailer;
}

export function parseJumpTrailer(tail: Uint8Array): bigint | null {
  if (tail.byteLength < JUMP_TRAILER_SIZE) return null;
  const start = tail.byteLength - JUMP_TRAILER_SIZE;
  for (let index = 0; index < JUMP_MAGIC.byteLength; index++) if (tail[start + index] !== JUMP_MAGIC[index]) return null;
  const generation = new DataView(tail.buffer, tail.byteOffset + start + 16, 8).getBigUint64(0, false);
  return generation === 0n ? null : generation;
}

export function physicalSize(logicalSize: number, generation: number): number {
  if (!Number.isSafeInteger(logicalSize) || logicalSize < 0) throw new RangeError("size must be a non-negative safe integer");
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("jump generation must be a non-negative safe integer");
  return logicalSize + (generation === 0 ? 0 : JUMP_TRAILER_SIZE);
}

export async function calculateFileGcid(path: string, size: number, generation = 0): Promise<string> {
  const storageSize = physicalSize(size, generation);
  const chunkSize = gcidChunkSize(storageSize);
  const outer = createHash("sha1");
  const handle = await open(path, "r");
  const trailer = generation === 0 ? new Uint8Array() : jumpTrailer(generation);
  try {
    const buffer = Buffer.alloc(chunkSize);
    let position = 0;
    while (position < storageSize) {
      const wanted = Math.min(chunkSize, storageSize - position);
      const fileLength = Math.max(0, Math.min(wanted, size - position));
      if (fileLength > 0) {
        const { bytesRead } = await handle.read(buffer, 0, fileLength, position);
        if (bytesRead !== fileLength) throw new Error(`file changed or ended while hashing: ${path}`);
      }
      if (fileLength < wanted) buffer.set(trailer.subarray(position + fileLength - size, position + wanted - size), fileLength);
      outer.update(createHash("sha1").update(buffer.subarray(0, wanted)).digest());
      position += wanted;
    }
    return outer.digest("hex").toUpperCase();
  } finally {
    await handle.close();
  }
}

export function calculateBytesGcid(bytes: Uint8Array, generation = 0): string {
  const trailer = generation === 0 ? new Uint8Array() : jumpTrailer(generation);
  const size = physicalSize(bytes.byteLength, generation);
  const chunk = gcidChunkSize(size);
  const outer = createHash("sha1");
  for (let offset = 0; offset < size; offset += chunk) {
    const end = Math.min(size, offset + chunk);
    const piece = new Uint8Array(end - offset);
    const fromFile = Math.max(0, Math.min(end, bytes.byteLength) - offset);
    if (fromFile > 0) piece.set(bytes.subarray(offset, offset + fromFile));
    if (offset + fromFile < end) piece.set(trailer.subarray(offset + fromFile - bytes.byteLength, end - bytes.byteLength), fromFile);
    outer.update(createHash("sha1").update(piece).digest());
  }
  return outer.digest("hex").toUpperCase();
}

export function encodeArticle(identity: ArticleIdentity, payload: Uint8Array, from: string, group: string): Uint8Array[] {
  const gcid = normalizeGcid(identity.gcid);
  const total = articleCount(identity.fileSize);
  if (identity.articleCount !== total || identity.index < 0 || identity.index >= total) throw new TypeError("invalid article identity");
  const expected = Math.min(ARTICLE_PAYLOAD_SIZE, identity.fileSize - identity.index * ARTICLE_PAYLOAD_SIZE);
  if (payload.byteLength !== expected) throw new RangeError("article payload length does not match identity");
  for (const value of [from, group]) if (!value || /[\r\n]/.test(value)) throw new TypeError("invalid article header");
  const part = identity.index + 1;
  const begin = identity.index * ARTICLE_PAYLOAD_SIZE + 1;
  const end = begin + payload.byteLength - 1;
  const crc = crc32(payload).toString(16).padStart(8, "0");
  return [
    text(`From: ${from}`), text(`Newsgroups: ${group}`),
    text(`Subject: nasauthunder ${gcid} part ${part}/${total}`),
    text(`Message-ID: ${messageId(gcid, identity.index)}`),
    text("Content-Type: application/octet-stream"), new Uint8Array(),
    text(`=ybegin part=${part} total=${total} line=128 size=${identity.fileSize} name=${gcid}.bin`),
    text(`=ypart begin=${begin} end=${end}`), ...yEncLines(payload),
    text(`=yend size=${payload.byteLength} part=${part} pcrc32=${crc}`),
  ];
}

export function decodeArticle(lines: readonly Uint8Array[], expectedId: string): { identity: ArticleIdentity; payload: Uint8Array } {
  const address = parseMessageId(expectedId);
  const decoded = lines.map((line) => new TextDecoder().decode(line));
  const beginAt = decoded.findIndex((line) => line.startsWith("=ybegin "));
  const partAt = decoded.findIndex((line) => line.startsWith("=ypart "));
  const endAt = decoded.findIndex((line) => line.startsWith("=yend "));
  if (beginAt < 0 || partAt !== beginAt + 1 || endAt <= partAt || endAt + 1 !== lines.length) throw new Error("invalid yEnc article framing");
  const size = intField(decoded[beginAt], "size");
  const total = intField(decoded[beginAt], "total");
  const part = address.index + 1;
  const expectedBegin = address.index * ARTICLE_PAYLOAD_SIZE + 1;
  const expectedEnd = Math.min(size, part * ARTICLE_PAYLOAD_SIZE);
  if (size <= 0 || total !== articleCount(size) || intField(decoded[beginAt], "part") !== part
    || intField(decoded[beginAt], "line") !== 128 || field(decoded[beginAt], "name") !== `${address.gcid}.bin`
    || intField(decoded[partAt], "begin") !== expectedBegin || intField(decoded[partAt], "end") !== expectedEnd
    || intField(decoded[endAt], "part") !== part) throw new Error("yEnc article identity mismatch");
  const payload = decodeYEnc(lines.slice(partAt + 1, endAt));
  const expectedLength = expectedEnd - expectedBegin + 1;
  if (payload.byteLength !== expectedLength || intField(decoded[endAt], "size") !== expectedLength
    || field(decoded[endAt], "pcrc32").toLowerCase() !== crc32(payload).toString(16).padStart(8, "0")) {
    throw new Error("yEnc article payload mismatch");
  }
  return { identity: { gcid: address.gcid, index: address.index, fileSize: size, articleCount: total }, payload };
}

export function createReceipt(filesInput: readonly ReceiptFile[]): { receipt: ArchiveReceipt; bytes: Uint8Array; gcid: string } {
  if (filesInput.length === 0) throw new TypeError("receipt requires at least one file");
  const files = filesInput.map((file) => ({
    path: file.path.map(validPath), size: validSize(file.size), gcid: normalizeGcid(file.gcid),
  })).sort((a, b) => comparePaths(a.path, b.path));
  const unique = new Set(files.map((file) => JSON.stringify(file.path)));
  if (unique.size !== files.length) throw new TypeError("receipt contains duplicate paths");
  const sourceId = calculateBytesGcid(new TextEncoder().encode(files.map((file) => `${JSON.stringify(file.path)}\0${file.size}\0${file.gcid}`).join("\n")));
  const receipt: ArchiveReceipt = { format: "nasauthunder-receipt-v2", source: { type: "btih", id: sourceId }, files };
  const body = files.map((file) => `{"path":${JSON.stringify(file.path)},"size":${file.size},"gcid":${JSON.stringify(file.gcid)}}`).join(",");
  const bytes = new TextEncoder().encode(`{"format":"nasauthunder-receipt-v2","source":{"type":"btih","id":${JSON.stringify(sourceId)}},"files":[${body}]}`);
  return { receipt, bytes, gcid: calculateBytesGcid(bytes) };
}

function validSize(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid size"); return value; }
function validPath(value: string): string {
  if (!value) throw new TypeError("invalid path");
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError("invalid path");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("invalid path");
  }
  return value;
}
function comparePaths(a: string[], b: string[]): number { return Buffer.from(a.join("\0")).compare(Buffer.from(b.join("\0"))); }
function text(value: string): Uint8Array { return new TextEncoder().encode(value); }
function field(value: string, name: string): string { const match = value.match(new RegExp(`(?:^| )${name}=([^ ]+)`)); if (!match?.[1]) throw new Error(`missing ${name}`); return match[1]; }
function intField(value: string, name: string): number { const result = Number(field(value, name)); if (!Number.isSafeInteger(result)) throw new Error(`invalid ${name}`); return result; }
function parseMessageId(value: string): { gcid: string; index: number } { const match = value.match(/^<([0-9A-F]{40})(?:\.(\d+))?@nasauthunder-v1\.invalid>$/); if (!match?.[1]) throw new TypeError("invalid Message-ID"); return { gcid: match[1], index: match[2] ? Number(match[2]) : 0 }; }

function yEncLines(payload: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = []; let line: number[] = [];
  for (const byte of payload) {
    const encoded = (byte + 42) & 0xff;
    const values = encoded === 0 || encoded === 10 || encoded === 13 || encoded === 61
      ? [61, (encoded + 64) & 0xff] : [encoded];
    if (line.length + values.length > 128) { lines.push(Uint8Array.from(line)); line = []; }
    line.push(...values);
  }
  if (line.length) lines.push(Uint8Array.from(line));
  return lines;
}

function decodeYEnc(lines: readonly Uint8Array[]): Uint8Array {
  const output: number[] = [];
  for (const line of lines) for (let i = 0; i < line.length; i++) {
    let value = line[i];
    if (value === 61) { if (++i >= line.length) throw new Error("truncated yEnc escape"); value = (line[i] - 64) & 0xff; }
    output.push((value - 42) & 0xff);
  }
  return Uint8Array.from(output);
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
