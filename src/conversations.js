import { resolveConfig, studentGet } from "./auth.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { fileReferences } from "./files.js";
import { requireId } from "./student-reads.js";

const PAGE_SIZE = 20;
const TEXT_LIMIT = 4_000;
const MALFORMED = "Artemis returned a response that does not match the student read shape.";

export async function listConversations(env, courseId, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const payload = await studentGet(env, `/api/communication/courses/${id}/conversations`, fetchImpl, nowMs, {
    notEnabledOn404: true,
  });
  if (!Array.isArray(payload)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return payload
    .filter((conversation) => conversation && typeof conversation.id === "number")
    .slice(0, 100)
    .map((conversation) => ({
      id: conversation.id,
      courseId: id,
      type: typeof conversation.type === "string" ? conversation.type : null,
      title: titleOf(conversation),
    }));
}

export async function listMessages(env, courseId, conversationId, page, fetchImpl, nowMs = Date.now()) {
  const course = requireId(courseId);
  const conversation = requireId(conversationId);
  const pageNumber = page == null ? 0 : page;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber > 20) {
    throw new SafeError("invalid_arguments", "page must be an integer from 0 through 20.");
  }
  const origin = resolveConfig(env, nowMs).origin;
  const posts = await studentGet(env, `/api/communication/courses/${course}/messages`, fetchImpl, nowMs, {
    query: {
      courseId: String(course),
      conversationIds: String(conversation),
      page: String(pageNumber),
      size: String(PAGE_SIZE),
      sort: "creationDate,desc",
    },
  });
  if (!Array.isArray(posts)) {
    throw new SafeError("malformed", MALFORMED);
  }
  return posts
    .filter((post) => post && post.visibleForStudents !== false)
    .slice(0, PAGE_SIZE)
    .map((post) => ({
      id: requirePayloadId(post.id),
      courseId: course,
      conversationId: conversation,
      createdAt: normalizeDate(post.creationDate),
      authorName: displayName(post.author),
      content: bound(post.content),
      files: fileReferences(bound(post.content), origin),
      answers: Array.isArray(post.answers)
        ? post.answers.slice(0, PAGE_SIZE).map((answer) => ({
            id: typeof answer?.id === "number" ? answer.id : null,
            createdAt: normalizeDate(answer?.creationDate),
            authorName: displayName(answer?.author),
            content: bound(answer?.content),
            files: fileReferences(bound(answer?.content), origin),
          }))
        : [],
    }));
}

function titleOf(conversation) {
  const value = conversation.title ?? conversation.name;
  return typeof value === "string" && value.trim() !== "" ? value.slice(0, 200) : null;
}

function displayName(author) {
  if (!author || typeof author !== "object" || typeof author.name !== "string") {
    return null;
  }
  const name = author.name.trim();
  return name === "" ? null : name.slice(0, 200);
}

function bound(value) {
  return typeof value === "string" ? value.slice(0, TEXT_LIMIT) : null;
}

function requirePayloadId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SafeError("malformed", MALFORMED);
  }
  return value;
}
