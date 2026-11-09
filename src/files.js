import { SafeError } from "./errors.js";

const PREFIX = "/api/core/files/";
const INVALID = "The file reference is not a student file on this Artemis server.";

const ALLOWED = [
  /^\/api\/core\/files\/attachments\/lectures\/\d+\/[^/]+$/,
  /^\/api\/core\/files\/attachments\/attachment-video-units\/\d+\/student\/[^/]+$/,
  /^\/api\/core\/files\/attachments\/attachment-video-units\/\d+\/slide\/\d+$/,
  /^\/api\/core\/files\/slides\/\d+$/,
  /^\/api\/core\/files\/courses\/\d+\/conversations\/\d+\/[^/]+$/,
  /^\/api\/core\/files\/courses\/\d+\/icons\/[^/]+$/,
  /^\/api\/core\/files\/markdown\/[^/]+$/,
  /^\/api\/core\/files\/drag-and-drop\/questions\/\d+\/backgrounds\/[^/]+$/,
  /^\/api\/core\/files\/drag-and-drop\/questions\/\d+\/drag-items\/\d+\/[^/]+$/,
  /^\/api\/core\/files\/file-upload-exercises\/\d+\/submissions\/\d+\/[^/]+$/,
];

const FILE_URI = "artemis://files/";

const MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
};

export function normalizeStudentFilePath(input, origin) {
  if (typeof input !== "string") {
    throw new SafeError("invalid_arguments", INVALID);
  }
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 2000 || /[\u0000\\]/.test(trimmed)) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  const pathname = pathnameOf(trimmed, origin);
  const decoded = decodePath(pathname);
  if (decoded.includes("\\") || decoded.includes("//")) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  const relative = relativeToFiles(decoded);
  const segments = relative.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  const plain = `${PREFIX}${segments.join("/")}`;
  if (!ALLOWED.some((pattern) => pattern.test(plain))) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  const path = `${PREFIX}${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return {
    path,
    filename: segments.at(-1),
    uri: `${FILE_URI}${path.slice(PREFIX.length)}`,
    mimeType: mimeOf(segments.at(-1)),
  };
}

export function describeStudentFile(reference, origin, name) {
  const normalized = normalizeStudentFilePath(reference, origin);
  const label = typeof name === "string" && name.trim() !== "" ? name.trim().slice(0, 200) : normalized.filename;
  return {
    name: label,
    filename: normalized.filename,
    path: normalized.path,
    uri: normalized.uri,
    mimeType: normalized.mimeType,
  };
}

export function pathFromFileUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith(FILE_URI) || uri.length > 2200) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  const relative = uri.slice(FILE_URI.length);
  if (relative === "" || relative.startsWith("/") || relative.includes("?") || relative.includes("#") || relative.includes("\\")) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  return relative;
}

export function mimeOf(filename) {
  const extension = String(filename).toLowerCase().split(".").pop();
  return MIME[extension] ?? "application/octet-stream";
}

export function fileReferences(content, origin) {
  if (typeof content !== "string" || content === "") {
    return [];
  }
  const found = [];
  const seen = new Set();
  for (const match of content.matchAll(/\[([^\]\n]{0,300})\]\(([^)\s]{1,2000})\)/g)) {
    let normalized;
    try {
      normalized = normalizeStudentFilePath(match[2], origin);
    } catch (error) {
      if (error instanceof SafeError && error.code === "invalid_arguments") {
        continue;
      }
      throw error;
    }
    if (seen.has(normalized.path)) {
      continue;
    }
    seen.add(normalized.path);
    const name = match[1].trim();
    found.push(describeStudentFile(normalized.path, origin, name === "" ? normalized.filename : name));
    if (found.length === 20) {
      break;
    }
  }
  return found;
}

function pathnameOf(value, origin) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (typeof origin !== "string") {
      throw new SafeError("invalid_arguments", INVALID);
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new SafeError("invalid_arguments", INVALID);
    }
    if (url.origin !== origin || url.username !== "" || url.password !== "") {
      throw new SafeError("invalid_arguments", INVALID);
    }
    return url.pathname;
  }
  const hash = value.indexOf("#");
  const withoutHash = hash === -1 ? value : value.slice(0, hash);
  const query = withoutHash.indexOf("?");
  return query === -1 ? withoutHash : withoutHash.slice(0, query);
}

function decodePath(value) {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new SafeError("invalid_arguments", INVALID);
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function relativeToFiles(decoded) {
  if (decoded.startsWith(PREFIX)) {
    return decoded.slice(PREFIX.length);
  }
  if (decoded.startsWith("api/core/files/")) {
    return decoded.slice("api/core/files/".length);
  }
  if (decoded.startsWith("/files/")) {
    return decoded.slice("/files/".length);
  }
  if (decoded.startsWith("files/")) {
    return decoded.slice("files/".length);
  }
  if (decoded.startsWith("/")) {
    throw new SafeError("invalid_arguments", INVALID);
  }
  return decoded;
}
