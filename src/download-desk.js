import crypto from "node:crypto";
import fs from "node:fs";

const TTL_MS = 10 * 60 * 1000;

export function createDownloadDesk() {
  const tickets = new Map();
  return {
    issue({ userId, filePath, filename, mimeType, base }) {
      sweep(tickets);
      const token = crypto.randomBytes(32).toString("base64url");
      tickets.set(token, {
        userId,
        filePath,
        filename,
        mimeType,
        expiresAt: Date.now() + TTL_MS,
      });
      return { url: `${base}/files/${token}`, expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
    },
    take(token) {
      sweep(tickets);
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
        return null;
      }
      const entry = tickets.get(token);
      if (!entry) {
        return null;
      }
      tickets.delete(token);
      let bytes = null;
      try {
        bytes = fs.readFileSync(entry.filePath);
      } catch {
        bytes = null;
      }
      fs.rmSync(entry.filePath, { force: true });
      if (!bytes) {
        return null;
      }
      return { userId: entry.userId, filename: entry.filename, mimeType: entry.mimeType, bytes };
    },
  };
}

function sweep(tickets) {
  const now = Date.now();
  for (const [token, entry] of tickets) {
    if (entry.expiresAt <= now) {
      tickets.delete(token);
      fs.rmSync(entry.filePath, { force: true });
    }
  }
}
