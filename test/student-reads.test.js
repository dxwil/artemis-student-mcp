import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SafeError } from "../src/errors.js";
import { getExercise, getLecture, listExercises, listLectures } from "../src/student-reads.js";
import { fakeJwt, jsonResponse, scriptedFetch, tempDir } from "./support.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");

function env(directory) {
  const token = fakeJwt(4_102_444_800);
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }),
    { mode: 0o600 },
  );
  return {
    ARTEMIS_BASE_URL: "https://artemis.test",
    PLUGIN_DATA: directory,
    PLUGIN_ROOT: path.resolve("."),
    token,
  };
}

test("exercise list keeps deadlines, drops grades and unreleased rows", async () => {
  const { normalizeExerciseList } = await import("../src/student-reads.js");
  const exercises = normalizeExerciseList(
    {
      exercises: [
        {
          id: 3,
          type: "TEXT",
          title: "Essay",
          releaseDate: "2020-01-01T00:00:00Z",
          dueDate: "2020-02-01T00:00:00Z",
          studentParticipations: [{ results: [{ score: 99 }] }],
          exampleSolution: "SECRET_SOLUTION",
        },
        { id: 8, type: "programming", title: "Later", releaseDate: "2999-01-01T00:00:00Z" },
        { id: 4, type: "QUIZ", title: "Quiz", dueDate: "2026-12-01T00:00:00+01:00" },
      ],
      totalScores: { relativeScore: "GRADE_MARKER" },
    },
    7,
    NOW,
  );
  assert.deepEqual(exercises, [
    {
      id: 3,
      courseId: 7,
      type: "text",
      title: "Essay",
      releaseDate: "2020-01-01T00:00:00Z",
      startDate: null,
      dueDate: "2020-02-01T00:00:00Z",
    },
    {
      id: 4,
      courseId: 7,
      type: "quiz",
      title: "Quiz",
      releaseDate: null,
      startDate: null,
      dueDate: "2026-12-01T00:00:00+01:00",
    },
  ]);
  assert.equal(JSON.stringify(exercises).includes("SECRET_SOLUTION"), false);
  assert.equal(JSON.stringify(exercises).includes("GRADE_MARKER"), false);
});

test("exercise detail keeps the statement and drops solutions", async () => {
  const { normalizeExerciseDetail } = await import("../src/student-reads.js");
  const detail = normalizeExerciseDetail(
    {
      id: 11,
      type: "programming",
      title: "Hello",
      visibleToStudents: true,
      releaseDate: "2020-01-01T00:00:00Z",
      dueDate: null,
      problemStatement: "Print hello",
      exampleSolution: "SECRET_SOLUTION",
      testRepositoryUri: "https://secret.example/tests",
      gradingInstructions: "hidden rubric",
      course: { id: 7 },
    },
    7,
    NOW,
  );
  assert.equal(detail.problemStatement, "Print hello");
  assert.equal(detail.dueDate, null);
  assert.equal(JSON.stringify(detail).includes("SECRET_SOLUTION"), false);
  assert.equal(JSON.stringify(detail).includes("hidden rubric"), false);
  assert.throws(
    () => normalizeExerciseDetail({ id: 12, type: "text", title: "Hidden", visibleToStudents: false, problemStatement: "nope" }, null, NOW),
    (error) => error instanceof SafeError && error.code === "not_released",
  );
  assert.throws(
    () => normalizeExerciseDetail({ id: 13, type: "text", title: "Other", visibleToStudents: true, course: { id: 9 } }, 7, NOW),
    (error) => error instanceof SafeError && error.code === "forbidden",
  );
});

