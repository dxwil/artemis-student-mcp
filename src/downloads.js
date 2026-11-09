import fs from "node:fs";
import path from "node:path";
import { studentGetBytes } from "./auth.js";
import { SafeError } from "./errors.js";
import { resolveTokenFile } from "./session.js";
import { requireId } from "./student-reads.js";

const ALLOWED = /^\/api\/core\/files\/attachments\/(?:lectures\/(\d+)\/|attachment-video-units\/(\d+)\/)/;

export async function downloadAttachment(env, lectureId, filePath, fetchImpl, nowMs = Date.now()) {
  const lecture = requireId(lectureId);
  if (typeof filePath !== "string" || !ALLOWED.test(filePath)) {
    throw new SafeError("invalid_arguments", "The download path must be a lecture attachment path on this Artemis server.");
  }
  const match = ALLOWED.exec(filePath);
  const pathLecture = Number(match[1]);
  if (match[1] && pathLecture !== lecture) {
    throw new SafeError("forbidden", "The attachment path is not for the requested lecture.");
  }
  const bytes = await studentGetBytes(env, filePath, fetchImpl, nowMs);
  const directory = downloadDirectory(env, lecture);
  const filename = safeFilename(filePath);
  const destination = path.join(directory, filename);
  if (!destination.startsWith(directory + path.sep)) {
    throw new SafeError("invalid_arguments", "The download path must be a lecture attachment path on this Artemis server.");
  }
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  return { bytes: bytes.length, relativePath: path.posix.join("downloads", String(lecture), filename) };
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

function safeFilename(filePath) {
  const base = path.posix.basename(filePath).replace(/[^A-Za-z0-9._-]/g, "_");
  if (base === "" || base === "." || base === ".." || base.length > 120) {
    throw new SafeError("invalid_arguments", "The attachment name is not a safe filename.");
  }
  return base;
}
