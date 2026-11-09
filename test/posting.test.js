import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createPost, replyToPost } from "../src/posting.js";
import { SafeError } from "../src/errors.js";
import { dashboardBody, fakeJwt, jsonResponse, scriptedFetch, tempDir } from "./support.js";

function env() {
  const directory = tempDir();
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: fakeJwt(4_102_444_800) }),
    { mode: 0o600 },
  );
  return { ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(".") };
}

function membership() {
  return jsonResponse(200, [{ id: 4, type: "channel", title: "Notes" }]);
}

test("a post is previewed and then sent once as plain text", async () => {
  const state = env();
  let sentBody;
  const script = scriptedFetch([
    () => jsonResponse(200, dashboardBody()),
    membership,
    () => jsonResponse(200, dashboardBody()),
    membership,
    (_url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse(201, { id: 15, author: { login: "student1" }, content: "Hello" });
    },
  ]);
  const preview = await createPost(state, 7, 4, "Hello", undefined, script.fetchImpl);
  assert.equal(script.calls.every((call) => call.method === "GET"), true);
  assert.equal(preview.preview.conversationTitle, "Notes");
  assert.equal(preview.preview.content, "Hello");
  const sent = await createPost(state, 7, 4, "Hello", preview.confirmationToken, script.fetchImpl);
  assert.equal(sent.postId, 15);
  assert.deepEqual(sentBody, { content: "Hello", hasForwardedMessages: false, conversation: { id: 4 } });
  assert.equal(script.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(JSON.stringify(sent).includes("student1"), false);
});

test("a reply to a post that is not on the page is not sent", async () => {
  const script = scriptedFetch([
    () => jsonResponse(200, dashboardBody()),
    membership,
    () => jsonResponse(200, [{ id: 3, content: "Hi", author: { name: "Ada" }, visibleForStudents: true }]),
  ]);
  await assert.rejects(
    () => replyToPost(env(), 7, 4, 99, "Reply", 0, undefined, script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_found",
  );
  assert.equal(script.calls.every((call) => call.method === "GET"), true);
});
