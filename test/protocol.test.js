import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertClean, fakeJwt, PASSWORD, tempDir, USERNAME } from "./support.js";

const root = path.resolve(".");
const preload = pathToFileURL(path.join(root, "test/preload.mjs")).href;
const serverBin = path.join(root, "bin/artemis-student-mcp");
const authBin = path.join(root, "bin/artemis-student-auth");

function spawnNode(script, env) {
  const child = spawn(process.execPath, ["--import", preload, script], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const lines = [];
  let pending = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        lines.push(line);
      }
      index = pending.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    request(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a response")), 3000);
        const deliver = (line) => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("response was not valid JSON"));
          }
        };
        if (lines.length > 0) {
          deliver(lines.shift());
        } else {
          waiters.push(deliver);
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    notify(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      child.stdin.end();
      const code = await new Promise((resolve) => child.on("close", resolve));
      return { code, stdout, stderr };
    },
  };
}

function baseEnv(directory, scenario, extra = {}) {
  const trace = path.join(directory, "trace.json");
  return {
    env: {
      ARTEMIS_MOCK_SCENARIO: scenario,
      ARTEMIS_MOCK_TRACE: trace,
      ARTEMIS_BASE_URL: "https://artemis.test",
      PLUGIN_DATA: directory,
      PLUGIN_ROOT: root,
      ...extra,
    },
    trace,
  };
}

async function handshake(client) {
  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  client.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  return { initialized, tools };
}

test("stdio handshake lists only list_courses and returns normalized courses", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const { env, trace } = baseEnv(directory, "password-success", {
    ARTEMIS_USERNAME: USERNAME,
    ARTEMIS_PASSWORD: PASSWORD,
    ARTEMIS_SESSION_TOKEN: token,
  });
  const client = spawnNode(serverBin, env);
  const { initialized, tools } = await handshake(client);
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  assert.equal(initialized.result.serverInfo.name, "artemis-student");
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ["list_courses", "list_exercises", "get_exercise", "list_lectures", "get_lecture", "list_announcements", "list_results", "get_feedback", "list_calendar", "list_exams", "get_exam_result", "list_conversations", "list_messages", "download_attachment",
    "list_tutorial_groups",
    "list_competencies",
    "get_learning_path",
    "list_faqs",
    "list_notifications",
    "mark_notifications_read",
    "mark_conversation_read",
    "create_post",
    "reply_to_post",
    "submit_text",
    "submit_file",
    "submit_quiz",
  ],
  );
  assert.equal(tools.result.tools[0].annotations.readOnlyHint, true);
  const markRead = tools.result.tools.find((tool) => tool.name === "mark_conversation_read");
  assert.equal(markRead.annotations.readOnlyHint, false);
  assert.equal(markRead.annotations.destructiveHint, true);
  const createPost = tools.result.tools.find((tool) => tool.name === "create_post");
  assert.equal(createPost.annotations.readOnlyHint, false);
  assert.equal(createPost.annotations.destructiveHint, false);
  assert.equal(tools.result.tools[0].inputSchema.additionalProperties, false);
  const called = await client.request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_courses", arguments: {} },
  });
  const finished = await client.close();
  assert.equal(called.result.isError, false);
  assert.deepEqual(JSON.parse(called.result.content[0].text), {
    courses: [
      { id: 3, title: "Discrete Structures", shortName: "ds", startDate: null, endDate: "2027-02-01T00:00:00Z" },
      {
        id: 7,
        title: "Introduction to Informatics",
        shortName: "info1",
        startDate: "2026-10-01T00:00:00+02:00",
        endDate: null,
      },
    ],
  });
  const calls = JSON.parse(fs.readFileSync(trace, "utf8"));
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/core/public/login-options", "/api/core/public/authenticate", "/api/course/courses/for-dashboard"],
  );
  assert.equal(calls.every((call) => call.origin === "https://artemis.test" && call.hasUserAgent), true);
  assert.equal(calls[1].hasPassword, true);
  assert.equal(calls[2].hasAuthorization, true);
  assertClean(finished.stdout, [PASSWORD, token, "GRADE_MARKER_125", "EXERCISE_MARKER", "EXAM_MARKER", "DESCRIPTION_MARKER"]);
  assertClean(finished.stderr, [PASSWORD, token]);
  assert.equal(finished.code, 0);
});

