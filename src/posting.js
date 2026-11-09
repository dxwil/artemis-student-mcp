import { studentSend } from "./auth.js";
import { gateWrite } from "./confirm.js";
import { listConversations, listMessages } from "./conversations.js";
import { SafeError } from "./errors.js";
import { requireStudentCourse } from "./mark-read.js";
import { requireId } from "./student-reads.js";

const CONTENT_LIMIT = 5_000;

export async function createPost(env, courseId, conversationId, content, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const course = await requireStudentCourse(env, courseId, fetchImpl, nowMs);
  const conversation = await requireMembership(env, course.id, conversationId, fetchImpl, nowMs);
  const text = requireContent(content);
  const body = { content: text, hasForwardedMessages: false, conversation: { id: conversation.id } };
  const fields = {
    method: "POST",
    path: `/api/communication/courses/${course.id}/messages`,
    body,
    courseTitle: course.title,
    conversationTitle: conversation.title,
  };
  const gate = gateWrite(env, "create_post", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return {
      preview: {
        action: "create_post",
        courseId: course.id,
        courseTitle: course.title,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        content: text,
        characters: text.length,
        method: "POST",
        path: fields.path,
      },
      confirmationToken: gate.confirmationToken,
      expiresAt: gate.expiresAt,
    };
  }
  const created = await studentSend(env, fields.path, { method: "POST", json: body, notEnabledOn404: true }, fetchImpl, nowMs);
  return { postId: createdId(created), courseId: course.id, conversationId: conversation.id };
}

export async function replyToPost(env, courseId, conversationId, postId, content, page, confirmationToken, fetchImpl, nowMs = Date.now()) {
  const course = await requireStudentCourse(env, courseId, fetchImpl, nowMs);
  const conversation = await requireMembership(env, course.id, conversationId, fetchImpl, nowMs);
  const post = requireId(postId);
  const pageNumber = page == null ? 0 : page;
  const posts = await listMessages(env, course.id, conversation.id, pageNumber, fetchImpl, nowMs);
  if (!posts.some((entry) => entry.id === post)) {
    throw new SafeError("not_found", "That post was not on the requested message page of this conversation.");
  }
  const text = requireContent(content);
  const body = { content: text, post: { id: post } };
  const fields = {
    method: "POST",
    path: `/api/communication/courses/${course.id}/answer-messages`,
    body,
    courseTitle: course.title,
    conversationTitle: conversation.title,
    page: pageNumber,
  };
  const gate = gateWrite(env, "reply_to_post", fields, confirmationToken, nowMs);
  if (gate.phase === "preview") {
    return {
      preview: {
        action: "reply_to_post",
        courseId: course.id,
        courseTitle: course.title,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        postId: post,
        content: text,
        characters: text.length,
        method: "POST",
        path: fields.path,
      },
      confirmationToken: gate.confirmationToken,
      expiresAt: gate.expiresAt,
    };
  }
  const created = await studentSend(env, fields.path, { method: "POST", json: body, notEnabledOn404: true }, fetchImpl, nowMs);
  return { answerId: createdId(created), courseId: course.id, postId: post };
}

async function requireMembership(env, courseId, conversationId, fetchImpl, nowMs) {
  const conversation = requireId(conversationId);
  const memberships = await listConversations(env, courseId, fetchImpl, nowMs);
  const match = memberships.find((entry) => entry.id === conversation);
  if (!match) {
    throw new SafeError("forbidden", "That conversation is not in the conversations this student belongs to.");
  }
  return match;
}

function requireContent(content) {
  if (typeof content !== "string" || content.trim() === "" || content.length > CONTENT_LIMIT) {
    throw new SafeError("invalid_arguments", "Post text must be 1 to 5000 characters.");
  }
  return content;
}

function createdId(payload) {
  if (!payload || typeof payload.id !== "number") {
    throw new SafeError("malformed", "Artemis accepted the write but did not return an id.");
  }
  return payload.id;
}
