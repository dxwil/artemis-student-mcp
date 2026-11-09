import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listCourses, logout, resolveConfig } from "../src/auth.js";
import { SafeError } from "../src/errors.js";
import { normalizeOrigin } from "../src/origin.js";
import { dashboardBody, fakeJwt, jsonResponse, PASSWORD, scriptedFetch, tempDir, USERNAME } from "./support.js";

function env(directory, extra = {}) {
  return {
    ARTEMIS_BASE_URL: "https://artemis.test",
    PLUGIN_DATA: directory,
    PLUGIN_ROOT: path.resolve("."),
    ...extra,
  };
}

test("a named profile supplies only the origin and loses to ARTEMIS_BASE_URL", () => {
  assert.equal(resolveConfig({ ARTEMIS_PROFILE: "tum" }).origin, "https://artemis.tum.de");
  assert.equal(
    resolveConfig({ ARTEMIS_PROFILE: "tum", ARTEMIS_BASE_URL: "https://artemis.example.edu" }).origin,
    "https://artemis.example.edu",
  );
  assert.throws(
    () => resolveConfig({ ARTEMIS_PROFILE: "../tum" }),
    (error) => error instanceof SafeError && error.code === "invalid_profile",
  );
});

test("rejects insecure and credentialed base URLs before any request", () => {
  assert.equal(normalizeOrigin(undefined), "https://artemis.tum.de");
  assert.equal(normalizeOrigin("https://artemis.tum.de/"), "https://artemis.tum.de");
  for (const value of ["http://artemis.tum.de", "https://user:pw@artemis.tum.de", "https://artemis.tum.de/api"]) {
    assert.throws(() => normalizeOrigin(value), (error) => error instanceof SafeError && error.code === "invalid_base_url");
  }
});

test("logs in only after the server asks for a password, then returns course summaries", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const script = scriptedFetch([
    () => jsonResponse(200, { loginMethod: "PASSWORD", idpName: null }),
    () => jsonResponse(200, { access_token: token }),
    () => jsonResponse(200, dashboardBody()),
  ]);
  const courses = await listCourses(
    env(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }),
    script.fetchImpl,
  );
  assert.equal(courses.length, 2);
  assert.equal(courses[0].id, 3);
  assert.equal(script.calls.length, 3);
  assert.equal(new URL(script.calls[0].href).pathname, "/api/core/public/login-options");
  assert.equal(script.calls[0].hasAuthorization, false);
  assert.equal(script.calls[1].passwordMatches(PASSWORD), true);
  assert.deepEqual(script.calls[1].bodyKeys(), ["password", "rememberMe", "username"]);
  assert.equal(new URL(script.calls[1].href).search, "");
  assert.equal(script.calls[2].authorizationMatches(token), true);
  assert.equal(new URL(script.calls[2].href).pathname, "/api/course/courses/for-dashboard");
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
  assert.equal(stored.accessToken === token, true);
  assert.equal(fs.statSync(path.join(directory, "session.json")).mode & 0o077, 0);
  assert.equal(JSON.stringify(courses).includes(PASSWORD), false);
  assert.equal(JSON.stringify(courses).includes(token), false);
});

test("does not send a password when single sign-on is required and directory login is absent", async () => {
  const directory = tempDir();
  const script = scriptedFetch([
    () => jsonResponse(200, { loginMethod: "OIDC", idpName: "TUM Login" }),
    () => jsonResponse(200, { activeModuleFeatures: ["passkey"], oidc: { buttonLabel: "TUM Login" }, internalNote: "INFO_SECRET_MARKER" }),
  ]);
  await assert.rejects(
    () => listCourses(env(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }), script.fetchImpl),
    (error) =>
      error instanceof SafeError &&
      error.code === "sso_required" &&
      error.message.includes("TUM Login") &&
      !error.message.includes(PASSWORD) &&
      !error.message.includes("INFO_SECRET_MARKER"),
  );
  assert.equal(script.calls.length, 2);
  assert.equal(script.calls[0].hasAuthorization, false);
  assert.equal(new URL(script.calls[1].href).pathname, "/management/info");
  assert.equal(script.calls[1].passwordMatches(PASSWORD), false);
});

test("uses the Artemis password endpoint when public info lists ldap, even if the browser button is single sign-on", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const script = scriptedFetch([
    () => jsonResponse(200, { loginMethod: "OIDC", idpName: "TUM Login" }),
    () =>
      jsonResponse(200, {
        activeModuleFeatures: ["ldap"],
        oidc: { buttonLabel: "TUM Login" },
        accountName: "TUM",
        internalNote: "INFO_SECRET_MARKER",
      }),
    () => jsonResponse(200, { access_token: token }),
    () => jsonResponse(200, dashboardBody()),
  ]);
  const courses = await listCourses(
    env(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }),
    script.fetchImpl,
  );
  assert.equal(courses.length, 2);
  assert.equal(script.calls[2].passwordMatches(PASSWORD), true);
  assert.equal(new URL(script.calls[2].href).pathname, "/api/core/public/authenticate");
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
  assert.equal(stored.strategy, "directory-password");
  assert.equal(JSON.stringify(courses).includes("INFO_SECRET_MARKER"), false);
  assert.equal(JSON.stringify(courses).includes(PASSWORD), false);
});

