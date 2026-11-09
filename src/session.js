import fs from "node:fs";
import path from "node:path";
import { SafeError } from "./errors.js";

const SKEW_SECONDS = 30;

export function resolveTokenFile(env) {
  if (typeof env.ARTEMIS_TOKEN_FILE === "string" && env.ARTEMIS_TOKEN_FILE.trim() !== "") {
    return path.resolve(env.ARTEMIS_TOKEN_FILE.trim());
  }
  if (typeof env.PLUGIN_DATA === "string" && env.PLUGIN_DATA.trim() !== "") {
    return path.join(path.resolve(env.PLUGIN_DATA.trim()), "session.json");
  }
  return null;
}

export function assertTokenFileOutsidePlugin(tokenFile, pluginRoot) {
  if (!tokenFile || typeof pluginRoot !== "string" || pluginRoot.trim() === "") {
    return;
  }
  const file = path.resolve(tokenFile);
  const root = path.resolve(pluginRoot.trim());
  if (file === root || file.startsWith(root + path.sep)) {
    throw new SafeError("token_path", "The session file must not be stored inside the plugin directory.");
  }
}

export function loadSession(tokenFile, origin) {
  if (!tokenFile || !fs.existsSync(tokenFile)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (parsed.origin !== origin || typeof parsed.accessToken !== "string" || parsed.accessToken === "") {
    return null;
  }
  return {
    origin: parsed.origin,
    accessToken: parsed.accessToken,
    obtainedAt: typeof parsed.obtainedAt === "string" ? parsed.obtainedAt : null,
    strategy: parsed.strategy === "password" || parsed.strategy === "directory-password" ? parsed.strategy : null,
  };
}

export function saveSession(tokenFile, session) {
  if (!tokenFile) {
    return;
  }
  const directory = path.dirname(tokenFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(
    {
      version: 1,
      origin: session.origin,
      accessToken: session.accessToken,
      obtainedAt: session.obtainedAt,
      strategy: session.strategy === "password" || session.strategy === "directory-password" ? session.strategy : undefined,
    },
    null,
    2,
  );
  fs.writeFileSync(tokenFile, payload, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
}

export function clearSession(tokenFile) {
  if (!tokenFile || !fs.existsSync(tokenFile)) {
    return;
  }
  fs.rmSync(tokenFile, { force: true });
}

export function readExpiry(token) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

export function isExpired(token, nowMs) {
  const exp = readExpiry(token);
  if (exp == null) {
    return false;
  }
  return nowMs / 1000 >= exp - SKEW_SECONDS;
}

export function isInstructorToken(token) {
  return token.startsWith("art_pat_");
}
