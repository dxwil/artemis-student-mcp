import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { createAccessToken, revokeAccessToken, userDirectory } from "../src/access.js";
import { MAX_HTTP_BODY_BYTES, startHttpServer } from "../src/http-server.js";
import { saveSession } from "../src/session.js";
import { assertClean, dashboardBody, fakeJwt, jsonResponse, PASSWORD, tempDir, USERNAME } from "./support.js";

const root = path.resolve(".");
const serverBin = path.join(root, "bin/artemis-student-mcp");
const ACCEPT = "application/json, text/event-stream";

function initMessage(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  };
}

function childEnv(directory, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ARTEMIS_MCP_STATE_DIR: directory,
    ARTEMIS_BASE_URL: "https://artemis.test",
    ...extra,
  };
}

function routingFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    let password = false;
    if (init.body) {
      try {
        password = JSON.parse(init.body).password === PASSWORD;
      } catch {
        password = String(init.body).includes(PASSWORD);
      }
    }
    calls.push({
      path: parsed.pathname,
      method: init.method ?? "GET",
      authorization: init.headers?.Authorization ?? "",
      password,
    });
    if (parsed.pathname === "/api/course/courses/for-dashboard") {
      return jsonResponse(200, dashboardBody());
    }
    if (parsed.pathname === "/api/notification/courses/7/status") {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

async function rpc(base, { token, session, message, accept = ACCEPT, headers = {}, path: requestPath = "/mcp" }) {
  const response = await fetch(`${base}${requestPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? { "mcp-session-id": session } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  let json = null;
  if (text !== "" && type.includes("application/json")) {
    json = JSON.parse(text);
  }
  return { status: response.status, json, text, session: response.headers.get("mcp-session-id") };
}

function toolResult(response) {
  assert.equal(response.status, 200);
  return JSON.parse(response.json.result.content[0].text);
}

async function closeServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}

test("the request body limit matches the 8 MB upload cap", () => {
  assert.equal(MAX_HTTP_BODY_BYTES, 8 * 1024 * 1024);
});

test("http transport lists tools, isolates confirmation tokens, and rejects bad auth", async () => {
  const directory = tempDir();
  const alpha = createAccessToken(directory, { label: "alpha" });
  const beta = createAccessToken(directory, { label: "beta" });
  const gamma = createAccessToken(directory, { label: "gamma" });
  const jwtA = fakeJwt(4_102_444_800);
  const jwtB = fakeJwt(4_102_444_900);
  saveSession(path.join(userDirectory(directory, alpha.userId), "session.json"), {
    origin: "https://artemis.test",
    accessToken: jwtA,
    obtainedAt: "2026-01-01T00:00:00.000Z",
    strategy: "password",
  });
  saveSession(path.join(userDirectory(directory, beta.userId), "session.json"), {
    origin: "https://artemis.test",
    accessToken: jwtB,
    obtainedAt: "2026-01-01T00:00:00.000Z",
    strategy: "password",
  });
  const logs = [];
  const route = routingFetch();
  const server = await startHttpServer({
    env: {
      ARTEMIS_MCP_STATE_DIR: directory,
      ARTEMIS_BASE_URL: "https://artemis.test",
      PLUGIN_ROOT: root,
      ARTEMIS_USERNAME: USERNAME,
      ARTEMIS_PASSWORD: PASSWORD,
    },
    fetchImpl: route.fetchImpl,
    host: "127.0.0.1",
    port: 0,
    log(line) {
      logs.push(line);
    },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const texts = [];
  try {
    const health = await fetch(`${base}/healthz`);
    texts.push(await health.text());
    assert.equal(health.status, 200);
    assert.equal(texts[0], '{"ok":true}');

    const missing = await rpc(base, { message: initMessage() });
    texts.push(missing.text);
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error, "unauthorized");
    assert.equal(missing.session, null);

    const wrong = await rpc(base, { token: "asm_not-valid", message: initMessage() });
    texts.push(wrong.text);
    assert.equal(wrong.status, 401);

    const alphaInit = await rpc(base, { token: alpha.token, message: initMessage() });
    texts.push(alphaInit.text);
    assert.equal(alphaInit.status, 200);
    assert.equal(alphaInit.json.result.protocolVersion, "2025-06-18");
    assert.equal(alphaInit.json.result.serverInfo.name, "artemis-student");
    assert.match(alphaInit.session, /^[a-f0-9]{64}$/);

    const noted = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: { jsonrpc: "2.0", method: "notifications/initialized" },
      headers: { "mcp-protocol-version": "2025-06-18" },
    });
    texts.push(noted.text);
    assert.equal(noted.status, 202);
    assert.equal(noted.text, "");

    const tools = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers: { "mcp-protocol-version": "2025-06-18" },
    });
    texts.push(tools.text);
    assert.equal(tools.json.result.tools.some((tool) => tool.name === "list_courses"), true);
    assert.equal(tools.json.result.tools.some((tool) => tool.name === "mark_notifications_read"), true);

    const courses = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_courses", arguments: {} } },
    });
    texts.push(courses.text);
    assert.equal(courses.json.result.isError, false);
    assert.equal(toolResult(courses).courses[0].shortName, "ds");

    const betaInit = await rpc(base, { token: beta.token, message: initMessage(8) });
    texts.push(betaInit.text);
    const betaCourses = await rpc(base, {
      token: beta.token,
      session: betaInit.session,
      message: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_courses", arguments: {} } },
    });
    texts.push(betaCourses.text);
    assert.equal(toolResult(betaCourses).courses.length, 2);
    const dashboards = route.calls.filter((call) => call.path === "/api/course/courses/for-dashboard");
    assert.equal(dashboards.some((call) => call.authorization === `Bearer ${jwtA}`), true);
    assert.equal(dashboards.some((call) => call.authorization === `Bearer ${jwtB}`), true);

    const gammaInit = await rpc(base, { token: gamma.token, message: initMessage(11) });
    texts.push(gammaInit.text);
    const unsigned = await rpc(base, {
      token: gamma.token,
      session: gammaInit.session,
      message: { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "list_courses", arguments: {} } },
    });
    texts.push(unsigned.text);
    assert.equal(unsigned.json.result.isError, true);
    assert.equal(toolResult(unsigned).error, "not_configured");
    assert.equal(route.calls.some((call) => call.password), false);

    const preview = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "mark_notifications_read", arguments: { courseId: 7, notificationIds: [4] } },
      },
    });
    texts.push(preview.text);
    const previewBody = toolResult(preview);
    assert.equal(previewBody.preview.action, "mark_notifications_read");
    const confirmation = previewBody.confirmationToken;
    assert.match(confirmation, /^[a-f0-9]{64}$/);
    const fileA = path.join(userDirectory(directory, alpha.userId), "write-confirmations.json");
    const fileB = path.join(userDirectory(directory, beta.userId), "write-confirmations.json");
    assert.equal(fs.readFileSync(fileA, "utf8").includes(confirmation), true);
    assert.equal(fs.existsSync(fileB), false);

    const stolen = await rpc(base, {
      token: beta.token,
      session: betaInit.session,
      message: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "mark_notifications_read",
          arguments: { courseId: 7, notificationIds: [4], confirmationToken: confirmation },
        },
      },
    });
    texts.push(stolen.text);
    assert.equal(stolen.json.result.isError, true);
    assert.equal(toolResult(stolen).error, "confirmation_required");
    assert.equal(route.calls.some((call) => call.method === "PUT"), false);

    const committed = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "mark_notifications_read",
          arguments: { courseId: 7, notificationIds: [4], confirmationToken: confirmation },
        },
      },
    });
    texts.push(committed.text);
    assert.equal(toolResult(committed).marked, 1);
    const puts = route.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].authorization, `Bearer ${jwtA}`);

    const crossed = await rpc(base, {
      token: beta.token,
      session: alphaInit.session,
      message: { jsonrpc: "2.0", id: 7, method: "tools/list" },
    });
    texts.push(crossed.text);
    assert.equal(crossed.status, 404);
    const still = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: { jsonrpc: "2.0", id: 13, method: "tools/list" },
    });
    texts.push(still.text);
    assert.equal(still.status, 200);

    const evil = await rpc(base, {
      token: alpha.token,
      message: initMessage(14),
      headers: { origin: "https://evil.example" },
    });
    texts.push(evil.text);
    assert.equal(evil.status, 403);

    const queried = await fetch(`${base}/mcp?access_token=${encodeURIComponent(alpha.token)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alpha.token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage(15)),
    });
    const queriedText = await queried.text();
    texts.push(queriedText);
    assert.equal(queried.status, 400);
    assert.equal(queriedText.includes(alpha.token), false);

    const listening = await fetch(`${base}/mcp`, {
      method: "GET",
      headers: { authorization: `Bearer ${alpha.token}`, accept: "text/event-stream", "mcp-session-id": alphaInit.session },
    });
    texts.push(await listening.text());
    assert.equal(listening.status, 405);

    const oldVersion = await rpc(base, {
      token: alpha.token,
      session: alphaInit.session,
      message: { jsonrpc: "2.0", id: 16, method: "tools/list" },
      headers: { "mcp-protocol-version": "1999-01-01" },
    });
    texts.push(oldVersion.text);
    assert.equal(oldVersion.status, 400);

    const removed = await fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${beta.token}`, "mcp-session-id": betaInit.session },
    });
    assert.equal(removed.status, 204);
    const gone = await rpc(base, {
      token: beta.token,
      session: betaInit.session,
      message: { jsonrpc: "2.0", id: 17, method: "tools/list" },
    });
    texts.push(gone.text);
    assert.equal(gone.status, 404);

    const sse = await rpc(base, {
      token: beta.token,
      message: initMessage(18),
      accept: "text/event-stream",
    });
    texts.push(sse.text);
    assert.equal(sse.status, 200);
    assert.match(sse.text, /^event: message\ndata: /);
    assert.equal(JSON.parse(sse.text.slice("event: message\ndata: ".length).trim()).result.serverInfo.name, "artemis-student");

    revokeAccessToken(directory, alpha.id);
    const revoked = await rpc(base, { token: alpha.token, session: alphaInit.session, message: { jsonrpc: "2.0", id: 19, method: "tools/list" } });
    texts.push(revoked.text);
    assert.equal(revoked.status, 401);

    const hidden = await fetch(`${base}/${alpha.token}`);
    texts.push(await hidden.text());
    assert.equal(hidden.status, 404);
  } finally {
    await closeServer(server);
  }

  const combined = `${texts.join("\n")}\n${logs.join("")}`;
  assertClean(combined, [PASSWORD, alpha.token, beta.token, gamma.token, jwtA, jwtB, "GRADE_MARKER_125", "DESCRIPTION_MARKER"]);
  assert.equal(logs.some((line) => line.includes("?")), false);
});

test("auth failures are rate limited and oversized bodies are refused", async () => {
  const directory = tempDir();
  const created = createAccessToken(directory, { label: "limit" });
  const server = await startHttpServer({
    env: { ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_BASE_URL: "https://artemis.test" },
    host: "127.0.0.1",
    port: 0,
    authFailureLimit: 2,
    log() {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await rpc(base, { token: "asm_wrong-one", message: initMessage() });
    const second = await rpc(base, { token: "asm_wrong-two", message: initMessage() });
    const third = await rpc(base, { token: "asm_wrong-three", message: initMessage() });
    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(third.status, 429);
    assert.equal(third.json.error, "rate_limited");
    const retry = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer asm_wrong-four", "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(initMessage()),
    });
    assert.equal(retry.status, 429);
    assert.equal(Number(retry.headers.get("retry-after")) > 0, true);
    const allowed = await rpc(base, { token: created.token, message: initMessage() });
    assert.equal(allowed.status, 200);
    const plain = await rpc(base, {
      token: created.token,
      message: initMessage(),
      headers: { "content-type": "text/plain" },
    });
    assert.equal(plain.status, 415);
    const batch = await rpc(base, { token: created.token, message: [initMessage()] });
    assert.equal(batch.status, 400);
  } finally {
    await closeServer(server);
  }

  const limited = await startHttpServer({
    env: { ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_BASE_URL: "https://artemis.test" },
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: 64,
    log() {},
  });
  try {
    const oversized = await fetch(`http://127.0.0.1:${limited.address().port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { note: "x".repeat(80) } }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.text()).includes(created.token), false);
  } finally {
    await closeServer(limited);
  }
});

