import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SafeError } from "../src/errors.js";
import { getExamResult, listCalendar, listExams } from "../src/schedule.js";
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

test("calendar flattens events and exams hide a future visible date", async () => {
  const state = env();
  const calendar = scriptedFetch([
    () => jsonResponse(200, { "2026-06-02": [{ type: "EXAM", title: "Midterm", startDate: "2026-06-02T08:00:00Z", endDate: null, location: "Room 1" }] }),
  ]);
  const events = await listCalendar(state, 7, "2026-06", "UTC", calendar.fetchImpl);
  assert.equal(events[0].location, "Room 1");
  assert.equal(new URL(calendar.calls[0].href).searchParams.get("timeZone"), "UTC");
  const exams = scriptedFetch([
    () =>
      jsonResponse(200, [
        { id: 1, title: "Midterm", visibleDate: "2020-01-01T00:00:00Z", startDate: "2026-06-02T08:00:00Z", endDate: "2026-06-02T10:00:00Z", workingTime: 7200, examMaxPoints: 40, testExam: false },
        { id: 2, title: "Later", visibleDate: "2999-01-01T00:00:00Z", startDate: "2999-01-02T00:00:00Z", endDate: "2999-01-02T02:00:00Z", workingTime: 1, examMaxPoints: 1, testExam: false },
      ]),
  ]);
  const visible = await listExams(state, 7, exams.fetchImpl, Date.parse("2026-06-01T00:00:00Z"));
  assert.deepEqual(visible.map((exam) => exam.id), [1]);
});

test("an unpublished exam summary is not released", async () => {
  const script = scriptedFetch([() => new Response(null, { status: 403 })]);
  await assert.rejects(
    () => getExamResult(env(), 7, 1, 2, script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_released",
  );
});
