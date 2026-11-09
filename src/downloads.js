import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig, studentGetBytes } from "./auth.js";
import { SafeError } from "./errors.js";
import { normalizeStudentFilePath } from "./files.js";
import { resolveTokenFile } from "./session.js";
import { findLectureDownload, getLecture } from "./student-reads.js";

export const EMBED_LIMIT = 2 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

const MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  zip: "application/zip",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
};

export async function downloadFile(env, reference, fetchImpl, nowMs = Date.now(), hooks = {}) {
  return fetchStudentFile(env, reference, fetchImpl, nowMs, hooks, "files", {});
}

export async function downloadAttachment(env, lectureId, selector, fetchImpl, nowMs = Date.now(), hooks = {}) {
  const lecture = await getLecture(env, lectureId, null, fetchImpl, nowMs);
  const material = findLectureDownload(lecture, selector ?? {});
  return fetchStudentFile(env, material.path, fetchImpl, nowMs, hooks, String(lecture.id), {
    unitId: material.kind === "attachment" ? material.id : undefined,
    attachmentId: material.attachmentId ?? (material.kind === "lecture-attachment" ? material.id : undefined),
  });
}

async function fetchStudentFile(env, reference, fetchImpl, nowMs, hooks, bucket, extra) {
  const normalized = normalizeStudentFilePath(reference, resolveConfig(env, nowMs).origin);
  const bytes = await studentGetBytes(env, normalized.path, fetchImpl, nowMs);
  const filename = safeStoredName(normalized.filename);
  const mimeType = mimeOf(filename);
  const absolutePath = writeDownload(env, bucket, filename, bytes);
  const download = {
    bytes: bytes.length,
    filename,
    mimeType,
    path: normalized.path,
    ...extra,
  };
  let resource = null;
  if (bytes.length <= EMBED_LIMIT) {
    resource = {
      uri: `file://${absolutePath}`,
      mimeType,
      blob: bytes.toString("base64"),
    };
  }
  if (hooks.publishDownload) {
    const published = hooks.publishDownload({ absolutePath, filename, mimeType });
    download.downloadUrl = published.url;
    download.expiresAt = published.expiresAt;
    if (resource) {
      resource.uri = published.url;
    }
    return { download, resource };
  }
  download.absolutePath = absolutePath;
  return { download, resource };
}

function writeDownload(env, lectureId, filename, bytes) {
  const directory = downloadDirectory(env, lectureId);
  sweepOld(directory);
  const stored = `${crypto.randomBytes(8).toString("hex")}-${filename}`;
  const destination = path.join(directory, stored);
  if (!destination.startsWith(directory + path.sep)) {
    throw new SafeError("invalid_arguments", "The attachment name is not a safe filename.");
  }
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  return destination;
}

function downloadDirectory(env, lectureId) {
  const configured = typeof env.ARTEMIS_DOWNLOAD_DIR === "string" && env.ARTEMIS_DOWNLOAD_DIR.trim() !== "" ? path.resolve(env.ARTEMIS_DOWNLOAD_DIR) : null;
  const dataRoot = configured ?? (resolveTokenFile(env) ? path.dirname(resolveTokenFile(env)) : null);
  if (!dataRoot) {
    throw new SafeError("no_token_store", "Set PLUGIN_DATA or ARTEMIS_DOWNLOAD_DIR before downloading.");
  }
  const directory = path.join(dataRoot, "downloads", String(lectureId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function sweepOld(directory) {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // A file removed between the listing and the stat is already gone.
    }
  }
}

function safeStoredName(filename) {
  const cleaned = String(filename).replace(/[\u0000-\u001f]/g, "").replace(/[/\\]/g, "").slice(0, 180);
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new SafeError("invalid_arguments", "The attachment name is not a safe filename.");
  }
  return cleaned;
}

function mimeOf(filename) {
  const extension = filename.toLowerCase().split(".").pop();
  return MIME[extension] ?? "application/octet-stream";
}
