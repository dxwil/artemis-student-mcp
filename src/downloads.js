import { resolveConfig, studentGetBytes } from "./auth.js";
import { describeStudentFile, mimeOf, pathFromFileUri } from "./files.js";
import { findLectureDownload, getLecture } from "./student-reads.js";

export async function downloadFile(env, reference, fetchImpl, nowMs = Date.now()) {
  return describeStudentFile(reference, resolveConfig(env, nowMs).origin);
}

export async function downloadAttachment(env, lectureId, selector, fetchImpl, nowMs = Date.now()) {
  const lecture = await getLecture(env, lectureId, null, fetchImpl, nowMs);
  const material = findLectureDownload(lecture, selector ?? {});
  const name = material.filename || material.title;
  return describeStudentFile(material.path, resolveConfig(env, nowMs).origin, name);
}

export async function readStudentFile(env, uri, fetchImpl, nowMs = Date.now()) {
  const origin = resolveConfig(env, nowMs).origin;
  const described = describeStudentFile(pathFromFileUri(uri), origin);
  const bytes = Buffer.from(await studentGetBytes(env, described.path, fetchImpl, nowMs));
  const mimeType = mimeOf(described.filename);
  const content = { uri: described.uri, mimeType, size: bytes.length };
  if (mimeType.startsWith("text/")) {
    content.text = bytes.toString("utf8");
  } else {
    content.blob = bytes.toString("base64");
  }
  return content;
}
