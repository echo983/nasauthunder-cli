#!/usr/bin/env node
import { uploadDirectory, verifyReceipt, type ProgressEvent } from "./archive.js";
import { defaultConfigPath, initializeConfig, loadConfig } from "./config.js";
import { NntpPool } from "./nntp.js";
import { calculateBytesGcid, messageId } from "./protocol.js";

const VERSION = "0.2.0";

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return help();
  if (command === "--version" || command === "-v") { console.log(VERSION); return; }
  const configPath = option(args, "--config");
  if (command === "config" && args[0] === "init") {
    const location = await initializeConfig(configPath);
    console.log(`Created ${location}`);
    console.log("Edit the file, then run: nasauthunder config check");
    return;
  }
  const config = await loadConfig(configPath);
  const pool = new NntpPool(config);
  try {
    if (command === "config" && args[0] === "check") {
      await pool.check();
      const payload = new TextEncoder().encode("nasauthunder-cli-config-check-v1\n");
      const gcid = calculateBytesGcid(payload);
      await pool.run((client) => client.post({ gcid, index: 0, fileSize: payload.byteLength, articleCount: 1 }, payload));
      if (!await pool.run((client) => client.read(messageId(gcid, 0)))) throw new Error("posting succeeded but readback failed");
      console.log(`NNTP posting OK (${config.host}:${config.port}, ${config.tls ? "TLS" : "plain"}, ${config.connections} connections configured)`);
      return;
    }
    if (command === "upload") {
      const directory = positional(args);
      if (!directory) throw new TypeError("upload requires a directory");
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort(new Error("interrupted")));
      process.once("SIGTERM", () => controller.abort(new Error("terminated")));
      const result = await uploadDirectory(directory, pool, {
        checkpoint: option(args, "--checkpoint"), jump: integerOption(args, "--jump", 0),
        signal: controller.signal, onProgress: printProgress,
      });
      console.log(`\nReceipt GCID: ${result.receiptGcid}`);
      console.log(`Open: ${result.receiptUrl}`);
      return;
    }
    if (command === "verify") {
      const gcid = positional(args);
      if (!gcid) throw new TypeError("verify requires a receipt GCID");
      const result = await verifyReceipt(gcid, pool);
      console.log(`Receipt ${result.receiptGcid}: ${result.available}/${result.files} base markers available`);
      for (const missing of result.missing) console.log(`Missing: ${missing}`);
      if (result.missing.length) process.exitCode = 2;
      return;
    }
    throw new TypeError(`unknown command: ${command}`);
  } finally { await pool.close(); }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function positional(args: readonly string[]): string | undefined {
  const valuedOptions = new Set(["--config", "--checkpoint", "--jump"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (valuedOptions.has(value)) { index++; continue; }
    if (!value.startsWith("--")) return value;
  }
  return undefined;
}

function integerOption(args: string[], name: string, fallback: number): number {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return parsed;
}

function printProgress(event: ProgressEvent): void {
  if (event.type === "scan") console.log(`Found ${event.files} files`);
  else if (event.type === "hash") console.log(`[${event.index}/${event.total}] Hashing ${event.path}`);
  else if (event.type === "article") process.stdout.write(`\rUploading ${event.path}: ${event.completed}/${event.total} articles`);
  else if (event.type === "file") console.log(`\n${event.reused ? "Reused" : "Archived"} ${event.path}  ${event.gcid}`);
  else if (event.type === "receipt") console.log(`Receipt published ${event.gcid}`);
}

function help(): void {
  console.log(`nasauthunder ${VERSION}

Usage:
  nasauthunder upload <directory> [--jump <generation>] [--config <file>] [--checkpoint <file>]
  nasauthunder verify <receipt-gcid> [--config <file>]
  nasauthunder config init [--config <file>]
  nasauthunder config check [--config <file>]

Default config: ${defaultConfigPath()}
Credentials may be overridden with NASAUTHUNDER_NNTP_* environment variables.`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`nasauthunder: ${message}`);
  process.exitCode = 1;
});
