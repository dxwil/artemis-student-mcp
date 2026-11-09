import { fetchCapabilities } from "./capabilities.js";
import { assertPasswordLength, assertUsernameFormat, normalizeUsername } from "./credentials.js";
import { SafeError } from "./errors.js";
import { exchange, parseJsonBody } from "./http.js";
import { normalizeOrigin } from "./origin.js";
import { resolveConfiguredOrigin } from "./profiles.js";
import {
  assertTokenFileOutsidePlugin,
  clearSession,
  isExpired,
  isInstructorToken,
  loadSession,
  resolveTokenFile,
  saveSession,
} from "./session.js";
import { normalizeDashboard } from "./courses.js";

const LOGIN_OPTIONS_PATH = "/api/core/public/login-options";
const AUTHENTICATE_PATH = "/api/core/public/authenticate";
const LOGOUT_PATH = "/api/core/public/logout";
const DASHBOARD_PATH = "/api/course/courses/for-dashboard";

export function resolveConfig(env, nowMs = Date.now()) {
  const origin = normalizeOrigin(resolveConfiguredOrigin(env));
  const tokenFile = resolveTokenFile(env);
  assertTokenFileOutsidePlugin(tokenFile, env.PLUGIN_ROOT);
  return {
    origin,
    username: normalizeUsername(env.ARTEMIS_USERNAME),
    password: typeof env.ARTEMIS_PASSWORD === "string" ? env.ARTEMIS_PASSWORD : "",
    rememberMe: env.ARTEMIS_REMEMBER_ME === "true",
    tokenFile,
    nowMs,
  };
}

export async function listCourses(env, fetchImpl = globalThis.fetch, nowMs = Date.now()) {
  const config = resolveConfig(env, nowMs);
  let token = usableToken(config);
  if (!token) {
    token = await loginWithPassword(config, fetchImpl);
  }
  try {
    return await fetchSummaries(config.origin, token, fetchImpl);
  } catch (error) {
    if (!(error instanceof SafeError) || error.code !== "unauthorized") {
      throw error;
    }
    clearSession(config.tokenFile);
    if (!config.username || !config.password) {
      throw error;
    }
    const fresh = await loginWithPassword(config, fetchImpl);
    try {
      return await fetchSummaries(config.origin, fresh, fetchImpl);
    } catch (second) {
      if (second instanceof SafeError && second.code === "unauthorized") {
        clearSession(config.tokenFile);
      }
      throw second;
    }
  }
}

export async function loginWithPassword(config, fetchImpl) {
  if (!config.username || !config.password) {
    throw new SafeError(
      "not_configured",
      "No student session is available. Set ARTEMIS_USERNAME and ARTEMIS_PASSWORD in the environment, or run the local login command. Do not pass a password as a tool argument.",
    );
  }
  assertUsernameFormat(config.username);
  const method = await fetchLoginMethod(config, fetchImpl);
  const strategy = await chooseStrategy(config, fetchImpl, method);
  assertPasswordLength(config.password);
  const response = await exchange(fetchImpl, config.origin, AUTHENTICATE_PATH, {
    method: "POST",
    json: {
      username: config.username,
      password: config.password,
      rememberMe: config.rememberMe,
    },
  });
  assertStatus(response.status, {
    401: ["unauthorized", "Artemis rejected the username and password."],
    400: ["bad_request", "Artemis rejected the login request."],
    403: ["forbidden", "Artemis refused the login request."],
    429: ["rate_limited", "Artemis rate-limited the request. Wait and try again."],
  });
  if (response.status !== 200) {
    throw new SafeError("login_failed", "Artemis did not complete password login.");
  }
  const parsed = parseJsonBody(response.body);
  const accessToken = parsed && typeof parsed === "object" ? parsed.access_token : undefined;
  if (typeof accessToken !== "string" || accessToken === "" || /\s/.test(accessToken)) {
    throw new SafeError("malformed", "Artemis did not return a usable session.");
  }
  if (isInstructorToken(accessToken)) {
    throw new SafeError(
      "not_student_session",
      "Instructor personal access tokens are not a student session and are not stored.",
    );
  }
  saveSession(config.tokenFile, {
    origin: config.origin,
    accessToken,
    obtainedAt: new Date(config.nowMs).toISOString(),
    strategy,
  });
  return accessToken;
}

