import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const writes = new Map<string, Promise<void>>();

export interface FileCheckpoint {
  size: number;
  mtimeMs: number;
  jump: number;
  gcid: string;
  complete: number[];
  committed: boolean;
}

export interface Checkpoint {
  version: 1;
  root: string;
  files: Record<string, FileCheckpoint>;
  receiptGcid?: string;
}

export async function loadCheckpoint(location: string, root: string): Promise<Checkpoint> {
  try {
    const value = JSON.parse(await readFile(location, "utf8")) as Checkpoint;
    if (value.version !== 1 || value.root !== root || typeof value.files !== "object") throw new Error("checkpoint does not match this directory");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, root, files: {} };
    throw error;
  }
}

export async function saveCheckpoint(location: string, value: Checkpoint): Promise<void> {
  const previous = writes.get(location) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(location), { recursive: true });
    const temporary = `${location}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, location);
  });
  writes.set(location, next);
  try { await next; } finally { if (writes.get(location) === next) writes.delete(location); }
}
