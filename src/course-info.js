import { studentGet } from "./auth.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { requireId } from "./student-reads.js";

const MALFORMED = "Artemis returned a response that does not match the student read shape.";

export async function listTutorialGroups(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/tutorialgroup/courses/${id}/tutorial-groups`, fetchImpl, nowMs, { notEnabledOn404: true });
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return payload.filter((group) => group && typeof group.id === "number").map((group) => ({
    id: group.id,
    courseId: id,
    title: typeof group.title === "string" ? group.title : "",
    campus: typeof group.campus === "string" ? group.campus : null,
    language: typeof group.language === "string" ? group.language : null,
    online: group.isOnline === true,
    registered: group.isUserRegistered === true,
    tutorName: typeof group.teachingAssistantName === "string" ? group.teachingAssistantName.slice(0, 200) : null,
  }));
}

export async function listCompetencies(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/atlas/courses/${id}/competencies`, fetchImpl, nowMs, { notEnabledOn404: true });
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return payload.filter((item) => item && typeof item.id === "number").map((item) => ({
    id: item.id,
    courseId: id,
    title: typeof item.title === "string" ? item.title : "",
    description: typeof item.description === "string" ? item.description.slice(0, 4_000) : null,
    taxonomy: typeof item.taxonomy === "string" ? item.taxonomy : null,
    softDueDate: normalizeDate(item.softDueDate),
    masteryThreshold: typeof item.masteryThreshold === "number" ? item.masteryThreshold : null,
    optional: item.optional === true,
    ownProgress: ownProgress(item.userProgress),
  }));
}

export async function getLearningPath(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/atlas/courses/${id}/learning-path/me`, fetchImpl, nowMs, { notEnabledOn400: true });
  if (!payload || typeof payload.id !== "number") {
    throw new SafeError("malformed", MALFORMED);
  }
  return { id: payload.id, courseId: id, started: payload.startedByStudent === true, progress: typeof payload.progress === "number" ? payload.progress : null };
}

export async function listFaqs(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/communication/courses/${id}/faqs`, fetchImpl, nowMs, { notEnabledOn404: true });
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return payload
    .filter((faq) => faq && faq.faqState === "ACCEPTED")
    .map((faq) => ({
      id: typeof faq.id === "number" ? faq.id : null,
      courseId: id,
      title: typeof faq.questionTitle === "string" ? faq.questionTitle : "",
      answer: typeof faq.questionAnswer === "string" ? faq.questionAnswer.slice(0, 8_000) : null,
    }))
    .filter((faq) => faq.id && faq.title);
}

export async function listNotifications(env, courseId, page, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const pageNumber = page == null ? 0 : page;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber > 20) {
    throw new SafeError("invalid_arguments", "page must be an integer from 0 through 20.");
  }
  const payload = await studentGet(env, `/api/notification/courses/${id}`, fetchImpl, nowMs, {
    query: { page: String(pageNumber), size: "20" },
    notEnabledOn404: true,
  });
  const items = Array.isArray(payload) ? payload : payload?.content ?? payload?.notifications;
  if (!Array.isArray(items)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return items.slice(0, 20).map((item) => ({
    id: typeof item.notificationId === "number" ? item.notificationId : null,
    courseId: id,
    type: typeof item.notificationType === "string" ? item.notificationType : null,
    category: typeof item.category === "string" ? item.category : null,
    createdAt: normalizeDate(item.creationDate),
    status: typeof item.status === "string" ? item.status : null,
  })).filter((item) => item.id);
}

function ownProgress(progress) {
  if (!Array.isArray(progress) || progress.length === 0 || typeof progress[0]?.progress !== "number") {
    return null;
  }
  return progress[0].progress;
}
