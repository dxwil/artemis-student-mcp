import { SafeError } from "./errors.js";

const ISO_DATE =
  /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2})(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2}))?$/;

/**
 * Project the student dashboard payload down to CourseSummary.
 * id, title, and shortName are required. startDate and endDate are nullable
 * because CourseDashboardDTO marks them @Nullable and Jackson omits nulls.
 * Every other field, including scores, exercises, and exams, is dropped.
 * @param {unknown} payload
 */
export function normalizeDashboard(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.courses)) {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  const courses = payload.courses.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
    }
    const course = entry.course;
    if (!course || typeof course !== "object" || Array.isArray(course)) {
      throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
    }
    return normalizeCourse(course);
  });
  courses.sort((left, right) => left.id - right.id);
  const ids = new Set(courses.map((course) => course.id));
  if (ids.size !== courses.length) {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  return courses;
}

function normalizeCourse(course) {
  if (typeof course.id !== "number" || !Number.isSafeInteger(course.id) || course.id < 1) {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  if (!isPresentText(course.title, 2000) || !isPresentText(course.shortName, 200)) {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  return {
    id: course.id,
    title: course.title,
    shortName: course.shortName,
    startDate: normalizeDate(course.startDate),
    endDate: normalizeDate(course.endDate),
  };
}

function isPresentText(value, max) {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

export function normalizeDate(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  return value;
}
