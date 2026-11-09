import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { downloadAttachment } from "../src/downloads.js";
import { SafeError } from "../src/errors.js";
import { fakeJwt, scriptedFetch, tempDir } from "./support.js";

function env(directory) {
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: fakeJwt(4_102_444_800) }),
    { mode: 0o600 },
  );
  return { ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(".") };
}

test("a lecture attachment is saved under plugin data and off-origin paths are refused", async () => {
  const directory = tempDir();
  const script = scriptedFetch([() => new Response(Buffer.from("pdf-bytes"))]);
  const saved = await downloadAttachment(env(directory), 4, "/api/core/files/attachments/lectures/4/slides.pdf", script.fetchImpl);
  assert.equal(saved.bytes, 9);
  assert.equal(fs.readFileSync(path.join(directory, "downloads", "4", "slides.pdf"), "utf8"), "pdf-bytes");
  assert.equal(script.calls[0].method, "GET");
  assert.equal(new URL(script.calls[0].href).origin, "https://artemis.test");
  const blocked = scriptedFetch([]);
  await assert.rejects(
    () => downloadAttachment(env(directory), 4, "https://files.example/secret.pdf", blocked.fetchImpl),
    (error) => error instanceof SafeError && error.code === "invalid_arguments",
  );
  await assert.rejects(
    () => downloadAttachment(env(directory), 9, "/api/core/files/attachments/lectures/4/slides.pdf", blocked.fetchImpl),
    (error) => error instanceof SafeError && error.code === "forbidden",
  );
  assert.equal(blocked.calls.length, 0);
});
