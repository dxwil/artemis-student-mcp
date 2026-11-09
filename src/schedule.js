import { studentGet } from "./auth.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { requireId } from "./student-reads.js";

const MALFORMED = "Artemis returned a response that does not match the student read shape.";

export async function listCalendar(env, courseId, month, timeZone, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const monthKey = requireMonth(month);
  const zone = timeZone == null || timeZone === "" ? "UTC" : requireZone(timeZone);
  const payload = await studentGet(env, `/api/calendar/courses/${id}/calendar-events`, fetchImpl, nowMs, {
    notEnabledOn404: true,
    query: { monthKeys: monthKey, timeZone: zone, language: "ENGLISH" },
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  const events = [];
  for (const [day, items] of Object.entries(payload)) {
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (!item || typeof item.title !== "string") {
        continue;
      }
      events.push({
        courseId: id,
        day,
        type: typeof item.type === "string" ? item.type : null,
        title: item.title.slice(0, 300),
        startDate: normalizeDate(item.startDate),
        endDate: normalizeDate(item.endDate),
        location: typeof item.location === "string" ? item.location.slice(0, 200) : null,
      });
    }
  }
  return events.slice(0, 200);
}

export async function listExams(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/exam/courses/${id}/exams-for-overview`, fetchImpl, nowMs, { notEnabledOn404: true });
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return payload
    .filter((exam) => exam && isVisible(exam.visibleDate, nowMs))
    .map((exam) => ({
      id: requirePayloadId(exam.id),
      courseId: id,
      title: typeof exam.title === "string" ? exam.title : "",
      moduleNumber: typeof exam.moduleNumber === "string" ? exam.moduleNumber : null,
      visibleDate: normalizeDate(exam.visibleDate),
      startDate: normalizeDate(exam.startDate),
      endDate: normalizeDate(exam.endDate),
      workingTimeSeconds: typeof exam.workingTime === "number" ? exam.workingTime : null,
      maxPoints: typeof exam.examMaxPoints === "number" ? exam.examMaxPoints : null,
      testExam: exam.testExam === true,
    }))
    .filter((exam) => exam.title !== "");
}

export async function getExamResult(env, courseId, examId, studentExamId, fetchImpl, nowMs = Date.now()) {
  const course = requireId(courseId);
  const exam = requireId(examId);
  const studentExam = requireId(studentExamId);
  let payload;
  try {
    payload = await studentGet(
      env,
      `/api/exam/courses/${course}/exams/${exam}/student-exams/${studentExam}/grade-summary`,
      fetchImpl,
      nowMs,
    );
  } catch (error) {
    if (error instanceof SafeError && error.code === "forbidden") {
      throw new SafeError("not_released", "The exam result is not released for this student session.");
    }
    throw error;
  }
  if (!payload || typeof payload !== "object") {
    throw new SafeError("malformed", MALFORMED);
  }
  const score = payload.studentResult && typeof payload.studentResult.score === "number" ? payload.studentResult.score : null;
  return {
    courseId: course,
    examId: exam,
    studentExamId: studentExam,
    grade: typeof payload.grade === "string" ? payload.grade : null,
    score,
  };
}

function isVisible(visibleDate, nowMs) {
  if (visibleDate == null) {
    return true;
  }
  const normalized = normalizeDate(visibleDate);
  return normalized == null || Date.parse(normalized) <= nowMs;
}

function requireMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new SafeError("invalid_arguments", "month must be YYYY-MM.");
  }
  return value;
}

function requireZone(value) {
  if (typeof value !== "string" || value.length > 64 || value.includes("..") || !/^[-A-Za-z0-9_+/]+$/.test(value)) {
    throw new SafeError("invalid_arguments", "timeZone must be an IANA name such as UTC.");
  }
  return value;
}

function requirePayloadId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value;
}
