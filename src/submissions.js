import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { studentGet, studentSend } from "./auth.js";
import { gateWrite } from "./confirm.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { requireId } from "./student-reads.js";

const TEXT_LIMIT = 30_000;
const FILE_LIMIT = 8 * 1024 * 1024;
const SHORT_ANSWER_LIMIT = 255;

export async function submitText(env, exerciseId, text, language, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const exercise = await loadCourseExercise(env, exerciseId, fetchImpl, nowMs);
  requireType(exercise, "text");
  const facts = await participationFacts(env, exercise, fetchImpl, nowMs);
  const dueDate = assertSubmissionWindow(exercise, facts.individualDueDate, nowMs);
  const bodyText = requireText(text);
  const body = { text: bodyText, submitted: true };
  if (facts.submissionId) {
    body.id = facts.submissionId;
  }
  if (language != null) {
    body.language = requireLanguage(language);
  }
  const fields = requestFields(facts.submissionId ? "PUT" : "POST", `/api/text/exercises/${exercise.id}/text-submissions`, body, exercise, dueDate);
  const gate = gateWrite(env, "submit_text", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return { preview: textPreview(exercise, dueDate, bodyText, facts.submissionId, body.language ?? null), ...gateFields(gate) };
  }
  const saved = await studentSend(env, fields.path, { method: fields.method, json: body }, fetchImpl, nowMs);
  return { submissionId: savedId(saved), exerciseId: exercise.id, submitted: true };
}

export async function submitFile(env, exerciseId, filePath, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const exercise = await loadCourseExercise(env, exerciseId, fetchImpl, nowMs);
  requireType(exercise, "file-upload");
  const facts = await participationFacts(env, exercise, fetchImpl, nowMs);
  const dueDate = assertSubmissionWindow(exercise, facts.individualDueDate, nowMs);
  const file = readUpload(filePath, exercise.filePattern);
  const submission = { submitted: true, exerciseId: exercise.id };
  if (facts.submissionId) {
    submission.id = facts.submissionId;
  }
  const fields = {
    method: "POST",
    path: `/api/fileupload/exercises/${exercise.id}/file-upload-submissions`,
    submission,
    fileName: file.name,
    bytes: file.bytes.length,
    sha256: file.sha256,
    exerciseTitle: exercise.title,
    courseTitle: exercise.courseTitle,
    dueDate,
  };
  const gate = gateWrite(env, "submit_file", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return {
      preview: {
        action: "submit_file",
        exerciseId: exercise.id,
        exerciseTitle: exercise.title,
        courseTitle: exercise.courseTitle,
        dueDate,
        fileName: file.name,
        bytes: file.bytes.length,
        filePattern: exercise.filePattern,
        replacesSubmissionId: facts.submissionId,
        method: "POST",
        path: fields.path,
      },
      ...gateFields(gate),
    };
  }
  const form = new FormData();
  form.append("submission", new Blob([JSON.stringify(submission)], { type: "application/json" }), "submission.json");
  form.append("file", new Blob([file.bytes]), file.name);
  const saved = await studentSend(env, fields.path, { method: "POST", form }, fetchImpl, nowMs);
  return { submissionId: savedId(saved), exerciseId: exercise.id, submitted: true };
}

export async function submitQuiz(env, exerciseId, answers, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const exercise = await loadCourseExercise(env, exerciseId, fetchImpl, nowMs);
  requireType(exercise, "quiz");
  const normalized = normalizeAnswers(answers);
  const quiz = await studentGet(env, `/api/quiz/quiz-exercises/${exercise.id}/for-student`, fetchImpl, nowMs);
  const mode = quizMode(quiz);
  const request = mode === "live" ? liveRequest(exercise.id, normalized) : practiceRequest(exercise.id, normalized);
  const fields = {
    ...request,
    exerciseTitle: typeof quiz.title === "string" ? quiz.title : exercise.title,
    courseTitle: quiz.course && typeof quiz.course.title === "string" ? quiz.course.title : exercise.courseTitle,
    dueDate: normalizeDate(quiz.dueDate) ?? exercise.dueDate,
    answers: normalized,
  };
  const gate = gateWrite(env, "submit_quiz", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return {
      preview: {
        action: "submit_quiz",
        mode,
        exerciseId: exercise.id,
        exerciseTitle: fields.exerciseTitle,
        courseTitle: fields.courseTitle,
        dueDate: fields.dueDate,
        answers: normalized,
        method: request.method,
        path: request.path,
        query: request.query ?? null,
      },
      ...gateFields(gate),
    };
  }
  const saved = await studentSend(env, request.path, { method: "POST", json: request.body, query: request.query }, fetchImpl, nowMs);
  if (mode === "live") {
    return { submissionId: savedId(saved), exerciseId: exercise.id, mode, submitted: saved?.submitted === true };
  }
  return {
    submissionId: saved && typeof saved.submission?.id === "number" ? saved.submission.id : null,
    exerciseId: exercise.id,
    mode,
    score: saved && typeof saved.score === "number" ? saved.score : null,
  };
}