async function chooseStrategy(config, fetchImpl, method) {
  if (method.loginMethod === "PASSWORD") {
    return "password";
  }
  const capabilities = await fetchCapabilities(config.origin, fetchImpl);
  if (capabilities.directoryPassword) {
    return "directory-password";
  }
  throw ssoError(method, capabilities);
}

export async function logout(env, fetchImpl = globalThis.fetch) {
  const config = resolveConfig(env);
  const session = config.tokenFile ? loadSession(config.tokenFile, config.origin) : null;
  if (session && !isInstructorToken(session.accessToken)) {
    try {
      await exchange(fetchImpl, config.origin, LOGOUT_PATH, {
        method: "POST",
        token: session.accessToken,
      });
    } catch (error) {
      if (!(error instanceof SafeError) || !["network", "redirect", "origin"].includes(error.code)) {
        clearSession(config.tokenFile);
        throw error;
      }
    }
  }
  clearSession(config.tokenFile);
}

async function fetchLoginMethod(config, fetchImpl) {
  const response = await exchange(fetchImpl, config.origin, LOGIN_OPTIONS_PATH, {
    method: "GET",
    query: { usernameOrEmail: config.username },
  });
  assertStatus(response.status, {
    400: ["bad_request", "Artemis rejected the login identifier."],
    429: ["rate_limited", "Artemis rate-limited the request. Wait and try again."],
  });
  if (response.status !== 200) {
    throw new SafeError("login_options", "Artemis did not return login options.");
  }
  const parsed = parseJsonBody(response.body);
  const loginMethod = parsed && typeof parsed === "object" ? parsed.loginMethod : undefined;
  const idpName = parsed && typeof parsed === "object" ? safeLabel(parsed.idpName) : null;
  if (loginMethod !== "PASSWORD" && loginMethod !== "OIDC" && loginMethod !== "SAML2") {
    throw new SafeError("login_options", "Artemis did not return a supported login method.");
  }
  return { loginMethod, idpName };
}

export async function studentGet(env, path, fetchImpl = globalThis.fetch, nowMs = Date.now(), options = {}) {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("..") || path.includes("\\") || path.includes("?")) {
    throw new SafeError("invalid_arguments", "The read path is not a student API path.");
  }
  const config = resolveConfig(env, nowMs);
  let token = usableToken(config);
  if (!token) {
    token = await loginWithPassword(config, fetchImpl);
  }
  try {
    return await getJson(config.origin, token, path, fetchImpl, options);
  } catch (error) {
    if (!(error instanceof SafeError) || error.code !== "unauthorized") {
      throw error;
    }
    clearSession(config.tokenFile);
    if (!config.username || !config.password) {
      throw error;
    }
    const fresh = await loginWithPassword(config, fetchImpl);
    try {
      return await getJson(config.origin, fresh, path, fetchImpl, options);
    } catch (second) {
      if (second instanceof SafeError && second.code === "unauthorized") {
        clearSession(config.tokenFile);
      }
      throw second;
    }
  }
}

async function fetchSummaries(origin, token, fetchImpl) {
  return normalizeDashboard(await getJson(origin, token, DASHBOARD_PATH, fetchImpl, {}));
}

async function getJson(origin, token, path, fetchImpl, options) {
  const response = await exchange(fetchImpl, origin, path, { method: "GET", token, query: options.query });
  if ((response.status === 404 && options.notEnabledOn404) || (response.status === 400 && options.notEnabledOn400)) {
    throw new SafeError("not_enabled", "This Artemis feature is not enabled for the current deployment or course.");
  }
  assertStatus(response.status, {
    401: ["unauthorized", "Artemis rejected the student session. The saved session was cleared."],
    403: ["forbidden", "Artemis refused this read for the current student session."],
    404: ["not_found", "Artemis could not find that item for this student session."],
    429: ["rate_limited", "Artemis rate-limited the request. Wait and try again."],
  });
  if (response.status !== 200) {
    throw new SafeError("unexpected_status", "Artemis did not return the requested read.");
  }
  return parseJsonBody(response.body);
}

