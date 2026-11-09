import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SafeError } from "./errors.js";
import { resolveTokenFile } from "./session.js";

const TTL_MS = 5 * 60 * 1000;

export function gateWrite(env, tool, fields, confirmationToken, nowMs = Date.now()) {
  if (confirmationToken == null) {
    return { phase: "preview", ...issueConfirmation(env, tool, fields, nowMs) };
  }
  consumeConfirmation(env, tool, fields, confirmationToken, nowMs);
  return { phase: "commit" };
}

function issueConfirmation(env, tool, fields, nowMs) {
  const store = loadStore(env, nowMs);
  const token = crypto.randomBytes(32).toString("hex");
  store.entries.push({ token, payload: stable({ tool, fields }), expiresAt: nowMs + TTL_MS });
  saveStore(env, store);
  return { confirmationToken: token, expiresAt: new Date(nowMs + TTL_MS).toISOString() };
}

function consumeConfirmation(env, tool, fields, confirmationToken, nowMs) {
  if (typeof confirmationToken !== "string" || !/^[a-f0-9]{64}$/.test(confirmationToken)) {
    throw new SafeError(
      "confirmation_required",
      "Show the preview to the user. Send the confirmation token only after they explicitly approve.",
    );
  }
  const store = loadStore(env, nowMs);
  const index = store.entries.findIndex((entry) => entry.token === confirmationToken);
  if (index < 0) {
    throw new SafeError("confirmation_required", "That confirmation is missing or was already used. Request a new preview.");
  }
  const entry = store.entries[index];
  store.entries.splice(index, 1);
  saveStore(env, store);
  if (entry.expiresAt <= nowMs) {
    throw new SafeError("confirmation_expired", "The confirmation expired. Request a new preview. The write was not sent.");
  }
  if (entry.payload !== stable({ tool, fields })) {
    throw new SafeError("confirmation_mismatch", "The confirmation does not match this request. Request a new preview. The write was not sent.");
  }
}

function loadStore(env, nowMs) {
  const file = confirmationFile(env);
  if (!fs.existsSync(file)) {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return { entries: entries.filter((entry) => entry && entry.expiresAt > nowMs).slice(-20) };
  } catch {
    return { entries: [] };
  }
}

function saveStore(env, store) {
  const file = confirmationFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ entries: store.entries.slice(-20) }), { mode: 0o600 });
}

function confirmationFile(env) {
  const tokenFile = resolveTokenFile(env);
  if (!tokenFile) {
    throw new SafeError("no_token_store", "Set PLUGIN_DATA before confirming a write.");
  }
  return path.join(path.dirname(tokenFile), "write-confirmations.json");
}

function stable(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