test("reports a rejected password without a second attempt", async () => {
  const directory = tempDir();
  const script = scriptedFetch([
    () => jsonResponse(200, { loginMethod: "PASSWORD" }),
    () => new Response(null, { status: 401 }),
  ]);
  await assert.rejects(
    () => listCourses(env(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }), script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "unauthorized" && !error.message.includes(PASSWORD),
  );
  assert.equal(script.calls.length, 2);
});

test("clears an expired session and does not send it", async () => {
  const directory = tempDir();
  const expired = fakeJwt(1_700_000_000);
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: expired, obtainedAt: "2024-01-01T00:00:00.000Z" }),
  );
  const script = scriptedFetch([]);
  await assert.rejects(
    () => listCourses(env(directory), script.fetchImpl, 1_800_000_000_000),
    (error) => error instanceof SafeError && error.code === "not_configured",
  );
  assert.equal(script.calls.length, 0);
  assert.equal(fs.existsSync(path.join(directory, "session.json")), false);
});

test("turns a dashboard 401 into a cleared session and a 403 into forbidden without clearing", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const file = path.join(directory, "session.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }));
  const forbidden = scriptedFetch([() => new Response(null, { status: 403 })]);
  await assert.rejects(
    () => listCourses(env(directory), forbidden.fetchImpl),
    (error) => error instanceof SafeError && error.code === "forbidden",
  );
  assert.equal(fs.existsSync(file), true);

  const unauthorized = scriptedFetch([() => new Response(null, { status: 401 })]);
  await assert.rejects(
    () => listCourses(env(directory), unauthorized.fetchImpl),
    (error) => error instanceof SafeError && error.code === "unauthorized",
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(unauthorized.calls[0].authorizationMatches(token), true);
});

test("refuses an instructor token and a cross-origin redirect without following it", async () => {
  const directory = tempDir();
  const file = path.join(directory, "session.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: "art_pat_example" }),
  );
  const blocked = scriptedFetch([]);
  await assert.rejects(
    () => listCourses(env(directory), blocked.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_student_session" && !error.message.includes("art_pat_example"),
  );
  assert.equal(blocked.calls.length, 0);

  const token = fakeJwt(4_102_444_800);
  fs.writeFileSync(file, JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }));
  const redirect = scriptedFetch([
    () => new Response(null, { status: 302, headers: { location: "https://off-origin.test/collect?code=LEAKMARKER" } }),
  ]);
  await assert.rejects(
    () => listCourses(env(directory), redirect.fetchImpl),
    (error) => error instanceof SafeError && error.code === "redirect" && !error.message.includes("LEAKMARKER") && !error.message.includes("off-origin"),
  );
  assert.equal(redirect.calls.length, 1);
  assert.equal(new URL(redirect.calls[0].href).origin, "https://artemis.test");
});

test("follows a same-origin redirect and keeps the session on that origin", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }),
  );
  const script = scriptedFetch([
    () => new Response(null, { status: 302, headers: { location: "/api/course/courses/for-dashboard" } }),
    () => jsonResponse(200, dashboardBody()),
  ]);
  const courses = await listCourses(env(directory), script.fetchImpl);
  assert.equal(courses.length, 2);
  assert.equal(script.calls.length, 2);
  assert.equal(script.calls[1].authorizationMatches(token), true);
  assert.equal(new URL(script.calls[1].href).origin, "https://artemis.test");
});

test("logout clears the local session and does not print the token", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const file = path.join(directory, "session.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }));
  const script = scriptedFetch([() => new Response(null, { status: 200 })]);
  await logout(env(directory), script.fetchImpl);
  assert.equal(fs.existsSync(file), false);
  assert.equal(script.calls.length, 1);
  assert.equal(script.calls[0].authorizationMatches(token), true);
  assert.equal(new URL(script.calls[0].href).pathname, "/api/core/public/logout");
});

test("does not call the network for a username Artemis would reject", async () => {
  const directory = tempDir();
  const script = scriptedFetch([]);
  await assert.rejects(
    () => listCourses(env(directory, { ARTEMIS_USERNAME: "bad name", ARTEMIS_PASSWORD: PASSWORD }), script.fetchImpl),
    (error) => error instanceof SafeError && error.code === "invalid_username",
  );
  assert.equal(script.calls.length, 0);
});
