import { studentGet } from "./auth.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { normalizeOrigin } from "./origin.js";
import { resolveConfiguredOrigin } from "./profiles.js";

const TYPES = new Set(["programming", "quiz", "modeling", "text", "file-upload"]);
const ENUM_TYPE = {
  PROGRAMMING: "programming",
  QUIZ: "quiz",
  MODELING: "modeling",
  TEXT: "text",
  FILE_UPLOAD: "file-upload",
};
const TEXT_LIMIT = 100_000;
const MALFORMED = "Artemis returned a response that does not match the student read shape.";

export async function listExercises(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/course/courses/${id}/exercises-for-overview`, fetchImpl, nowMs);
  return normalizeExerciseList(payload, id, nowMs);
}

export async function getExercise(env, exerciseId, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(exerciseId);
  const scopedCourse = courseId == null ? null : requireId(courseId);
  const payload = await studentGet(env, `/api/exercise/exercises/${id}`, fetchImpl, nowMs);
  return normalizeExerciseDetail(payload, scopedCourse, nowMs);
}

export async function listLectures(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/lecture/courses/${id}/lectures-for-overview`, fetchImpl, nowMs);
  return normalizeLectureList(payload, id);
}

export async function getLecture(env, lectureId, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(lectureId);
  const scopedCourse = courseId == null ? null : requireId(courseId);
  const payload = await studentGet(env, `/api/lecture/lectures/${id}/details`, fetchImpl, nowMs);
  const origin = normalizeOrigin(resolveConfiguredOrigin(env));
  return normalizeLectureDetail(payload, scopedCourse, origin);
}

export function requireId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SafeError("invalid_arguments", "An id must be a positive integer.");
  }
  return value;
}

export function normalizeExerciseList(payload, courseId, nowMs) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.exercises)) {
    throw new SafeError("malformed", MALFORMED);
  }
  const exercises = payload.exercises
    .map((entry) => normalizeExerciseSummary(entry, courseId))
    .filter((exercise) => isReleased(exercise.releaseDate, nowMs));
  return sortById(exercises);
}

export function normalizeExerciseDetail(payload, courseId, nowMs) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  if (payload.exerciseGroup) {
    throw new SafeError("forbidden", "Exam exercises are not available through this student read.");
  }
  if (payload.visibleToStudents === false || !isReleased(normalizeDate(payload.releaseDate), nowMs)) {
    throw new SafeError("not_released", "This exercise is not visible to students.");
  }
  const course = courseObject(payload.course);
  if (courseId != null && course != null && course !== courseId) {
    throw new SafeError("forbidden", "The exercise is not in the requested course.");
  }
  return {
    id: requirePayloadId(payload.id),
    courseId: course ?? courseId,
    type: exerciseType(payload),
    title: requireTitle(payload.title),
    releaseDate: normalizeDate(payload.releaseDate),
    startDate: normalizeDate(payload.startDate),
    dueDate: normalizeDate(payload.dueDate),
    problemStatement: optionalText(payload.problemStatement),
  };
}

export function normalizeLectureList(payload, courseId) {
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return sortById(payload.map((entry) => normalizeLectureSummary(entry, courseId)));
}

export function normalizeLectureDetail(payload, courseId, origin) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.lectureUnits)) {
    throw new SafeError("malformed", MALFORMED);
  }
  const course = courseObject(payload.course);
  if (courseId != null && course != null && course !== courseId) {
    throw new SafeError("forbidden", "The lecture is not in the requested course.");
  }
  const lectureId = requirePayloadId(payload.id);
  const nowMs = Date.now();
  const materials = payload.lectureUnits
    .filter((unit) => unit && unit.visibleToStudents === true)
    .map((unit) => materialReference(unit, origin, lectureId));
  if (Array.isArray(payload.attachments)) {
    for (const attachment of payload.attachments) {
      const item = lectureAttachment(attachment, lectureId, nowMs);
      if (item) {
        materials.push(item);
      }
    }
  }
  return {
    id: lectureId,
    courseId: course ?? courseId,
    title: requireTitle(payload.title),
    description: optionalText(payload.description),
    startDate: normalizeDate(payload.startDate),
    endDate: normalizeDate(payload.endDate),
    tutorial: payload.isTutorialLecture === true,
    materials,
  };
}

