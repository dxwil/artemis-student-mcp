import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { submitFile, submitQuiz, submitText } from "../src/submissions.js";
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

function exercise(extra) {
  return {
    id: 3,
    type: "text",
    title: "Essay",
    course: { id: 7, title: "Introduction to Informatics" },
    releaseDate: "2020-01-01T00:00:00Z",
    dueDate: "2099-01-01T00:00:00Z",
    visibleToStudents: true,
    ...extra,
  };
}

test("a text submission is previewed with its due date and sent once", async () => {
  const state = env();
  let sentBody;
  const script = scriptedFetch([
    () => jsonResponse(200, exercise()),
    () => jsonResponse(200, { exercises: [{ id: 3, studentParticipations: [] }] }),
    () => jsonResponse(200, exercise()),
    () => jsonResponse(200, { exercises: [{ id: 3, studentParticipations: [] }] }),
    (_url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonResponse(200, { id: 20, text: "Answer", submitted: true });
    },
  ]);
  const preview = await submitText(state, 3, "Answer", "ENGLISH", undefined, script.fetchImpl, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(script.calls.every((call) => call.method === "GET"), true);
  assert.equal(preview.preview.exerciseTitle, "Essay");
  assert.equal(preview.preview.dueDate, "2099-01-01T00:00:00Z");
  const sent = await submitText(state, 3, "Answer", "ENGLISH", preview.confirmationToken, script.fetchImpl, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(sent.submissionId, 20);
  assert.deepEqual(sentBody, { text: "Answer", submitted: true, language: "ENGLISH" });
  assert.equal(script.calls.filter((call) => call.method === "POST").length, 1);
});

test("a passed due date and the excluded exercise types are not submitted", async () => {
  const late = scriptedFetch([
    () => jsonResponse(200, exercise({ dueDate: "2020-01-02T00:00:00Z" })),
    () => jsonResponse(200, { exercises: [{ id: 3, studentParticipations: [] }] }),
  ]);
  await assert.rejects(
    () => submitText(env(), 3, "Answer", undefined, undefined, late.fetchImpl, Date.parse("2026-01-01T00:00:00Z")),
    (error) => error instanceof SafeError && error.code === "deadline_passed",
  );
  assert.equal(late.calls.every((call) => call.method === "GET"), true);
  const programming = scriptedFetch([() => jsonResponse(200, exercise({ type: "programming" }))]);
  await assert.rejects(
    () => submitText(env(), 3, "Answer", undefined, undefined, programming.fetchImpl),
    (error) => error instanceof SafeError && error.code === "unsupported_exercise",
  );
  const modeling = scriptedFetch([() => jsonResponse(200, exercise({ type: "modeling" }))]);
  await assert.rejects(() => submitText(env(), 3, "Answer", undefined, undefined, modeling.fetchImpl), (error) => error.code === "unsupported_exercise");
  const exam = scriptedFetch([() => jsonResponse(200, exercise({ exerciseGroup: { id: 1 } }))]);
  await assert.rejects(() => submitText(env(), 3, "Answer", undefined, undefined, exam.fetchImpl), (error) => error.code === "exam_exercise");
});

test("a file upload refuses a symlink and sends one multipart request", async () => {
  const directory = tempDir();
  const file = path.join(directory, "notes.pdf");
  fs.writeFileSync(file, "pdf");
  const link = path.join(directory, "link.pdf");
  fs.symlinkSync(file, link);
  const state = env();
  const blocked = scriptedFetch([
    () => jsonResponse(200, exercise({ type: "file-upload", filePattern: "pdf" })),
    () => jsonResponse(200, { exercises: [] }),
  ]);
  await assert.rejects(
    () => submitFile(state, 3, link, undefined, blocked.fetchImpl, Date.parse("2026-01-01T00:00:00Z")),
    (error) => error instanceof SafeError && error.code === "invalid_arguments",
  );
  assert.equal(blocked.calls.every((call) => call.method === "GET"), true);
  let form;
  const script = scriptedFetch([
    () => jsonResponse(200, exercise({ type: "file-upload", filePattern: "pdf" })),
    () => jsonResponse(200, { exercises: [{ id: 3, studentParticipations: [] }] }),
    () => jsonResponse(200, exercise({ type: "file-upload", filePattern: "pdf" })),
    () => jsonResponse(200, { exercises: [{ id: 3, studentParticipations: [] }] }),
    (_url, init) => {
      form = init.body;
      return jsonResponse(200, { id: 21, filePath: "/secret/notes.pdf" });
    },
  ]);
  const preview = await submitFile(state, 3, file, undefined, script.fetchImpl, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(preview.preview.fileName, "notes.pdf");
  assert.equal(preview.preview.bytes, 3);
  const sent = await submitFile(state, 3, file, preview.confirmationToken, script.fetchImpl, Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(sent.submissionId, 21);
  assert.equal(JSON.stringify(sent).includes("/secret"), false);
  assert.equal(form instanceof FormData, true);
  assert.equal(script.calls.filter((call) => call.method === "POST").length, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a closed quiz is refused and an open quiz is submitted once in live mode", async () => {
  const closed = scriptedFetch([
    () => jsonResponse(200, exercise({ type: "quiz" })),
    () => jsonResponse(200, { id: 3, title: "Quiz", quizQuestionsType: "before-quiz-start", course: { id: 7, title: "Introduction to Informatics" } }),
  ]);
  await assert.rejects(
    () => submitQuiz(env(), 3, [{ type: "multiple-choice", questionId: 1, selectedOptionIds: [2] }], undefined, closed.fetchImpl),
    (error) => error instanceof SafeError && error.code === "quiz_not_open",
  );
  assert.equal(closed.calls.every((call) => call.method === "GET"), true);
  let sentBody;
  let sentUrl;
  const open = scriptedFetch([
    () => jsonResponse(200, exercise({ type: "quiz", dueDate: "2099-01-01T00:00:00Z" })),
    () => jsonResponse(200, { id: 3, title: "Quiz", quizQuestionsType: "live-quiz", dueDate: "2099-01-01T00:00:00Z", course: { title: "Introduction to Informatics" } }),
    () => jsonResponse(200, exercise({ type: "quiz", dueDate: "2099-01-01T00:00:00Z" })),
    () => jsonResponse(200, { id: 3, title: "Quiz", quizQuestionsType: "live-quiz", dueDate: "2099-01-01T00:00:00Z", course: { title: "Introduction to Informatics" } }),
    (url, init) => {
      sentUrl = url;
      sentBody = JSON.parse(init.body);
      return jsonResponse(200, { id: 30, submitted: true });
    },
  ]);
  const state = env();
  const answers = [{ type: "multiple-choice", questionId: 1, selectedOptionIds: [2] }];
  const preview = await submitQuiz(state, 3, answers, undefined, open.fetchImpl);
  assert.equal(preview.preview.mode, "live");
  const sent = await submitQuiz(state, 3, answers, preview.confirmationToken, open.fetchImpl);
  assert.equal(sent.mode, "live");
  assert.equal(sentUrl.pathname, "/api/quiz/exercises/3/submissions/live");
  assert.equal(sentUrl.searchParams.get("submit"), "true");
  assert.equal(sentBody.submittedAnswers[0].type, "multiple-choice");
  assert.deepEqual(sentBody.submittedAnswers[0].quizQuestion, { id: 1 });
  assert.equal(open.calls.filter((call) => call.method === "POST").length, 1);
});

test("a quiz that has ended is sent to practice mode", async () => {
  const state = env();
  let sentUrl;
  let sentBody;
  const script = scriptedFetch([
    () => jsonResponse(200, exercise({ type: "quiz", dueDate: "2020-01-02T00:00:00Z" })),
    () => jsonResponse(200, { id: 3, title: "Quiz", quizQuestionsType: "after-quiz-end", dueDate: "2020-01-02T00:00:00Z", course: { title: "Introduction to Informatics" } }),
    () => jsonResponse(200, exercise({ type: "quiz", dueDate: "2020-01-02T00:00:00Z" })),
    () => jsonResponse(200, { id: 3, title: "Quiz", quizQuestionsType: "after-quiz-end", dueDate: "2020-01-02T00:00:00Z", course: { title: "Introduction to Informatics" } }),
    (url, init) => {
      sentUrl = url;
      sentBody = JSON.parse(init.body);
      return jsonResponse(200, { id: 9, score: 50, submission: { id: 40, quizQuestions: [{ correct: true }] } });
    },
  ]);
  const answers = [{ type: "short-answer", questionId: 8, texts: [{ text: "loop", spotId: 9 }] }];
  const preview = await submitQuiz(state, 3, answers, undefined, script.fetchImpl);
  assert.equal(preview.preview.mode, "practice");
  const sent = await submitQuiz(state, 3, answers, preview.confirmationToken, script.fetchImpl);
  assert.equal(sentUrl.pathname, "/api/quiz/exercises/3/submissions/practice");
  assert.equal(sentBody.submittedAnswers[0].questionId, 8);
  assert.equal(sent.score, 50);
  assert.equal(sent.submissionId, 40);
  assert.equal(JSON.stringify(sent).includes("correct"), false);
  assert.equal(script.calls.filter((call) => call.method === "POST").length, 1);
});
