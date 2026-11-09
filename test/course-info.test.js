import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getLearningPath, listFaqs, listNotifications } from "../src/course-info.js";
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

test("accepted FAQs stay and a disabled learning path is not enabled", async () => {
  const state = env();
  const faqs = scriptedFetch([
    () =>
      jsonResponse(200, [
        { id: 1, questionTitle: "When?", questionAnswer: "Monday", faqState: "ACCEPTED" },
        { id: 2, questionTitle: "Draft", questionAnswer: "secret", faqState: "PROPOSED" },
      ]),
  ]);
  const accepted = await listFaqs(state, 7, faqs.fetchImpl);
  assert.equal(accepted.length, 1);
  assert.equal(JSON.stringify(accepted).includes("secret"), false);
  const missing = scriptedFetch([() => new Response(null, { status: 404 })]);
  await assert.rejects(() => getLearningPath(state, 7, missing.fetchImpl), (error) => error instanceof SafeError && error.code === "not_found");
  const disabled = scriptedFetch([() => new Response(null, { status: 400 })]);
  await assert.rejects(() => getLearningPath(state, 7, disabled.fetchImpl), (error) => error instanceof SafeError && error.code === "not_enabled");
});

test("notifications are paged and do not use a mutation", async () => {
  const script = scriptedFetch([
    () => jsonResponse(200, { content: [{ notificationId: 5, notificationType: "NEW_ANNOUNCEMENT", category: "GENERAL", creationDate: "2026-01-01T00:00:00Z", status: "UNSEEN" }] }),
  ]);
  const notes = await listNotifications(env(), 7, 0, script.fetchImpl);
  assert.equal(notes[0].status, "UNSEEN");
  assert.equal(script.calls[0].method, "GET");
  assert.equal(new URL(script.calls[0].href).searchParams.get("size"), "20");
});
