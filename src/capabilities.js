import { SafeError } from "./errors.js";
import { exchange, parseJsonBody } from "./http.js";

const INFO_PATH = "/management/info";

/**
 * Read only the public flags that choose an auth strategy.
 * `ldap` in activeModuleFeatures is what mounts LdapAuthenticationProvider,
 * independently of the OIDC browser button.
 * @param {string} origin
 * @param {typeof fetch} fetchImpl
 */
export async function fetchCapabilities(origin, fetchImpl) {
  let response;
  try {
    response = await exchange(fetchImpl, origin, INFO_PATH, { method: "GET" });
  } catch (error) {
    if (error instanceof SafeError) {
      return unknownCapabilities();
    }
    throw error;
  }
  if (response.status !== 200) {
    return unknownCapabilities();
  }
  const body = parseJsonBody(response.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return unknownCapabilities();
  }
  const features = Array.isArray(body.activeModuleFeatures)
    ? body.activeModuleFeatures.filter((feature) => typeof feature === "string")
    : [];
  const oidc = body.oidc && typeof body.oidc === "object" ? body.oidc : null;
  return {
    directoryPassword: features.includes("ldap"),
    oidc: Boolean(oidc),
    oidcLabel: safeLabel(oidc?.buttonLabel),
    accountName: safeLabel(body.accountName),
  };
}

function unknownCapabilities() {
  return { directoryPassword: false, oidc: false, oidcLabel: null, accountName: null };
}

function safeLabel(value) {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/[^\p{L}\p{N} .'_()+-]/gu, "").trim();
  if (!cleaned || cleaned.length > 80) {
    return null;
  }
  return cleaned;
}
