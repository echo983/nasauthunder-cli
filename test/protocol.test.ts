import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ARTICLE_PAYLOAD_SIZE, articleCount, calculateBytesGcid, calculateFileGcid,
  createReceipt, decodeArticle, encodeArticle, gcidChunkSize, messageId,
} from "../src/protocol.js";

describe("nasauthunder protocol compatibility", () => {
  it("matches established GCID and article addressing vectors", async () => {
    assert.equal(calculateBytesGcid(new Uint8Array()), "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709");
    assert.equal(calculateBytesGcid(new TextEncoder().encode("abc")), "0D3CED9BEC10A777AEC23CCC353A8C08A633045E");
    assert.equal(gcidChunkSize(0x40000 * 0x201), 0x80000);
    assert.equal(messageId("a".repeat(40), 12), `<${"A".repeat(40)}.12@nasauthunder-v1.invalid>`);
    const directory = await mkdtemp(path.join(os.tmpdir(), "nasauthunder-cli-vector-"));
    const file = path.join(directory, "abc");
    await writeFile(file, "abc");
    assert.equal(await calculateFileGcid(file, 3), "0D3CED9BEC10A777AEC23CCC353A8C08A633045E");
  });

  it("round-trips a full 700 KiB continuation with strict CRC validation", () => {
    const payload = Uint8Array.from({ length: ARTICLE_PAYLOAD_SIZE }, (_, index) => index % 251);
    const identity = { gcid: "B".repeat(40), index: 1, fileSize: ARTICLE_PAYLOAD_SIZE * 2 + 17, articleCount: 3 };
    const lines = encodeArticle(identity, payload, "archive@example.invalid", "alt.test");
    assert.deepEqual(decodeArticle(lines, messageId(identity.gcid, 1)), { identity, payload });
    lines[8] = Uint8Array.of(...lines[8], 1);
    assert.throws(() => decodeArticle(lines, messageId(identity.gcid, 1)), /payload mismatch/);
  });

  it("emits a canonical receipt with a deterministic synthetic source identity", () => {
    const first = createReceipt([
      { path: ["é.bin"], size: 1, gcid: "C".repeat(40) },
      { path: ["A", "x.bin"], size: 2, gcid: "D".repeat(40) },
    ]);
    const second = createReceipt([
      { path: ["A", "x.bin"], size: 2, gcid: "D".repeat(40) },
      { path: ["é.bin"], size: 1, gcid: "C".repeat(40) },
    ]);
    assert.equal(first.gcid, second.gcid);
    assert.deepEqual(first.receipt.files.map((file) => file.path), [["A", "x.bin"], ["é.bin"]]);
    assert.equal(articleCount(first.bytes.byteLength), 1);
  });
});