export function findLectureDownload(lecture, selector) {
  const unitId = selector.unitId == null ? null : requireId(selector.unitId);
  const attachmentId = selector.attachmentId == null ? null : requireId(selector.attachmentId);
  if ((unitId == null) === (attachmentId == null)) {
    throw new SafeError("invalid_arguments", "Provide the unitId or attachmentId from get_lecture.");
  }
  const materials = Array.isArray(lecture?.materials) ? lecture.materials : [];
  const match = unitId == null
    ? materials.find((item) => item.kind === "lecture-attachment" && item.id === attachmentId)
    : materials.find((item) => item.kind === "attachment" && item.id === unitId && (attachmentId == null || item.attachmentId === attachmentId));
  if (!match) {
    throw new SafeError("not_found", "That attachment is not in this lecture for the current student.");
  }
  if (typeof match.path !== "string") {
    throw new SafeError("external_file", "That material is a link outside Artemis and was not downloaded.");
  }
  return match;
}

function normalizeExerciseSummary(entry, courseId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return {
    id: requirePayloadId(entry.id),
    courseId,
    type: exerciseType(entry),
    title: requireTitle(entry.title),
    releaseDate: normalizeDate(entry.releaseDate),
    startDate: normalizeDate(entry.startDate),
    dueDate: normalizeDate(entry.dueDate),
  };
}

function normalizeLectureSummary(entry, courseId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return {
    id: requirePayloadId(entry.id),
    courseId,
    title: requireTitle(entry.title),
    startDate: normalizeDate(entry.startDate),
    endDate: normalizeDate(entry.endDate),
    tutorial: entry.isTutorialLecture === true,
  };
}

function materialReference(unit, origin, lectureId) {
  const kind = unit.type;
  if (kind !== "attachment" && kind !== "online" && kind !== "text" && kind !== "exercise") {
    throw new SafeError("malformed", MALFORMED);
  }
  const reference = {
    id: requirePayloadId(unit.id),
    kind,
    title: requireTitle(unit.name ?? unit.title),
    releaseDate: normalizeDate(unit.releaseDate),
  };
  if (kind === "attachment") {
    Object.assign(reference, attachmentFields(unit.attachment, { unitId: reference.id, lectureId, origin }));
  } else if (kind === "online") {
    const link = safeLink(unit.source, origin);
    if (link?.url) {
      reference.url = link.url;
    }
    if (link?.path) {
      reference.path = link.path;
    }
  } else if (kind === "text") {
    reference.text = optionalText(unit.content);
  } else if (unit.exercise && typeof unit.exercise === "object") {
    reference.exerciseId = requirePayloadId(unit.exercise.id);
  }
  return reference;
}

function lectureAttachment(attachment, lectureId, nowMs) {
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
    return null;
  }
  const releaseDate = normalizeDate(attachment.releaseDate);
  if (releaseDate && Date.parse(releaseDate) > nowMs) {
    return null;
  }
  const reference = {
    id: requirePayloadId(attachment.id),
    kind: "lecture-attachment",
    title: requireTitle(attachment.name),
    releaseDate,
  };
  Object.assign(reference, attachmentFields(attachment, { lectureId }));
  return reference;
}

function attachmentFields(attachment, scope) {
  if (!attachment || typeof attachment !== "object") {
    return {};
  }
  const fields = {};
  if (attachment.id != null) {
    fields.attachmentId = requirePayloadId(attachment.id);
  }
  if (attachment.attachmentType === "FILE" || attachment.attachmentType === "URL") {
    fields.attachmentType = attachment.attachmentType;
  }
  if (Number.isSafeInteger(attachment.version) && attachment.version >= 0) {
    fields.version = attachment.version;
  }
  const stored = storedAttachment(attachment.studentVersion, scope, true) ?? storedAttachment(attachment.link, scope, false);
  if (stored?.path && scope.unitId && !stored.path.includes("/student/")) {
    stored.path = `/api/core/files/attachments/attachment-video-units/${scope.unitId}/student/${encodeURIComponent(stored.filename)}`;
  }
  if (stored?.path) {
    fields.path = stored.path;
    fields.filename = stored.filename;
  } else if (stored?.url) {
    fields.url = stored.url;
    fields.filename = stored.filename;
  } else if (typeof attachment.name === "string" && safeSegment(attachment.name)) {
    fields.filename = attachment.name;
  }
  return fields;
}

