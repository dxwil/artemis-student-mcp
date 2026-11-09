import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SafeError } from "./errors.js";

const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "profiles");

/**
 * ARTEMIS_BASE_URL wins. A named profile may supply an origin only.
 * Course requests never read the profile.
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveConfiguredOrigin(env) {
  if (typeof env.ARTEMIS_BASE_URL === "string" && env.ARTEMIS_BASE_URL.trim() !== "") {
    return env.ARTEMIS_BASE_URL;
  }
  const profile = typeof env.ARTEMIS_PROFILE === "string" ? env.ARTEMIS_PROFILE.trim() : "";
  if (profile === "") {
    return undefined;
  }
  if (!/^[a-z0-9-]+$/.test(profile)) {
    throw new SafeError("invalid_profile", "ARTEMIS_PROFILE must be a lowercase profile name.");
  }
  const file = path.join(PROFILES_DIR, `${profile}.json`);
  if (!fs.existsSync(file)) {
    throw new SafeError("invalid_profile", "ARTEMIS_PROFILE does not match a profile in config/profiles.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new SafeError("invalid_profile", "The selected profile could not be read.");
  }
  if (!parsed || typeof parsed.origin !== "string") {
    throw new SafeError("invalid_profile", "The selected profile has no origin.");
  }
  return parsed.origin;
}