test("an unknown protocol version falls back and single sign-on never sends the password", async () => {
  const directory = tempDir();
  const { env, trace } = baseEnv(directory, "sso-oidc", {
    ARTEMIS_USERNAME: USERNAME,
    ARTEMIS_PASSWORD: PASSWORD,
  });
  const client = spawnNode(serverBin, env);
  const initialized = await client.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  const called = await client.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_courses" },
  });
  const finished = await client.close();
  assert.equal(called.result.isError, true);
  const body = JSON.parse(called.result.content[0].text);
  assert.equal(body.error, "sso_required");
  const calls = JSON.parse(fs.readFileSync(trace, "utf8"));
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/core/public/login-options", "/management/info"],
  );
  assert.equal(calls.every((call) => call.hasPassword === false), true);
  assertClean(finished.stdout + finished.stderr, [PASSWORD, "INFO_SECRET_MARKER"]);
});

test("directory password login runs when public info lists ldap", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const { env, trace } = baseEnv(directory, "directory-password", {
    ARTEMIS_USERNAME: USERNAME,
    ARTEMIS_PASSWORD: PASSWORD,
    ARTEMIS_SESSION_TOKEN: token,
    ARTEMIS_PROFILE: "tum",
  });
  const client = spawnNode(serverBin, env);
  await handshake(client);
  const called = await client.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_courses" } });
  const finished = await client.close();
  assert.equal(called.result.isError, false);
  assert.equal(JSON.parse(called.result.content[0].text).courses[0].shortName, "ds");
  const calls = JSON.parse(fs.readFileSync(trace, "utf8"));
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/core/public/login-options", "/management/info", "/api/core/public/authenticate", "/api/course/courses/for-dashboard"],
  );
  assert.equal(calls[2].hasPassword, true);
  assert.equal(calls.every((call) => call.origin === "https://artemis.test"), true);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
  assert.equal(stored.strategy, "directory-password");
  assertClean(finished.stdout + finished.stderr, [PASSWORD, token, "INFO_SECRET_MARKER", "GRADE_MARKER_125"]);
});

test("wrong password, forbidden, malformed, and off-origin redirect stay inside tool errors", async () => {
  const token = fakeJwt(4_102_444_800);
  const cases = [
    ["wrong-password", { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }, "unauthorized", ["/api/core/public/login-options", "/api/core/public/authenticate"]],
    ["forbidden", {}, "forbidden", ["/api/course/courses/for-dashboard"]],
    ["malformed", {}, "malformed", ["/api/course/courses/for-dashboard"]],
    ["redirect", {}, "redirect", ["/api/course/courses/for-dashboard"]],
  ];
  for (const [scenario, extra, code, paths] of cases) {
    const directory = tempDir();
    if (!extra.ARTEMIS_PASSWORD) {
      fs.writeFileSync(
        path.join(directory, "session.json"),
        JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }),
      );
    }
    const { env, trace } = baseEnv(directory, scenario, extra);
    const client = spawnNode(serverBin, env);
    await handshake(client);
    const called = await client.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_courses" } });
    const finished = await client.close();
    const body = JSON.parse(called.result.content[0].text);
    assert.equal(called.result.isError, true);
    assert.equal(body.error, code);
    assert.deepEqual(JSON.parse(fs.readFileSync(trace, "utf8")).map((call) => call.path), paths);
    assertClean(finished.stdout + finished.stderr, [PASSWORD, token, "LEAKMARKER", "off-origin.test"]);
  }
});

