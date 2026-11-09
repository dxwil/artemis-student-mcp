import { listCourses, studentSend } from "./auth.js";
import { gateWrite } from "./confirm.js";
import { listConversations } from "./conversations.js";
import { SafeError } from "./errors.js";
import { requireId } from "./student-reads.js";

export async function markNotificationsRead(env, courseId, notificationIds, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const course = await requireStudentCourse(env, courseId, fetchImpl, nowMs);
  const ids = requireIdList(notificationIds);
  const fields = {
    method: "PUT",
    path: `/api/notification/courses/${course.id}/status`,
    body: { notificationIds: ids, statusType: "SEEN" },
    courseTitle: course.title,
  };
  const gate = gateWrite(env, "mark_notifications_read", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return {
      preview: {
        action: "mark_notifications_read",
        courseId: course.id,
        courseTitle: course.title,
        notificationIds: ids,
        statusType: "SEEN",
        method: fields.method,
        path: fields.path,
      },
      confirmationToken: gate.confirmationToken,
      expiresAt: gate.expiresAt,
    };
  }
  await studentSend(env, fields.path, { method: "PUT", json: fields.body, notEnabledOn404: true }, fetchImpl, nowMs);
  return { marked: ids.length, courseId: course.id };
}

export async function markConversationRead(env, courseId, conversationId, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const course = await requireStudentCourse(env, courseId, fetchImpl, nowMs);
  const conversation = requireId(conversationId);
  const memberships = await listConversations(env, course.id, fetchImpl, nowMs);
  const match = memberships.find((entry) => entry.id === conversation);
  if (!match) {
    throw new SafeError("forbidden", "That conversation is not in the conversations this student belongs to.");
  }
  const fields = {
    method: "PATCH",
    path: `/api/communication/courses/${course.id}/conversations/${conversation}/mark-as-read`,
    conversationTitle: match.title,
    courseTitle: course.title,
  };
  const gate = gateWrite(env, "mark_conversation_read", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return {
      preview: {
        action: "mark_conversation_read",
        courseId: course.id,
        courseTitle: course.title,
        conversationId: conversation,
        conversationTitle: match.title,
        method: fields.method,
        path: fields.path,
      },
      confirmationToken: gate.confirmationToken,
      expiresAt: gate.expiresAt,
    };
  }
  await studentSend(env, fields.path, { method: "PATCH", notEnabledOn404: true }, fetchImpl, nowMs);
  return { conversationId: conversation, courseId: course.id, markedRead: true };
}

export async function requireStudentCourse(env, courseId, fetchImpl, nowMs) {
  const id = requireId(courseId);
  const courses = await listCourses(env, fetchImpl, nowMs);
  const course = courses.find((entry) => entry.id === id);
  if (!course) {
    throw new SafeError("not_found", "That course is not in this student's course list.");
  }
  return course;
}

function requireIdList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new SafeError("invalid_arguments", "notificationIds must contain 1 to 20 ids.");
  }
  const ids = value.map((item) => requireId(item));
  if (new Set(ids).size !== ids.length) {
    throw new SafeError("invalid_arguments", "notificationIds must not contain duplicates.");
  }
  return ids.sort((left, right) => left - right);
}
