import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NntpConfig } from "./nntp.js";

export async function loadConfig(file?: string): Promise<NntpConfig> {
  const location = path.resolve(file ?? defaultConfigPath());
  const parsed = JSON.parse(await readFile(location, "utf8")) as Record<string, unknown>;
  const env = process.env;
  return {
    host: env.NASAUTHUNDER_NNTP_HOST ?? string(parsed.host, "host"),
    port: env.NASAUTHUNDER_NNTP_PORT ? number(env.NASAUTHUNDER_NNTP_PORT, "port") : number(parsed.port, "port"),
    tls: env.NASAUTHUNDER_NNTP_TLS ? boolean(env.NASAUTHUNDER_NNTP_TLS) : boolean(parsed.tls),
    username: env.NASAUTHUNDER_NNTP_USERNAME ?? string(parsed.username, "username"),
    password: env.NASAUTHUNDER_NNTP_PASSWORD ?? string(parsed.password, "password"),
    group: env.NASAUTHUNDER_NNTP_GROUP ?? string(parsed.group, "group"),
    from: env.NASAUTHUNDER_NNTP_FROM ?? string(parsed.from, "from"),
    connections: env.NASAUTHUNDER_NNTP_CONNECTIONS ? number(env.NASAUTHUNDER_NNTP_CONNECTIONS, "connections") : optionalNumber(parsed.connections, 4),
    timeoutMs: optionalNumber(parsed.timeoutMs, 30_000),
  };
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "nasauthunder", "config.json");
}

export async function initializeConfig(file?: string): Promise<string> {
  const location = path.resolve(file ?? defaultConfigPath());
  await mkdir(path.dirname(location), { recursive: true });
  const template = {
    host: "news.example.com", port: 563, tls: true,
    username: "YOUR_USERNAME", password: "YOUR_PASSWORD",
    group: "alt.binaries.test", from: "nasauthunder@example.invalid",
    connections: 4, timeoutMs: 30000,
  };
  await writeFile(location, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return location;
}

function string(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new TypeError(`configuration ${name} is required`); return value; }
function number(value: unknown, name: string): number { const result = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(result)) throw new TypeError(`configuration ${name} must be an integer`); return result; }
function optionalNumber(value: unknown, fallback: number): number { return value === undefined ? fallback : number(value, "number"); }
function boolean(value: unknown): boolean { if (value === true || value === "true" || value === "1") return true; if (value === false || value === "false" || value === "0") return false; throw new TypeError("configuration tls must be boolean"); }
