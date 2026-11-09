import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listAnnouncements } from "../src/announcements.js";
import { SafeError } from "../src/errors.js";
import { fakeJwt, jsonResponse, scriptedFetch, tempDir } from "./support.js";

function env(directory) {
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: fakeJwt(4_102_444_800) }),
    { mode: 0o600 },
  );
  return { ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(".") };
}

test("announcements keep display names and drop logins", async () => {
  const directory = tempDir();
  const script = scriptedFetch([
    () => jsonResponse(200, [{ id: 9, name: "Announcements", isAnnouncementChannel: true }, { id: 10, name: "General", isAnnouncementChannel: false }]),
    () =>
      jsonResponse(200, [
        { id: 1, title: "Welcome", content: "Hello", creationDate: "2026-01-01T00:00:00Z", author: { name: "Ada", login: "student1" }, visibleForStudents: true },
        { id: 2, title: "Hidden", content: "secret", visibleForStudents: false },
      ]),
  ]);
  const posts = await listAnnouncements(env(directory), 7, 0, script.fetchImpl);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].authorName, "Ada");
  assert.equal(JSON.stringify(posts).includes("student1"), false);
  assert.equal(script.calls.every((call) => call.method === "GET"), true);
  assert.equal(new URL(script.calls[1].href).searchParams.get("size"), "20");
});

test("a missing communication API is not enabled", async () => {
  const directory = tempDir();
  const script = scriptedFetch([() => new Response(null, { status: 404 })]);
  await assert.rejects(
    () => listAnnouncements(env(directory), 7, null, script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_enabled",
  );
});
