import net from "node:net";
import tls from "node:tls";
import { decodeArticle, encodeArticle, messageId, type ArticleIdentity } from "./protocol.js";

export interface NntpConfig {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  group: string;
  from: string;
  connections: number;
  timeoutMs: number;
}

export interface DecodedArticle { identity: ArticleIdentity; payload: Uint8Array }

export class NntpPool {
  private readonly clients: NntpClient[];
  private readonly waiters: Array<(client: NntpClient) => void> = [];
  private readonly available: NntpClient[] = [];

  constructor(readonly config: NntpConfig) {
    validateConfig(config);
    this.clients = Array.from({ length: config.connections }, () => new NntpClient(config));
    this.available.push(...this.clients);
  }

  async run<T>(operation: (client: NntpClient) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    try { return await operation(client); }
    finally { this.release(client); }
  }

  async check(): Promise<void> {
    await this.run(async (client) => { await client.connect(); });
  }

  async close(): Promise<void> { await Promise.all(this.clients.map((client) => client.close())); }

  private acquire(): Promise<NntpClient> {
    const client = this.available.pop();
    return client ? Promise.resolve(client) : new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(client: NntpClient): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(client); else this.available.push(client);
  }
}

export class NntpClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private lines: Buffer[] = [];
  private ended: Error | null = null;
  private pending: (() => void) | null = null;

  constructor(private readonly config: NntpConfig) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    this.reset();
    const socket = this.config.tls
      ? tls.connect({ host: this.config.host, port: this.config.port, servername: this.config.host })
      : net.connect({ host: this.config.host, port: this.config.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.config.timeoutMs, () => socket.destroy(new Error("NNTP I/O timed out")));
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.onEnd(error));
    socket.on("close", () => this.onEnd(new Error("NNTP connection closed")));
    await onceConnected(socket, this.config.tls);
    const greeting = await this.readCode();
    if (greeting !== 200 && greeting !== 201) throw new Error(`NNTP greeting failed with ${greeting}`);
    let auth = await this.command(`AUTHINFO USER ${this.config.username}`);
    if (auth === 381) auth = await this.command(`AUTHINFO PASS ${this.config.password}`);
    if (auth !== 281) throw new Error(`NNTP authentication failed with ${auth}`);
    const group = await this.command(`GROUP ${this.config.group}`);
    if (group !== 211) throw new Error(`NNTP group selection failed with ${group}`);
  }

  async stat(id: string): Promise<boolean> {
    await this.connect();
    const code = await this.command(`STAT ${id}`);
    if (code === 223) return true;
    if (code === 430) return false;
    throw new Error(`NNTP STAT failed with ${code}`);
  }

  async read(id: string): Promise<DecodedArticle | null> {
    await this.connect();
    await this.write(`BODY ${id}\r\n`);
    const code = await this.readCode();
    if (code === 430) return null;
    if (code !== 222) throw new Error(`NNTP BODY failed with ${code}`);
    const lines: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      if (line.equals(Buffer.from("."))) break;
      if (line[0] === 46 && line[1] === 46) line = line.subarray(1);
      lines.push(line);
      if (lines.length > 8_000) throw new Error("NNTP BODY exceeded line limit");
    }
    return decodeArticle(lines, id);
  }

  async post(identity: ArticleIdentity, payload: Uint8Array): Promise<"posted" | "exists"> {
    await this.connect();
    const id = messageId(identity.gcid, identity.index);
    if (await this.stat(id)) return "exists";
    const ready = await this.command("POST");
    if (ready !== 340) throw new Error(`NNTP POST was not accepted: ${ready}`);
    const chunks: Buffer[] = [];
    for (const line of encodeArticle(identity, payload, this.config.from, this.config.group)) {
      if (line[0] === 46) chunks.push(Buffer.from("."));
      chunks.push(Buffer.from(line), Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(".\r\n"));
    await this.write(Buffer.concat(chunks));
    const code = await this.readCode();
    if (code === 240) return "posted";
    if (await this.stat(id)) return "exists";
    throw new Error(`NNTP POST failed with ${code}`);
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    try { await this.command("QUIT"); } catch { /* best effort */ }
    this.socket = null;
    socket.destroy();
  }

  private async command(value: string): Promise<number> { await this.write(`${value}\r\n`); return this.readCode(); }
  private async readCode(): Promise<number> { const line = await this.readLine(); const code = Number(line.subarray(0, 3)); if (!Number.isInteger(code)) throw new Error("invalid NNTP response"); return code; }
  private write(value: string | Buffer): Promise<void> { const socket = this.socket; if (!socket || socket.destroyed) throw new Error("NNTP socket is unavailable"); return new Promise((resolve, reject) => socket.write(value, (error) => error ? reject(error) : resolve())); }

  private readLine(): Promise<Buffer> {
    const line = this.lines.shift();
    if (line) return Promise.resolve(line);
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.pending = () => {
        const next = this.lines.shift();
        if (next) resolve(next); else reject(this.ended ?? new Error("NNTP read interrupted"));
      };
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) break;
      this.lines.push(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end + 2);
    }
    const wake = this.pending; this.pending = null; wake?.();
  }

  private onEnd(error: Error): void { this.ended = error; const wake = this.pending; this.pending = null; wake?.(); }
  private reset(): void { this.buffer = Buffer.alloc(0); this.lines = []; this.ended = null; this.pending = null; }
}

function onceConnected(socket: net.Socket | tls.TLSSocket, secure: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const event = secure ? "secureConnect" : "connect";
    const done = () => { cleanup(); resolve(); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off(event, done); socket.off("error", fail); };
    socket.once(event, done); socket.once("error", fail);
  });
}

function validateConfig(config: NntpConfig): void {
  if (!config.host || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535
    || !config.username || !config.password || !config.group || !config.from
    || !Number.isSafeInteger(config.connections) || config.connections < 1 || config.connections > 100
    || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1_000) throw new TypeError("invalid NNTP configuration");
  for (const value of [config.host, config.username, config.password, config.group, config.from]) if (/[\r\n]/.test(value)) throw new TypeError("invalid NNTP configuration");
}