test("lecture materials keep safe references and omit hidden units", async () => {
  const { normalizeLectureDetail } = await import("../src/student-reads.js");
  const lecture = normalizeLectureDetail(
    {
      id: 4,
      title: "Week 1",
      isTutorialLecture: false,
      course: { id: 7 },
      lectureUnits: [
        {
          id: 1,
          type: "attachment",
          name: "Slides",
          visibleToStudents: true,
          attachment: {
            id: 21,
            name: "Slides",
            link: "attachments/attachment-video-units/1/slides.pdf",
            attachmentType: "FILE",
            version: 2,
            studentVersion: "attachments/attachment-video-units/1/student/slides.pdf",
          },
        },
        { id: 2, type: "online", name: "Video", visibleToStudents: true, source: "https://cdn.example/video" },
        { id: 3, type: "text", name: "Notes", visibleToStudents: true, content: "Read this" },
        { id: 5, type: "exercise", name: "Task", visibleToStudents: true, exercise: { id: 11, type: "TEXT", title: "Essay", studentParticipations: [{ score: 1 }] } },
        { id: 6, type: "attachment", name: "Draft", visibleToStudents: false, attachment: { id: 22, link: "attachments/attachment-video-units/6/draft.pdf" } },
      ],
      attachments: [
        { id: 30, name: "Syllabus", link: "attachments/lectures/4/syllabus.pdf", attachmentType: "FILE", releaseDate: "2020-01-01T00:00:00Z" },
        { id: 31, name: "Later", link: "attachments/lectures/4/later.pdf", releaseDate: "2999-01-01T00:00:00Z" },
      ],
    },
    7,
    "https://artemis.test",
  );
  assert.equal(lecture.materials.length, 5);
  assert.equal(lecture.materials[0].path, "/api/core/files/attachments/attachment-video-units/1/student/slides.pdf");
  assert.equal(lecture.materials[0].attachmentId, 21);
  assert.equal(lecture.materials[0].filename, "slides.pdf");
  assert.equal(lecture.materials[0].attachmentType, "FILE");
  assert.equal(lecture.materials[0].version, 2);
  assert.equal(lecture.materials[1].url, "https://cdn.example/video");
  assert.equal(lecture.materials[2].text, "Read this");
  assert.equal(lecture.materials[3].exerciseId, 11);
  assert.equal(lecture.materials[4].kind, "lecture-attachment");
  assert.equal(lecture.materials[4].path, "/api/core/files/attachments/lectures/4/syllabus.pdf");
  assert.equal(JSON.stringify(lecture).includes("draft.pdf"), false);
  assert.equal(JSON.stringify(lecture).includes("later.pdf"), false);
  assert.equal(JSON.stringify(lecture).includes("score"), false);
});

test("student reads use GET and surface 403 and 404 without the response body", async () => {
  const directory = tempDir();
  const state = env(directory);
  const forbidden = scriptedFetch([() => new Response("SECRET_BODY", { status: 403 })]);
  await assert.rejects(
    () => listExercises(state, 7, forbidden.fetchImpl, NOW),
    (error) => error instanceof SafeError && error.code === "forbidden" && !error.message.includes("SECRET_BODY"),
  );
  assert.equal(forbidden.calls[0].method, "GET");
  assert.equal(new URL(forbidden.calls[0].href).pathname, "/api/course/courses/7/exercises-for-overview");

  const missing = scriptedFetch([() => new Response(null, { status: 404 })]);
  await assert.rejects(() => getExercise(state, 11, null, missing.fetchImpl, NOW), (error) => error instanceof SafeError && error.code === "not_found");
  assert.equal(missing.calls[0].method, "GET");

  const unused = scriptedFetch([]);
  await assert.rejects(() => listLectures(state, 0, unused.fetchImpl, NOW), (error) => error instanceof SafeError && error.code === "invalid_arguments");
  assert.equal(unused.calls.length, 0);

  const ok = scriptedFetch([
    () =>
      jsonResponse(200, {
        exercises: [{ id: 3, type: "TEXT", title: "Essay", releaseDate: "2020-01-01T00:00:00Z", dueDate: "2020-02-01T00:00:00Z" }],
        totalScores: { relativeScore: 1 },
      }),
  ]);
  const exercises = await listExercises(state, 7, ok.fetchImpl, NOW);
  assert.equal(exercises.length, 1);
  assert.equal(JSON.stringify(exercises).includes("relativeScore"), false);
  assert.equal(ok.calls.every((call) => call.method === "GET"), true);
});
