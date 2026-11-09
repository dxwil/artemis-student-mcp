import { SafeError } from "./errors.js";
import { isInstructorToken } from "./session.js";

export const USER_AGENT = "artemis-student-mcp/0.1.0";
export const MAX_BYTES = 8 * 1024 * 1024;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * HTTPS request pinned to one origin. Redirects to any other origin are refused
 * before another request is made, so Authorization is never forwarded off-origin.
 * @param {typeof fetch} fetchImpl
 */
export async function exchange(fetchImpl, origin, path, options = {}) {
  let current = new URL(path, origin);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      current.searchParams.set(key, value);
    }
  }
  if (current.origin !== origin) {
    throw new SafeError("origin", "Refusing to call a different origin.");
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  let method = options.method ?? "GET";
  let body;
  if (options.form) {
    body = options.form;
  } else if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  if (options.token) {
    if (isInstructorToken(options.token)) {
      throw new SafeError(
        "not_student_session",
        "Instructor personal access tokens are not a student session and are not sent.",
      );
    }
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response;
  for (let hop = 0; hop < 3; hop += 1) {
    try {
      response = await fetchImpl(current, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
      });
    } catch {
      throw new SafeError("network", "Could not reach the Artemis server.");
    }
    if (!REDIRECT.has(response.status)) {
      break;
    }
    if (options.redirects === false) {
      try {
        await response.body?.cancel();
      } catch {
        // The redirect body is not used.
      }
      throw new SafeError("redirect", "Artemis redirected a write. The write was not sent again.");
    }
    try {
      await response.body?.cancel();
    } catch {
      // The redirect body is not used.
    }
    const next = resolveRedirect(response, current, origin);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }

  if (REDIRECT.has(response.status)) {
    throw new SafeError(
      "redirect",
      "Artemis redirected the request too many times. The session was not followed further.",
    );
  }
  if (options.stream) {
    return { status: response.status, headers: response.headers, body: response.body };
  }
  return { status: response.status, body: await readLimited(response) };
}

function resolveRedirect(response, current, origin) {
  const location = response.headers.get("location");
  let next;
  try {
    next = new URL(location ?? "", current);
  } catch {
    throw new SafeError(
      "redirect",
      "Artemis redirected the request to an invalid location. The session was not followed.",
    );
  }
  if (next.origin !== origin) {
    throw new SafeError(
      "redirect",
      "Artemis redirected the request off the configured server. The session was not sent to that destination.",
    );
  }
  return next;
}

async function readLimited(response) {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The oversized body is discarded either way.
      }
      throw new SafeError("response_too_large", "Artemis returned a response that is too large to accept.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(buffer) {
  if (buffer.length === 0) {
    return null;
  }
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SafeError("malformed", "Artemis returned a response that is not valid JSON.");
  }
}
