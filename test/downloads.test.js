import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAccessToken, revokeAccessToken, userDirectory } from "../src/access.js";
import { reviewStoredPath } from "../src/download-desk.js";
import { downloadAttachment, downloadFile } from "../src/downloads.js";
import { createMcpHandler } from "../src/mcp.js";
import { SafeError } from "../src/errors.js";
import { startHttpServer } from "../src/http-server.js";
import { saveSession } from "../src/session.js";
import { fakeJwt, jsonResponse, tempDir } from "./support.js";

const ACCEPT = "application/json, text/event-stream";

function env(directory) {
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: fakeJwt(4_102_444_800) }),
    { mode: 0o600 },
  );
  return { ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(".") };
}

function lectureDetails(unitId, filename) {
  return {
    id: 4,
    title: "Week 1",
    course: { id: 7 },
    lectureUnits: [
      {
        id: unitId,
        type: "attachment",
        name: "Slides",
        visibleToStudents: true,
        attachment: {
          id: 21,
          name: "Slides",
          link: `attachments/attachment-video-units/${unitId}/${filename}`,
          attachmentType: "FILE",
          studentVersion: `attachments/attachment-video-units/${unitId}/student/${filename}`,
        },
      },
      { id: 99, type: "attachment", name: "Draft", visibleToStudents: false, attachment: { id: 22, link: "attachments/attachment-video-units/99/draft.pdf" } },
    ],
    attachments: [{ id: 30, name: "Syllabus", link: "attachments/lectures/4/syllabus.pdf", attachmentType: "FILE" }],
  };
}

