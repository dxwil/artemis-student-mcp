import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PASSWORD = "pw-do-not-print-123456";
export const USERNAME = "student1";

export function fakeJwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "student", exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

export function assertClean(text, secrets) {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) {
      throw new Error("a secret appeared in output");
    }
  }
}

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "artemis-student-"));
}

export function scriptedFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      href: String(url),
      method: init.method,
      hasAuthorization: Boolean(init.headers?.Authorization),
      authorizationMatches(token) {
        return init.headers?.Authorization === `Bearer ${token}`;
      },
      bodyKeys() {
        if (!init.body) {
          return [];
        }
        return Object.keys(JSON.parse(init.body)).sort();
      },
      passwordMatches(password) {
        return Boolean(init.body) && JSON.parse(init.body).password === password;
      },
    };
    calls.push(call);
    const handler = handlers.shift();
    if (!handler) {
      throw new Error("unexpected request");
    }
    return handler(new URL(url), init);
  };
  return { calls, fetchImpl };
}

export function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function dashboardBody() {
  return {
    courses: [
      {
        course: {
          id: 7,
          title: "Introduction to Informatics",
          shortName: "info1",
          description: "DESCRIPTION_MARKER",
          startDate: "2026-10-01T00:00:00+02:00",
          exercises: [{ title: "EXERCISE_MARKER" }],
        },
        totalScores: { relativeScore: "GRADE_MARKER_125" },
      },
      {
        course: {
          id: 3,
          title: "Discrete Structures",
          shortName: "ds",
          startDate: null,
          endDate: "2027-02-01T00:00:00Z",
        },
        totalScores: { absoluteScore: 4 },
      },
    ],
    activeExams: [{ id: 99, title: "EXAM_MARKER" }],
  };
}