function storedAttachment(value, scope, studentVersion) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000 || value.includes("\\") || value.includes("..")) {
    return null;
  }
  const bare = value.split("#")[0].split("?")[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) {
    const link = safeLink(bare, scope.origin);
    return link?.url ? { url: link.url, filename: fileName(bare, null) } : null;
  }
  let path = null;
  if (bare.startsWith("/api/core/files/attachments/")) {
    path = bare;
  } else if (bare.startsWith("attachments/")) {
    path = `/api/core/files/${bare}`;
  } else if (bare.startsWith("files/attachments/")) {
    path = `/api/core/${bare}`;
  } else if (!bare.includes("/")) {
    path = builtPath(bare, scope, studentVersion);
  }
  if (!acceptedDownloadPath(path, scope)) {
    return null;
  }
  return { path, filename: fileName(path, null) };
}

function builtPath(filename, scope, studentVersion) {
  if (!safeSegment(filename)) {
    return null;
  }
  const encoded = encodeURIComponent(filename);
  if (scope.unitId && studentVersion) {
    return `/api/core/files/attachments/attachment-video-units/${scope.unitId}/student/${encoded}`;
  }
  if (scope.unitId) {
    return `/api/core/files/attachments/attachment-video-units/${scope.unitId}/${encoded}`;
  }
  if (scope.lectureId) {
    return `/api/core/files/attachments/lectures/${scope.lectureId}/${encoded}`;
  }
  return null;
}

function acceptedDownloadPath(filePath, scope) {
  if (typeof filePath !== "string" || filePath.includes("?") || filePath.includes("#")) {
    return false;
  }
  const segment = filePath.split("/").pop();
  if (!safeSegment(decodeSegment(segment))) {
    return false;
  }
  if (scope.unitId) {
    const unit = String(scope.unitId);
    return filePath === `/api/core/files/attachments/attachment-video-units/${unit}/student/${segment}` || filePath === `/api/core/files/attachments/attachment-video-units/${unit}/${segment}`;
  }
  return scope.lectureId != null && filePath === `/api/core/files/attachments/lectures/${scope.lectureId}/${segment}`;
}

function fileName(filePath, fallback) {
  const segment = decodeSegment(String(filePath).split("/").pop() ?? "");
  if (safeSegment(segment)) {
    return segment;
  }
  return safeSegment(fallback) ? fallback : "attachment";
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function safeSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 120 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function safeLink(value, origin) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) {
    return null;
  }
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("..") && !value.includes("\\")) {
    return { path: value.split("#")[0] };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return null;
  }
  if (url.origin === origin) {
    return { path: `${url.pathname}${url.search}` };
  }
  if (url.protocol === "https:") {
    return { url: `${url.origin}${url.pathname}${url.search}` };
  }
  return null;
}

function exerciseType(entry) {
  const raw = typeof entry.type === "string" ? entry.type : entry.exerciseType;
  if (typeof raw !== "string") {
    throw new SafeError("malformed", MALFORMED);
  }
  const normalized = TYPES.has(raw) ? raw : ENUM_TYPE[raw];
  if (!normalized) {
    throw new SafeError("malformed", MALFORMED);
  }
  return normalized;
}

function courseObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.id == null) {
    return null;
  }
  return requirePayloadId(value.id);
}

function isReleased(releaseDate, nowMs) {
  if (releaseDate == null) {
    return true;
  }
  return Date.parse(releaseDate) <= nowMs;
}

function requirePayloadId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value;
}

function requireTitle(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 2000) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value;
}

function optionalText(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SafeError("malformed", MALFORMED);
  }
  if (value.length > TEXT_LIMIT) {
    return null;
  }
  return value;
}

function sortById(items) {
  items.sort((left, right) => left.id - right.id);
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw new SafeError("malformed", MALFORMED);
  }
  return items;
}