async function loadCourseExercise(env, exerciseId, fetchImpl, nowMs) {
  const id = requireId(exerciseId);
  const payload = await studentGet(env, `/api/exercise/exercises/${id}`, fetchImpl, nowMs);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  if (payload.exerciseGroup) {
    throw new SafeError("exam_exercise", "Exam exercises are not submitted by these tools.");
  }
  const releaseDate = normalizeDate(payload.releaseDate);
  if (payload.visibleToStudents === false || (releaseDate && Date.parse(releaseDate) > nowMs)) {
    throw new SafeError("not_released", "This exercise is not visible to students.");
  }
  return {
    id,
    type: typeof payload.type === "string" ? payload.type : "",
    title: typeof payload.title === "string" ? payload.title : "",
    courseId: typeof payload.course?.id === "number" ? payload.course.id : null,
    courseTitle: typeof payload.course?.title === "string" ? payload.course.title : null,
    releaseDate,
    startDate: normalizeDate(payload.startDate),
    dueDate: normalizeDate(payload.dueDate),
    filePattern: typeof payload.filePattern === "string" ? payload.filePattern : null,
  };
}

function requireType(exercise, expected) {
  if (exercise.type === "programming") {
    throw new SafeError("unsupported_exercise", "Programming submissions use Git and are not sent by this plugin.");
  }
  if (exercise.type === "modeling") {
    throw new SafeError("unsupported_exercise", "Modeling submissions are a diagram document and are not sent by this plugin.");
  }
  if (exercise.type !== expected) {
    throw new SafeError("unsupported_exercise", "This submission tool does not handle that exercise type.");
  }
}

async function participationFacts(env, exercise, fetchImpl, nowMs) {
  if (!exercise.courseId) {
    return { submissionId: null, individualDueDate: null };
  }
  const payload = await studentGet(env, `/api/course/courses/${exercise.courseId}/exercises-for-overview`, fetchImpl, nowMs);
  const match = Array.isArray(payload?.exercises) ? payload.exercises.find((entry) => entry && entry.id === exercise.id) : null;
  let submissionId = null;
  let individualDueDate = null;
  for (const participation of match?.studentParticipations ?? []) {
    const ownDue = normalizeDate(participation?.individualDueDate);
    if (ownDue) {
      individualDueDate = ownDue;
    }
    for (const submission of participation?.submissions ?? []) {
      if (typeof submission?.id === "number" && (submissionId == null || submission.id > submissionId)) {
        submissionId = submission.id;
      }
    }
  }
  return { submissionId, individualDueDate };
}

function assertSubmissionWindow(exercise, individualDueDate, nowMs) {
  if (exercise.startDate && Date.parse(exercise.startDate) > nowMs) {
    throw new SafeError("not_open", "This exercise has not started.");
  }
  const dueDate = individualDueDate ?? exercise.dueDate;
  if (dueDate && Date.parse(dueDate) <= nowMs) {
    throw new SafeError("deadline_passed", `The due date ${dueDate} has passed.`);
  }
  return dueDate;
}

function requireText(text) {
  if (typeof text !== "string" || text.trim() === "" || text.length > TEXT_LIMIT) {
    throw new SafeError("invalid_arguments", "Text submissions must be 1 to 30000 characters.");
  }
  return text;
}

function requireLanguage(language) {
  if (language !== "ENGLISH" && language !== "GERMAN") {
    throw new SafeError("invalid_arguments", "language must be ENGLISH or GERMAN.");
  }
  return language;
}

function requestFields(method, requestPath, body, exercise, dueDate) {
  return { method, path: requestPath, body, exerciseTitle: exercise.title, courseTitle: exercise.courseTitle, dueDate };
}

function textPreview(exercise, dueDate, text, submissionId, language) {
  return {
    action: "submit_text",
    exerciseId: exercise.id,
    exerciseTitle: exercise.title,
    courseTitle: exercise.courseTitle,
    dueDate,
    characters: text.length,
    language,
    replacesSubmissionId: submissionId,
    method: submissionId ? "PUT" : "POST",
    path: `/api/text/exercises/${exercise.id}/text-submissions`,
  };
}

