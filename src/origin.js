import { SafeError } from "./errors.js";

export const DEFAULT_ORIGIN = "https://artemis.tum.de";

/**
 * Accept only an HTTPS origin. Credentials, queries, fragments, and paths are rejected
 * so a session cannot be aimed at an unexpected URL by configuration.
 * @param {string | undefined} input
 */
export function normalizeOrigin(input) {
  const raw = input == null || input.trim() === "" ? DEFAULT_ORIGIN : input.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeError("invalid_base_url", "ARTEMIS_BASE_URL must be an HTTPS origin.");
  }
  if (url.protocol !== "https:") {
    throw new SafeError("invalid_base_url", "ARTEMIS_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new SafeError("invalid_base_url", "ARTEMIS_BASE_URL must not include credentials.");
  }
  if (url.search || url.hash) {
    throw new SafeError("invalid_base_url", "ARTEMIS_BASE_URL must not include a query or fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new SafeError("invalid_base_url", "ARTEMIS_BASE_URL must be an origin without a path.");
  }
  return url.origin;
}