test("a password passed as a tool argument is rejected and not echoed", async () => {
  const directory = tempDir();
  const { env, trace } = baseEnv(directory, "password-success", {
    ARTEMIS_USERNAME: USERNAME,
    ARTEMIS_PASSWORD: PASSWORD,
  });
  const client = spawnNode(serverBin, env);
  const early = await client.request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_courses" } });
  assert.equal(early.error.code, -32002);
  await handshake(client);
  const called = await client.request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list_courses", arguments: { password: PASSWORD } },
  });
  const finished = await client.close();
  assert.equal(called.result.isError, true);
  assert.equal(JSON.parse(called.result.content[0].text).error, "invalid_arguments");
  const calls = fs.existsSync(trace) ? JSON.parse(fs.readFileSync(trace, "utf8")) : [];
  assert.deepEqual(calls, []);
  assertClean(finished.stdout + finished.stderr, [PASSWORD]);
});

test("read-only exercise and lecture tools answer over stdio", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }),
    { mode: 0o600 },
  );
  const { env, trace } = baseEnv(directory, "student-content", { ARTEMIS_SESSION_TOKEN: token });
  delete env.ARTEMIS_PASSWORD;
  env.NODE_OPTIONS = `--import ${preload}`;
  const exercises = await runAuth(env, ["exercises", "7"]);
  const exercise = await runAuth(env, ["exercise", "3"]);
  const lectures = await runAuth(env, ["lectures", "7"]);
  const lecture = await runAuth(env, ["lecture", "4"]);
  assert.equal(exercises.code, 0);
  assert.equal(exercises.stdout, "exercises: 1\n");
  assert.equal(exercise.stdout, "exercise: 3\nstatement: yes\ndeadlines: releaseDate,dueDate\n");
  assert.equal(lectures.stdout, "lectures: 1\n");
  assert.equal(lecture.stdout, "lecture: 4\nmaterials: 1\n");
  const calls = JSON.parse(fs.readFileSync(trace, "utf8"));
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.some((call) => call.path.includes("completion")), false);
  const output = [exercises, exercise, lectures, lecture].map((item) => item.stdout + item.stderr).join("\n");
  assertClean(output, [token, "SECRET_SOLUTION", "GRADE_MARKER", "Essay", "Write an essay", "draft.pdf"]);
});

test("every student read answers over tools/call and stays on GET", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token }),
    { mode: 0o600 },
  );
  const { env, trace } = baseEnv(directory, "student-content", { ARTEMIS_SESSION_TOKEN: token });
  delete env.ARTEMIS_PASSWORD;
  const client = spawnNode(serverBin, env);
  await handshake(client);
  const calls = [
    ["list_announcements", { courseId: 7, page: 0 }, "announcements"],
    ["list_results", { courseId: 7 }, "results"],
    ["get_feedback", { participationId: 11, resultId: 12 }, "feedback"],
    ["list_calendar", { courseId: 7, month: "2026-11" }, "events"],
    ["list_exams", { courseId: 7 }, "exams"],
    ["get_exam_result", { courseId: 7, examId: 5, studentExamId: 6 }, "examResult"],
    ["list_conversations", { courseId: 7 }, "conversations"],
    ["list_messages", { courseId: 7, conversationId: 9, page: 0 }, "messages"],
    ["download_attachment", { lectureId: 4, unitId: 1 }, "download"],
    ["list_tutorial_groups", { courseId: 7 }, "tutorialGroups"],
    ["list_competencies", { courseId: 7 }, "competencies"],
    ["get_learning_path", { courseId: 7 }, "learningPath"],
    ["list_faqs", { courseId: 7 }, "faqs"],
    ["list_notifications", { courseId: 7, page: 0 }, "notifications"],
  ];
  for (const [name, args, key] of calls) {
    const response = await client.request({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response.result.isError, false, name);
    const body = JSON.parse(response.result.content[0].text);
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), true, name);
    assert.equal(JSON.stringify(body).includes("student1"), false, name);
    assert.equal(JSON.stringify(body).includes("ada@example.edu"), false, name);
    assert.equal(JSON.stringify(body).includes("other@example.edu"), false, name);
    assert.equal(JSON.stringify(body).includes("secret-faq"), false, name);
    assert.equal(JSON.stringify(body).includes("hidden-text"), false, name);
  }
  const finished = await client.close();
  const recorded = JSON.parse(fs.readFileSync(trace, "utf8"));
  assert.equal(recorded.every((call) => call.method === "GET"), true);
  assert.equal(recorded.some((call) => /mark-as-read|completion|own-student-exam|status|seen|archive/.test(call.path)), false);
  const savedName = fs.readdirSync(path.join(directory, "downloads", "4")).find((name) => name.endsWith("-slides.pdf"));
  assert.equal(fs.readFileSync(path.join(directory, "downloads", "4", savedName), "utf8"), "pdf-bytes");
  assert.equal(finished.code, 0);
});

