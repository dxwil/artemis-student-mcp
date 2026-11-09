import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { markConversationRead, markNotificationsRead } from "../src/mark-read.js";
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

test("notification read is previewed before a single PUT and the token cannot be reused", async () => {
  const state = env();
  let sentBody;
  const script = scriptedFetch([
    () => jsonResponse(200, dashboardBody()),
    () => jsonResponse(200, dashboardBody()),
    (_url, init) => {
      sentBody = JSON.parse(init.body);
      return new Response(null, { status: 200 });
    },
    () => jsonResponse(200, dashboardBody()),
  ]);
  const preview = await markNotificationsRead(state, 7, [9, 4], undefined, script.fetchImpl);
  assert.equal(script.calls.length, 1);
  assert.equal(script.calls[0].method, "GET");
  assert.deepEqual(preview.preview.notificationIds, [4, 9]);
  assert.equal(preview.preview.courseTitle, "Introduction to Informatics");
  const sent = await markNotificationsRead(state, 7, [9, 4], preview.confirmationToken, script.fetchImpl);
  assert.equal(sent.marked, 2);
  const write = script.calls.find((call) => call.method === "PUT");
  assert.equal(new URL(write.href).pathname, "/api/notification/courses/7/status");
  assert.equal(script.calls.filter((call) => call.method === "PUT").length, 1);
  assert.deepEqual(sentBody, { notificationIds: [4, 9], statusType: "SEEN" });
  await assert.rejects(
    () => markNotificationsRead(state, 7, [9, 4], preview.confirmationToken, script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "confirmation_required",
  );
  assert.equal(script.calls.filter((call) => call.method !== "GET").length, 1);
});

test("a conversation outside the membership list is not marked read", async () => {
  const script = scriptedFetch([
    () => jsonResponse(200, dashboardBody()),
    () => jsonResponse(200, [{ id: 4, type: "channel", title: "General" }]),
  ]);
  await assert.rejects(
    () => markConversationRead(env(), 7, 99, undefined, script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "forbidden",
  );
  assert.equal(script.calls.every((call) => call.method === "GET"), true);
});

test("a refused notification write is not retried", async () => {
  const state = env();
  const script = scriptedFetch([
    () => jsonResponse(200, dashboardBody()),
    () => jsonResponse(200, dashboardBody()),
    () => new Response(null, { status: 403 }),
  ]);
  const preview = await markNotificationsRead(state, 7, [4], undefined, script.fetchImpl);
  await assert.rejects(
    () => markNotificationsRead(state, 7, [4], preview.confirmationToken, script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "forbidden",
  );
  assert.equal(script.calls.filter((call) => call.method === "PUT").length, 1);
});