test("a lecture lookup names the student file and does not fetch its bytes", async () => {
  const directory = tempDir();
  const script = scripted([() => jsonResponse(200, lectureDetails(1, "slides.pdf"))]);
  const saved = await downloadAttachment(env(directory), 4, { unitId: 1 }, script.fetchImpl);
  assert.equal(saved.filename, "slides.pdf");
  assert.equal(saved.mimeType, "application/pdf");
  assert.equal(saved.path, "/api/core/files/attachments/attachment-video-units/1/student/slides.pdf");
  assert.equal(saved.downloadUrl, undefined);
  assert.equal(script.calls.length, 1);
  assert.equal(new URL(script.calls[0].href).pathname.endsWith("/details"), true);
  const blocked = scripted([() => jsonResponse(200, lectureDetails(1, "slides.pdf"))]);
  await assert.rejects(
    () => downloadAttachment(env(directory), 4, { unitId: 99 }, blocked.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_found",
  );
  assert.equal(blocked.calls.length, 1);
});

test("download_file normalizes a path and does not call Artemis", async () => {
  const directory = tempDir();
  const reference = "/api/core/files/courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf";
  const named = await downloadFile(env(directory), `https://artemis.test${reference}`);
  assert.equal(named.path, reference);
  assert.equal(named.mimeType, "application/pdf");
  await assert.rejects(
    () => downloadFile(env(directory), "https://other.test/api/core/files/markdown/a.png"),
    (error) => error instanceof SafeError && error.code === "invalid_arguments",
  );
  assert.throws(
    () => reviewStoredPath("/api/core/files/attachments/attachment-video-units/1/secret.pdf", "https://artemis.test"),
    (error) => error instanceof SafeError && error.code === "invalid_arguments",
  );
});

test("file tools put downloadUrl in the text result when the server can mint one", async () => {
  const file = { name: "sheet.pdf", filename: "sheet.pdf", path: "/api/core/files/markdown/sheet.pdf", mimeType: "application/pdf" };
  let minted = 0;
  const handle = createMcpHandler({
    getExercise: async () => ({ id: 1, problemStatement: "see", files: [{ ...file }] }),
    getLecture: async () => ({ id: 4, materials: [{ ...file }] }),
    listMessages: async () => [{ id: 1, content: "see", files: [{ ...file }], answers: [] }],
    listAnnouncements: async () => [{ id: 1, content: "see", files: [{ ...file }] }],
    downloadFile: async () => ({ ...file }),
    issueDownload: async () => {
      minted += 1;
      return { downloadUrl: `https://mcp.example.com/files/token-${minted}`, expiresAt: "2026-01-01T00:10:00.000Z" };
    },
  });
  await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  for (const [name, args] of [
    ["get_exercise", { exerciseId: 1 }],
    ["get_lecture", { lectureId: 4 }],
    ["list_messages", { courseId: 7, conversationId: 9 }],
    ["list_announcements", { courseId: 7 }],
    ["download_file", { path: file.path }],
  ]) {
    const response = await handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response.result.content.length, 1, name);
    const body = JSON.parse(response.result.content[0].text);
    assert.match(JSON.stringify(body), /https:\/\/mcp\.example\.com\/files\/token-/, name);
    assert.equal(JSON.stringify(body).includes("resource_link"), false, name);
  }
  const stdio = createMcpHandler({ downloadFile: async () => ({ ...file }) });
  await stdio({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const refused = await stdio({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "download_file", arguments: { path: file.path } } });
  assert.equal(JSON.parse(refused.result.content[0].text).error, "http_required");
  const missing = await handle({ jsonrpc: "2.0", id: "resources", method: "resources/read", params: {} });
  assert.equal(missing.error.code, -32601);
});

test("a download URL streams once and a revoked or missing session does not fetch", async () => {
  const directory = tempDir();
  const alpha = createAccessToken(directory, { label: "alpha" });
  const beta = createAccessToken(directory, { label: "beta" });
  const gamma = createAccessToken(directory, { label: "gamma" });
  const jwtA = fakeJwt(4_102_444_800);
  const jwtB = fakeJwt(4_102_444_900);
  const jwtC = fakeJwt(4_102_444_950);
  for (const [user, token] of [[alpha, jwtA], [beta, jwtB], [gamma, jwtC]]) {
    saveSession(path.join(userDirectory(directory, user.userId), "session.json"), {
      origin: "https://artemis.test",
      accessToken: token,
      obtainedAt: "2026-01-01T00:00:00.000Z",
      strategy: "password",
    });
  }
  let releaseSecond;
  const gate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const calls = [];
  const server = await startServer(directory, async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, authorization: init.headers?.Authorization });
    if (parsed.pathname.endsWith("/student/a.pdf")) {
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(Buffer.from("first"));
          await gate;
          controller.enqueue(Buffer.from("-second"));
          controller.close();
        },
      }), { headers: { "content-type": "application/pdf", "content-length": "12" } });
    }
    if (parsed.pathname.endsWith("/student/b.pdf")) {
      return new Response(Buffer.from("file-b"), { headers: { "content-type": "application/pdf", "content-length": "6" } });
    }
    return new Response(null, { status: 404 });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const minted = await mint(base, alpha.token, "/api/core/files/attachments/attachment-video-units/1/student/a.pdf");
    assert.equal(calls.length, 0);
    assert.equal(minted.download.filename, "a.pdf");
    assert.equal(minted.download.mimeType, "application/pdf");
    assert.equal(minted.download.path, "/api/core/files/attachments/attachment-video-units/1/student/a.pdf");
    assert.equal(minted.download.downloadUrl.startsWith("https://mcp.example.com/files/"), true);
    assert.equal(minted.raw.includes("resource_link"), false);
    const local = minted.download.downloadUrl.replace("https://mcp.example.com", base);
    const head = await fetch(local, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(calls.length, 0);
    assert.equal(head.headers.get("content-type"), "application/pdf");
    assert.match(head.headers.get("content-disposition"), /filename="a.pdf"/);
    const response = await fetch(local);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "12");
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString("utf8"), "first");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${jwtA}`);
    releaseSecond();
    const second = await reader.read();
    assert.equal(Buffer.from(second.value).toString("utf8"), "-second");
    await reader.read();
    const again = await fetch(local);
    assert.equal(again.status, 404);
    assert.equal(calls.length, 1);
    const other = await mint(base, beta.token, "/api/core/files/attachments/attachment-video-units/2/student/b.pdf");
    const otherBody = await fetch(other.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(await otherBody.text(), "file-b");
    assert.equal(calls.at(-1).authorization, `Bearer ${jwtB}`);
    const revoked = await mint(base, gamma.token, "/api/core/files/markdown/note.txt");
    revokeAccessToken(directory, gamma.id);
    const gone = await fetch(revoked.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).error, "gone");
    assert.equal(calls.some((call) => call.path.endsWith("/note.txt")), false);
    fs.rmSync(path.join(userDirectory(directory, alpha.userId), "session.json"));
    const unsigned = await mint(base, alpha.token, "/api/core/files/markdown/later.txt");
    const denied = await fetch(unsigned.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, "unauthorized");
    const consumed = await fetch(unsigned.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(consumed.status, 404);
    assert.equal(calls.some((call) => call.path.endsWith("/later.txt")), false);
  } finally {
    releaseSecond();
    await closeServer(server);
  }
});

test("an expired download link is not fetched", async () => {
  const directory = tempDir();
  const alpha = createAccessToken(directory, { label: "alpha" });
  saveSession(path.join(userDirectory(directory, alpha.userId), "session.json"), {
    origin: "https://artemis.test",
    accessToken: fakeJwt(4_102_444_800),
    obtainedAt: "2026-01-01T00:00:00.000Z",
    strategy: "password",
  });
  let now = 1_700_000_000_000;
  const calls = [];
  const server = await startServer(directory, async (url) => {
    calls.push(new URL(String(url)).pathname);
    return new Response(Buffer.from("late"));
  }, () => now);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const minted = await mint(base, alpha.token, "/api/core/files/markdown/late.txt");
    now += 11 * 60 * 1000;
    const expired = await fetch(minted.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(expired.status, 404);
    assert.equal(calls.length, 0);
  } finally {
    await closeServer(server);
  }
});

function startServer(directory, fetchImpl, now) {
  return startHttpServer({
    env: {
      ARTEMIS_MCP_STATE_DIR: directory,
      ARTEMIS_BASE_URL: "https://artemis.test",
      ARTEMIS_MCP_TRANSPORT: "http",
      ARTEMIS_MCP_PUBLIC_URL: "https://mcp.example.com",
      PLUGIN_ROOT: path.resolve("."),
    },
    fetchImpl,
    now,
    host: "127.0.0.1",
    port: 0,
    log() {},
  });
}

async function mint(base, token, filePath) {
  const opened = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: ACCEPT },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });
  const session = opened.headers.get("mcp-session-id");
  const response = await rpc(base, token, session, "tools/call", { name: "download_file", arguments: { path: filePath } });
  assert.equal(response.result.isError, false);
  return { download: JSON.parse(response.result.content[0].text).download, raw: response.result.content[0].text };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function rpc(base, token, session, method, params) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  }).then((response) => response.json());
}

function scripted(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ href: String(url), method: init.method ?? "GET" });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error("unexpected request");
    }
    return handler();
  };
  return { calls, fetchImpl };
}
