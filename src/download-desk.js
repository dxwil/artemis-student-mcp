import crypto from "node:crypto";
import { SafeError } from "./errors.js";
import { normalizeStudentFilePath } from "./files.js";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function reviewStoredPath(path, origin) {
  return normalizeStudentFilePath(path, origin);
}

export function createDownloadDesk(options = {}) {
  const entries = new Map();
  const now = () => (typeof options.now === "function" ? options.now() : Date.now());
  return {
    issue({ userId, path, filename, mimeType, base, origin }) {
      const described = normalizeStudentFilePath(path, origin);
      sweep(entries, now());
      if (entries.size >= MAX_ENTRIES) {
        throw new SafeError("rate_limited", "Too many download links are waiting. Use one before requesting more.");
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAtMs = now() + TTL_MS;
      entries.set(hashToken(token), {
        userId,
        path: described.path,
        filename: described.filename,
        mimeType: mimeType || described.mimeType,
        expiresAtMs,
      });
      const root = String(base).replace(/\/$/, "");
      return {
        downloadUrl: `${root}/files/${token}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    inspect(token) {
      return lookup(entries, token, now(), false);
    },
    take(token) {
      return lookup(entries, token, now(), true);
    },
  };
}

function lookup(entries, token, nowMs, consume) {
  if (typeof token !== "string" || !TOKEN.test(token)) {
    return null;
  }
  const key = hashToken(token);
  const record = entries.get(key);
  if (!record) {
    return null;
  }
  if (record.expiresAtMs <= nowMs) {
    entries.delete(key);
    return null;
  }
  if (consume) {
    entries.delete(key);
  }
  return record;
}

function sweep(entries, nowMs) {
  for (const [key, record] of entries) {
    if (record.expiresAtMs <= nowMs) {
      entries.delete(key);
    }
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