export async function studentGetBytes(env, path, fetchImpl = globalThis.fetch, nowMs = Date.now()) {
  if (typeof path !== "string" || !path.startsWith("/api/core/files/") || path.includes("..") || path.includes("\\") || path.includes("?")) {
    throw new SafeError("invalid_arguments", "The download path is not a same-origin Artemis file path.");
  }
  const config = resolveConfig(env, nowMs);
  let token = usableToken(config);
  if (!token) {
    token = await loginWithPassword(config, fetchImpl);
  }
  const load = (accessToken) => exchange(fetchImpl, config.origin, path, { method: "GET", token: accessToken });
  let response = await load(token);
  if (response.status === 401 && config.username && config.password) {
    clearSession(config.tokenFile);
    token = await loginWithPassword(config, fetchImpl);
    response = await load(token);
  }
  assertStatus(response.status, {
    401: ["unauthorized", "Artemis rejected the student session. The saved session was cleared."],
    403: ["forbidden", "Artemis refused this read for the current student session."],
    404: ["not_found", "Artemis could not find that item for this student session."],
  });
  if (response.status !== 200) {
    throw new SafeError("unexpected_status", "Artemis did not return the requested file.");
  }
  return response.body;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

export async function studentSend(env, path, sendOptions, fetchImpl = globalThis.fetch, nowMs = Date.now()) {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("..") || path.includes("\\") || path.includes("?")) {
    throw new SafeError("invalid_arguments", "The write path is not a student API path.");
  }
  if (!WRITE_METHODS.has(sendOptions.method)) {
    throw new SafeError("invalid_arguments", "Student writes use POST, PUT, or PATCH.");
  }
  const config = resolveConfig(env, nowMs);
  let token = usableToken(config);
  if (!token) {
    token = await loginWithPassword(config, fetchImpl);
  }
  const response = await exchange(fetchImpl, config.origin, path, {
    method: sendOptions.method,
    token,
    json: sendOptions.json,
    form: sendOptions.form,
    query: sendOptions.query,
    redirects: false,
  });
  if (response.status === 401) {
    clearSession(config.tokenFile);
    throw new SafeError("unauthorized", "Artemis rejected the student session. The write was not retried.");
  }
  if (response.status === 404 && sendOptions.notEnabledOn404) {
    throw new SafeError("not_enabled", "This Artemis feature is not enabled for the current deployment or course.");
  }
  if (response.status === 403) {
    throw new SafeError("forbidden", "Artemis refused this write for the current student session.");
  }
  if (response.status === 404) {
    throw new SafeError("not_found", "Artemis could not find that item for this student session.");
  }
  if (response.status === 413) {
    throw new SafeError("payload_too_large", "Artemis rejected the write because it is too large. It was not retried.");
  }
  if (response.status === 429) {
    throw new SafeError("rate_limited", "Artemis rate-limited the request. The write was not retried.");
  }
  if (response.status === 400) {
    throw new SafeError("rejected", "Artemis rejected the write. It was not retried.");
  }
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
    throw new SafeError("unexpected_status", "Artemis did not accept the write. It was not retried.");
  }
  return parseJsonBody(response.body);
}

function usableToken(config) {
  if (!config.tokenFile) {
    return null;
  }
  const session = loadSession(config.tokenFile, config.origin);
  if (!session) {
    return null;
  }
  if (isInstructorToken(session.accessToken)) {
    throw new SafeError(
      "not_student_session",
      "Instructor personal access tokens are not a student session and are not sent.",
    );
  }
  if (isExpired(session.accessToken, config.nowMs)) {
    clearSession(config.tokenFile);
    return null;
  }
  return session.accessToken;
}

function assertStatus(status, mapped) {
  if (Object.prototype.hasOwnProperty.call(mapped, status)) {
    const [code, message] = mapped[status];
    throw new SafeError(code, message);
  }
}

function ssoError(method, capabilities) {
  const provider = method.idpName || capabilities.oidcLabel;
  const label = provider ? ` (${provider})` : "";
  return new SafeError(
    "sso_required",
    `This Artemis server asks for browser single sign-on${label}, and its public info does not list directory password login. Artemis finishes that browser login on its own redirect URI. This plugin does not register a new redirect, impersonate the official VS Code or iOS clients, or copy cookies.`,
  );
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
