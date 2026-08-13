import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { uploadDirectory, verifyReceipt, type ArchivePool } from "../src/archive.js";
import type { NntpClient } from "../src/nntp.js";
import { articleCount, calculateBytesGcid, messageId, type ArticleIdentity } from "../src/protocol.js";

describe("local directory archive", () => {
  it("uploads continuations before base, preserves paths, and reuses a completed run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nasauthunder-cli-archive-"));
    await mkdir(path.join(root, "nested"));
    const large = Buffer.alloc(716_800 * 2 + 31, 7);
    await writeFile(path.join(root, "nested", "large.bin"), large);
    await writeFile(path.join(root, "small.txt"), "hello");
    await writeFile(path.join(root, "empty.bin"), "");
    const memory = new MemoryPool();

    const first = await uploadDirectory(root, memory);
    assert.match(first.receiptGcid, /^[0-9A-F]{40}$/);
    assert.deepEqual(first.files.map((file) => file.path), [["empty.bin"], ["nested", "large.bin"], ["small.txt"]]);
    const largeGcid = calculateBytesGcid(large);
    const order = memory.posts.filter((entry) => entry.startsWith(`<${largeGcid}`));
    assert.equal(order.at(-1), messageId(largeGcid, 0));
    assert.equal(order.length, articleCount(large.byteLength));
    const receipt = memory.get(first.receiptGcid, 0);
    assert.ok(receipt);
    const parsed = JSON.parse(new TextDecoder().decode(receipt?.payload)) as { files: Array<{ path: string[] }> };
    assert.deepEqual(parsed.files.map((file) => file.path), [["empty.bin"], ["nested", "large.bin"], ["small.txt"]]);

    const postedBefore = memory.posts.length;
    const second = await uploadDirectory(root, memory);
    assert.equal(second.receiptGcid, first.receiptGcid);
    assert.equal(memory.posts.length, postedBefore);
    const checkpoint = JSON.parse(await readFile(path.join(root, ".nasauthunder-checkpoint.json"), "utf8")) as { receiptGcid: string };
    assert.equal(checkpoint.receiptGcid, first.receiptGcid);
    assert.deepEqual(await verifyReceipt(first.receiptGcid, memory), {
      receiptGcid: first.receiptGcid, files: 3, available: 3, missing: [],
    });
  });

  it("resumes from an article checkpoint after interruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nasauthunder-cli-resume-"));
    await writeFile(path.join(root, "large.bin"), Buffer.alloc(716_800 * 4 + 9, 11));
    const memory = new MemoryPool();
    const controller = new AbortController();
    memory.onPost = () => controller.abort(new Error("test interruption"));

    await assert.rejects(uploadDirectory(root, memory, { signal: controller.signal }), /test interruption/);
    const postsBeforeResume = new Set(memory.posts);
    assert.ok(postsBeforeResume.size >= 1);

    memory.onPost = undefined;
    const resumed = await uploadDirectory(root, memory);
    assert.match(resumed.receiptGcid, /^[0-9A-F]{40}$/);
    assert.equal(memory.posts.length, new Set(memory.posts).size);
    for (const posted of postsBeforeResume) assert.equal(memory.posts.filter((id) => id === posted).length, 1);
  });

  it("publishes jump files and receipts while preserving logical receipt sizes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nasauthunder-cli-jump-"));
    const original = Buffer.alloc(716_800 - 10, 23);
    await writeFile(path.join(root, "boundary.bin"), original);
    await writeFile(path.join(root, "empty.bin"), new Uint8Array());
    const memory = new MemoryPool();
    const result = await uploadDirectory(root, memory, { jump: 5 });
    assert.equal(result.files[0].size, original.byteLength);
    assert.notEqual(result.files[0].gcid, calculateBytesGcid(original));
    const fileArticles = memory.object(result.files[0].gcid);
    assert.equal(fileArticles.byteLength, original.byteLength + 24);
    assert.deepEqual(fileArticles.subarray(0, original.byteLength), original);
    assert.equal(result.files[1].size, 0);
    assert.notEqual(result.files[1].gcid, calculateBytesGcid(new Uint8Array()));
    assert.equal(memory.object(result.files[1].gcid).byteLength, 24);
    assert.equal(await verifyReceipt(result.receiptGcid, memory).then((value) => value.available), 2);
    const checkpoint = JSON.parse(await readFile(path.join(root, ".nasauthunder-checkpoint.json"), "utf8")) as {
      files: Record<string, { jump: number }>;
    };
    assert.equal(checkpoint.files["boundary.bin"].jump, 5);
  });
});

class MemoryPool implements ArchivePool {
  readonly config = { connections: 4 };
  readonly posts: string[] = [];
  onPost?: () => void;
  private readonly articles = new Map<string, { identity: ArticleIdentity; payload: Uint8Array }>();
  private readonly client = {
    read: async (id: string) => this.articles.get(id) ?? null,
    post: async (identity: ArticleIdentity, payload: Uint8Array) => {
      const id = messageId(identity.gcid, identity.index);
      if (this.articles.has(id)) return "exists" as const;
      this.articles.set(id, { identity: { ...identity }, payload: payload.slice() });
      this.posts.push(id);
      this.onPost?.();
      return "posted" as const;
    },
  };

  async run<T>(operation: (client: Pick<NntpClient, "read" | "post">) => Promise<T>): Promise<T> {
    return operation(this.client as Pick<NntpClient, "read" | "post">);
  }

  get(gcid: string, index: number) { return this.articles.get(messageId(gcid, index)); }

  object(gcid: string): Uint8Array {
    const base = this.get(gcid, 0);
    assert.ok(base);
    const parts: Uint8Array[] = [];
    for (let index = 0; index < base.identity.articleCount; index++) {
      const article = this.get(gcid, index);
      assert.ok(article);
      parts.push(article.payload);
    }
    return Buffer.concat(parts);
  }
}
