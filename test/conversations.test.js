import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listConversations, listMessages } from "../src/conversations.js";
import { SafeError } from "../src/errors.js";
import { fakeJwt, jsonResponse, scriptedFetch, tempDir } from "./support.js";

function env() {
  const directory = tempDir();
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: fakeJwt(4_102_444_800) }),
    { mode: 0o600 },
  );
  return { ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(".") };
}

test("conversations and messages drop logins and bound the page", async () => {
  const state = env();
  const conversations = scriptedFetch([
    () => jsonResponse(200, [{ id: 4, type: "channel", title: "General", members: [{ login: "student1", email: "ada@example.edu" }] }]),
  ]);
  const listed = await listConversations(state, 7, conversations.fetchImpl);
  assert.equal(listed[0].title, "General");
  assert.equal(JSON.stringify(listed).includes("student1"), false);
  assert.equal(JSON.stringify(listed).includes("ada@example.edu"), false);
  const messages = scriptedFetch([
    () =>
      jsonResponse(200, [
        {
          id: 1,
          content: "Hi",
          creationDate: "2026-01-01T00:00:00Z",
          author: { name: "Ada", login: "student1" },
          answers: [{ id: 2, content: "Reply", author: { name: "Bea", login: "student2" } }],
        },
      ]),
  ]);
  const posts = await listMessages(state, 7, 4, 0, messages.fetchImpl);
  assert.equal(posts[0].authorName, "Ada");
  assert.equal(posts[0].answers[0].authorName, "Bea");
  assert.equal(JSON.stringify(posts).includes("student1"), false);
  assert.equal(JSON.stringify(posts).includes("student2"), false);
  assert.equal(new URL(messages.calls[0].href).searchParams.get("size"), "20");
  assert.equal(messages.calls[0].method, "GET");
  const hidden = scriptedFetch([
    () => jsonResponse(200, [{ id: 3, content: "hidden-text", visibleForStudents: false, author: { name: "Ada" } }]),
  ]);
  assert.deepEqual(await listMessages(state, 7, 4, 0, hidden.fetchImpl), []);
  await assert.rejects(() => listMessages(state, 7, 4, 21, hidden.fetchImpl), (error) => error instanceof SafeError && error.code === "invalid_arguments");
  const disabled = scriptedFetch([() => new Response(null, { status: 403 })]);
  await assert.rejects(() => listConversations(state, 7, disabled.fetchImpl), (error) => error instanceof SafeError && error.code === "forbidden");
  assert.equal(disabled.calls[0].method, "GET");
});