test("courses prints a count and shows summaries only with --show", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: token, strategy: "directory-password" }),
    { mode: 0o600 },
  );
  const { env } = baseEnv(directory, "password-success", { ARTEMIS_SESSION_TOKEN: token });
  delete env.ARTEMIS_PASSWORD;
  env.NODE_OPTIONS = `--import ${preload}`;
  const counted = await runAuth(env, ["courses"]);
  assert.equal(counted.code, 0);
  assert.equal(counted.stdout, "courses: 2\n");
  assertClean(counted.stdout + counted.stderr, [token, PASSWORD, "Introduction", "info1", "GRADE_MARKER_125"]);
  const shown = await runAuth(env, ["courses", "--show"]);
  assert.equal(shown.code, 0);
  assert.equal(shown.stdout.startsWith("courses: 2\n"), true);
  assert.equal(shown.stdout.includes("info1"), true);
  assertClean(shown.stdout + shown.stderr, [token, PASSWORD, "GRADE_MARKER_125", "DESCRIPTION_MARKER", "EXAM_MARKER"]);
});

async function runAuth(env, args) {
  const child = spawn(process.execPath, [authBin, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

test("login command stores a private session and refuses single sign-on before sending a password", async () => {
  const directory = tempDir();
  const token = fakeJwt(4_102_444_800);
  const success = baseEnv(directory, "password-success", {
    ARTEMIS_USERNAME: USERNAME,
    ARTEMIS_PASSWORD: PASSWORD,
    ARTEMIS_SESSION_TOKEN: token,
  });
  success.env.NODE_OPTIONS = `--import ${preload}`;
  const loggedIn = spawn(process.execPath, ["--import", preload, authBin, "login"], { env: success.env, stdio: ["pipe", "pipe", "pipe"] });
  loggedIn.stdin.end();
  let stdout = "";
  let stderr = "";
  loggedIn.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  loggedIn.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => loggedIn.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(stdout, "courses: 2\n");
  assert.equal(stdout.includes("Introduction"), false);
  assertClean(stdout + stderr, [PASSWORD, token, "GRADE_MARKER_125", "DESCRIPTION_MARKER"]);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, "session.json"), "utf8"));
  assert.equal(stored.accessToken === token, true);
  assert.equal(fs.statSync(path.join(directory, "session.json")).mode & 0o077, 0);

  const ssoDir = tempDir();
  const sso = baseEnv(ssoDir, "sso-oidc", { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD });
  const refused = spawn(process.execPath, ["--import", preload, authBin, "login"], { env: sso.env, stdio: ["pipe", "pipe", "pipe"] });
  refused.stdin.end();
  let refusedErr = "";
  refused.stderr.on("data", (chunk) => {
    refusedErr += chunk;
  });
  const refusedCode = await new Promise((resolve) => refused.on("close", resolve));
  assert.equal(refusedCode, 2);
  assert.equal(fs.existsSync(path.join(ssoDir, "session.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(sso.trace, "utf8")).some((call) => call.path.endsWith("/authenticate")), false);
  assertClean(refusedErr, [PASSWORD]);
});