test("a configured public host is accepted and any other host is refused", async () => {
  const directory = tempDir();
  const created = createAccessToken(directory, { label: "edge" });
  const server = await startHttpServer({
    env: {
      ARTEMIS_MCP_STATE_DIR: directory,
      ARTEMIS_BASE_URL: "https://artemis.test",
      ARTEMIS_MCP_PUBLIC_URL: "https://mcp.example.com",
    },
    host: "127.0.0.1",
    port: 0,
    log() {},
  });
  const port = server.address().port;
  try {
    const good = await rawRequest({
      port,
      path: "/mcp",
      headers: {
        host: "mcp.example.com",
        origin: "https://mcp.example.com",
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    assert.equal(good.status, 200);
    const bad = await rawRequest({
      port,
      path: "/mcp",
      headers: {
        host: "evil.example",
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.includes(created.token), false);
  } finally {
    await closeServer(server);
  }
});

test("the bin serves initialize and tools/list only with a bearer token", async () => {
  const directory = tempDir();
  const created = spawn(process.execPath, [serverBin, "token", "create", "--label", "smoke"], {
    env: childEnv(directory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const createdOut = await readAll(created);
  assert.equal(createdOut.code, 0);
  const token = createdOut.stdout.match(/^token: (asm_\S+)$/m)?.[1];
  assert.equal(typeof token, "string");
  assert.equal(createdOut.stderr.includes(token), false);
  const child = spawn(process.execPath, [serverBin, "--http", "--port", "0"], {
    env: childEnv(directory),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not listen")), 5000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  try {
    const port = await ready;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const denied = await rpc(`http://127.0.0.1:${port}`, { message: initMessage() });
    assert.equal(denied.status, 401);
    const opened = await rpc(`http://127.0.0.1:${port}`, { token, message: initMessage() });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.result.protocolVersion, "2025-06-18");
    const tools = await rpc(`http://127.0.0.1:${port}`, {
      token,
      session: opened.session,
      message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    assert.equal(tools.status, 200);
    assert.equal(tools.json.result.tools.some((tool) => tool.name === "list_courses"), true);
    assert.equal(stdout, "");
    assert.equal(stderr.includes(token), false);
    assertClean(`${denied.text}\n${opened.text}\n${tools.text}`, [token, PASSWORD]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));
  }
});

test("--stdio still speaks JSON-RPC when the http transport is configured", async () => {
  const directory = tempDir();
  const child = spawn(process.execPath, [serverBin, "--stdio"], {
    env: childEnv(directory, { ARTEMIS_MCP_TRANSPORT: "http" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  const line = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stdio did not answer")), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const index = stdout.indexOf("\n");
      if (index >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(stdout.slice(0, index)));
      }
    });
  });
  child.stdin.write(`${JSON.stringify(initMessage())}\n`);
  const response = await line;
  child.stdin.end();
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(stdout.includes("listening"), false);
  await new Promise((resolve) => child.once("close", resolve));
});

function rawRequest({ port, path: requestPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function readAll(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("command timed out")), 5000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
