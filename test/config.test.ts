import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { initializeConfig } from "../src/config.js";

it("creates a private configuration template without overwriting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nasauthunder-cli-config-"));
  const location = path.join(root, "nested", "config.json");
  assert.equal(await initializeConfig(location), location);
  const created = JSON.parse(await readFile(location, "utf8")) as { group: string };
  assert.equal(created.group, "alt.binaries.boneless");
  const parsed = JSON.parse(await readFile(location, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.host, "news.example.com");
  assert.equal((await stat(location)).mode & 0o777, 0o600);
  await assert.rejects(initializeConfig(location), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
});