function readUpload(filePath, filePattern) {
  if (typeof filePath !== "string" || filePath.includes("\0")) {
    throw new SafeError("invalid_arguments", "The upload path is not a local file.");
  }
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new SafeError("invalid_arguments", "The upload path is not a local file.");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SafeError("invalid_arguments", "The upload path must be a regular file, not a link.");
  }
  if (stat.size < 1 || stat.size > FILE_LIMIT) {
    throw new SafeError("payload_too_large", "The file must be between 1 byte and 8 MB.");
  }
  const suffix = path.extname(resolved).slice(1).toLowerCase();
  if (filePattern) {
    const allowed = filePattern.toLowerCase().replace(/\s/g, "").split(",").filter(Boolean);
    if (!allowed.includes(suffix)) {
      throw new SafeError("invalid_arguments", "The file ending is not in the exercise file pattern.");
    }
  }
  const name = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_");
  if (name === "" || name.length > 120) {
    throw new SafeError("invalid_arguments", "The upload name is not a safe filename.");
  }
  const bytes = fs.readFileSync(resolved);
  return { bytes, name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function quizMode(quiz) {
  if (!quiz || typeof quiz !== "object") {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  if (quiz.quizQuestionsType === "before-quiz-start") {
    throw new SafeError("quiz_not_open", "The quiz is not open for this student.");
  }
  if (quiz.quizQuestionsType === "live-quiz") {
    return "live";
  }
  if (quiz.quizQuestionsType === "after-quiz-end") {
    return "practice";
  }
  throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
}

function normalizeAnswers(answers) {
  if (!Array.isArray(answers) || answers.length > 50) {
    throw new SafeError("invalid_arguments", "answers must be an array of at most 50 answers.");
  }
  return answers.map((answer) => {
    if (!answer || typeof answer !== "object") {
      throw new SafeError("invalid_arguments", "Each quiz answer needs a type and questionId.");
    }
    const questionId = requireId(answer.questionId);
    if (answer.type === "multiple-choice") {
      return { type: "multiple-choice", questionId, selectedOptionIds: idList(answer.selectedOptionIds) };
    }
    if (answer.type === "drag-and-drop") {
      if (!Array.isArray(answer.mappings) || answer.mappings.length > 50) {
        throw new SafeError("invalid_arguments", "A drag-and-drop answer needs mappings.");
      }
      const mappings = answer.mappings.map((mapping) => ({
        dragItemId: requireId(mapping?.dragItemId),
        dropLocationId: requireId(mapping?.dropLocationId),
      }));
      mappings.sort((left, right) => left.dragItemId - right.dragItemId || left.dropLocationId - right.dropLocationId);
      return { type: "drag-and-drop", questionId, mappings };
    }
    if (answer.type === "short-answer") {
      if (!Array.isArray(answer.texts) || answer.texts.length > 50) {
        throw new SafeError("invalid_arguments", "A short answer needs texts.");
      }
      const texts = answer.texts.map((entry) => {
        if (typeof entry?.text !== "string" || entry.text.length < 1 || entry.text.length > SHORT_ANSWER_LIMIT) {
          throw new SafeError("invalid_arguments", "Short-answer text must be 1 to 255 characters.");
        }
        return { text: entry.text, spotId: requireId(entry.spotId) };
      });
      texts.sort((left, right) => left.spotId - right.spotId);
      return { type: "short-answer", questionId, texts };
    }
    throw new SafeError("invalid_arguments", "Quiz answer type must be multiple-choice, drag-and-drop, or short-answer.");
  });
}

function idList(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new SafeError("invalid_arguments", "selectedOptionIds must be an array of ids.");
  }
  return value.map((item) => requireId(item)).sort((left, right) => left - right);
}

function liveRequest(exerciseId, answers) {
  return {
    method: "POST",
    path: `/api/quiz/exercises/${exerciseId}/submissions/live`,
    query: { submit: "true" },
    body: { submittedAnswers: answers.map(liveAnswer) },
  };
}

function practiceRequest(exerciseId, answers) {
  return {
    method: "POST",
    path: `/api/quiz/exercises/${exerciseId}/submissions/practice`,
    body: { submittedAnswers: answers.map(practiceAnswer) },
  };
}

function liveAnswer(answer) {
  if (answer.type === "multiple-choice") {
    return { type: "multiple-choice", quizQuestion: { id: answer.questionId }, selectedOptions: answer.selectedOptionIds.map((id) => ({ id })) };
  }
  if (answer.type === "drag-and-drop") {
    return {
      type: "drag-and-drop",
      quizQuestion: { id: answer.questionId },
      mappings: answer.mappings.map((mapping) => ({ dragItem: { id: mapping.dragItemId }, dropLocation: { id: mapping.dropLocationId } })),
    };
  }
  return {
    type: "short-answer",
    quizQuestion: { id: answer.questionId },
    submittedTexts: answer.texts.map((entry) => ({ text: entry.text, spot: { id: entry.spotId } })),
  };
}

function practiceAnswer(answer) {
  if (answer.type === "multiple-choice") {
    return { type: "multiple-choice", questionId: answer.questionId, selectedOptions: answer.selectedOptionIds };
  }
  if (answer.type === "drag-and-drop") {
    return { type: "drag-and-drop", questionId: answer.questionId, mappings: answer.mappings };
  }
  return { type: "short-answer", questionId: answer.questionId, submittedTexts: answer.texts };
}

function gateFields(gate) {
  return { confirmationToken: gate.confirmationToken, expiresAt: gate.expiresAt };
}

function savedId(payload) {
  if (!payload || typeof payload.id !== "number") {
    throw new SafeError("malformed", "Artemis accepted the write but did not return an id.");
  }
  return payload.id;
}
