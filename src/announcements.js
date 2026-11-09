import { studentGet } from "./auth.js";
import { normalizeDate } from "./courses.js";
import { SafeError } from "./errors.js";
import { requireId } from "./student-reads.js";

const PAGE_SIZE = 20;
const TEXT_LIMIT = 8_000;

export async function listAnnouncements(env, courseId, page, fetchImpl, nowMs = Date.now()) {
  const id = requireId(courseId);
  const pageNumber = boundPage(page);
  const channels = await studentGet(env, `/api/communication/courses/${id}/channels/overview`, fetchImpl, nowMs, {
    notEnabledOn404: true,
  });
  if (!Array.isArray(channels)) {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  const channel = channels.find((entry) => entry && entry.isAnnouncementChannel === true && typeof entry.id === "number");
  if (!channel) {
    return [];
  }
  const posts = await studentGet(env, `/api/communication/courses/${id}/messages`, fetchImpl, nowMs, {
    query: {
      courseId: String(id),
      conversationIds: String(channel.id),
      page: String(pageNumber),
      size: String(PAGE_SIZE),
      sort: "creationDate,desc",
    },
  });
  if (!Array.isArray(posts)) {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  return posts
    .filter((post) => post && post.visibleForStudents !== false)
    .slice(0, PAGE_SIZE)
    .map((post) => ({
      id: requirePayloadId(post.id),
      courseId: id,
      channelId: channel.id,
      title: optionalShort(post.title),
      content: optionalBounded(post.content),
      createdAt: normalizeDate(post.creationDate),
      authorName: displayName(post.author),
    }));
}

function boundPage(page) {
  if (page == null) {
    return 0;
  }
  if (typeof page !== "number" || !Number.isInteger(page) || page < 0 || page > 20) {
    throw new SafeError("invalid_arguments", "page must be an integer from 0 through 20.");
  }
  return page;
}

function displayName(author) {
  if (!author || typeof author !== "object") {
    return null;
  }
  if (typeof author.name === "string" && author.name.trim() !== "") {
    return author.name.trim().slice(0, 200);
  }
  return null;
}

function optionalShort(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  return value.slice(0, 500);
}

function optionalBounded(value) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  return value.slice(0, TEXT_LIMIT);
}

function requirePayloadId(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SafeError("malformed", "Artemis returned a response that does not match the student read shape.");
  }
  return value;
}
