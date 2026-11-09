import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getFeedback, listResults } from "../src/results.js";
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

test("released results are kept and unfinished results are omitted", async () => {
  const script = scriptedFetch([
    () =>
      jsonResponse(200, {
        exercises: [
          {
            id: 3,
            studentParticipations: [
              {
                id: 8,
                repositoryUri: "https://secret.example/repo",
                submissions: [
                  { results: [{ id: 1, completionDate: "2026-01-02T00:00:00Z", score: 80, rated: true, successful: true }] },
                  { results: [{ id: 2, score: 10, rated: false }] },
                ],
              },
            ],
          },
        ],
      }),
  ]);
  const results = await listResults(env(), 7, script.fetchImpl);
  assert.equal(results.length, 1);
  assert.equal(results[0].score, 80);
  assert.equal(JSON.stringify(results).includes("secret.example"), false);
});

test("feedback text is returned and a missing result is not found", async () => {
  const state = env();
  const ok = scriptedFetch([
    () => jsonResponse(200, [{ id: 1, text: "Name the test", detailText: "expected", credits: 1, positive: true, visibility: "ALWAYS", gradingInstruction: "secret rubric" }]),
  ]);
  const feedback = await getFeedback(state, 8, 1, ok.fetchImpl);
  assert.equal(feedback[0].text, "Name the test");
  assert.equal(JSON.stringify(feedback).includes("secret rubric"), false);
  const missing = scriptedFetch([() => new Response(null, { status: 404 })]);
  await assert.rejects(() => getFeedback(state, 8, 2, missing.fetchImpl), (error) => error instanceof SafeError && error.code === "not_found");
});
