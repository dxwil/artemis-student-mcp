import { resolveConfig } from "./auth.js";
import { describeStudentFile } from "./files.js";
import { findLectureDownload, getLecture } from "./student-reads.js";

export async function downloadFile(env, reference, nowMs = Date.now()) {
  return describeStudentFile(reference, resolveConfig(env, nowMs).origin);
}

export async function downloadAttachment(env, lectureId, selector, fetchImpl, nowMs = Date.now()) {
  const lecture = await getLecture(env, lectureId, null, fetchImpl, nowMs);
  const material = findLectureDownload(lecture, selector ?? {});
  const name = material.filename || material.title;
  return describeStudentFile(material.path, resolveConfig(env, nowMs).origin, name);
}
