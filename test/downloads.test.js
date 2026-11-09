import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAccessToken, userDirectory } from "../src/access.js";
import { downloadAttachment, downloadFile, readStudentFile } from "../src/downloads.js";
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

test("a lecture download is a resource link and does not write the file", async () => {
  const directory = tempDir();
  const script = scripted([() => jsonResponse(200, lectureDetails(1, "slides.pdf"))]);
  const saved = await downloadAttachment(env(directory), 4, { unitId: 1 }, script.fetchImpl);
  assert.equal(saved.filename, "slides.pdf");
  assert.equal(saved.mimeType, "application/pdf");
  assert.equal(saved.uri, "artemis://files/attachments/attachment-video-units/1/student/slides.pdf");
  assert.equal(saved.absolutePath, undefined);
  assert.equal(script.calls.length, 1);
  assert.equal(new URL(script.calls[0].href).pathname.endsWith("/details"), true);
  assert.equal(fs.existsSync(path.join(directory, "downloads")), false);
  const blocked = scripted([() => jsonResponse(200, lectureDetails(1, "slides.pdf"))]);
  await assert.rejects(
    () => downloadAttachment(env(directory), 4, { unitId: 99 }, blocked.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_found",
  );
  assert.equal(blocked.calls.length, 1);
});

test("download_file names an announcement file and resources/read fetches it live", async () => {
  const directory = tempDir();
  const reference = "/api/core/files/courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf";
  const named = await downloadFile(env(directory), `https://artemis.test${reference}`, scripted([]).fetchImpl);
  assert.equal(named.path, reference);
  assert.equal(named.uri, "artemis://files/courses/585/conversations/32119/FoP-SES01-Time-Allocation.pdf");
  const script = scripted([() => new Response(Buffer.from("announcement-pdf")), () => new Response(Buffer.from("note"))]);
  const read = await readStudentFile(env(directory), named.uri, script.fetchImpl);
  assert.equal(read.mimeType, "application/pdf");
  assert.equal(read.size, "announcement-pdf".length);
  assert.equal(Buffer.from(read.blob, "base64").toString("utf8"), "announcement-pdf");
  assert.equal(read.text, undefined);
  assert.equal(new URL(script.calls[0].href).pathname, reference);
  const note = await readStudentFile(env(directory), "artemis://files/markdown/note.txt", script.fetchImpl);
  assert.equal(note.text, "note");
  assert.equal(note.blob, undefined);
  await assert.rejects(
    () => downloadFile(env(directory), "https://other.test/api/core/files/markdown/a.png", scripted([]).fetchImpl),
    (error) => error instanceof SafeError && error.code === "invalid_arguments",
  );
  const refused = scripted([]);
  await assert.rejects(
    () => readStudentFile(env(directory), "artemis://files/%2e%2e/secret.pdf", refused.fetchImpl),
    (error) => error instanceof SafeError && error.code === "invalid_arguments",
  );
  assert.equal(refused.calls.length, 0);
  await assert.rejects(
    () => readStudentFile({ ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_ROOT: path.resolve(".") }, named.uri, scripted([]).fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_configured",
  );
});

test("tools expose resource links and an http read uses that caller's session", async () => {
  const uri = "artemis://files/markdown/sheet.pdf";
  const file = { name: "sheet.pdf", filename: "sheet.pdf", path: "/api/core/files/markdown/sheet.pdf", uri, mimeType: "application/pdf" };
  const handle = createMcpHandler({
    getExercise: async () => ({ id: 1, problemStatement: "see", files: [file] }),
    getLecture: async () => ({ id: 4, materials: [file] }),
    listMessages: async () => [{ id: 1, content: "see", files: [file], answers: [] }],
    listAnnouncements: async () => [{ id: 1, content: "see", files: [file] }],
  });
  await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  for (const [name, args] of [
    ["get_exercise", { exerciseId: 1 }],
    ["get_lecture", { lectureId: 4 }],
    ["list_messages", { courseId: 7, conversationId: 9 }],
    ["list_announcements", { courseId: 7 }],
  ]) {
    const response = await handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    const link = response.result.content.find((item) => item.type === "resource_link");
    assert.equal(link.uri, uri, name);
    assert.equal(link.name, "sheet.pdf", name);
    assert.equal(link.mimeType, "application/pdf", name);
    assert.equal(response.result.content.some((item) => item.type === "resource" || item.blob), false, name);
  }
  const listed = await handle({ jsonrpc: "2.0", id: "list", method: "resources/list" });
  assert.deepEqual(listed.result.resources, []);
  const templates = await handle({ jsonrpc: "2.0", id: "templates", method: "resources/templates/list" });
  assert.equal(templates.result.resourceTemplates[0].uriTemplate, "artemis://files/{+path}");
});

test("http resources/read fetches live for that user and /files is gone", async () => {
  const directory = tempDir();
  const alpha = createAccessToken(directory, { label: "alpha" });
  const beta = createAccessToken(directory, { label: "beta" });
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
  const server = await startHttpServer({
    env: {
      ARTEMIS_MCP_STATE_DIR: directory,
      ARTEMIS_BASE_URL: "https://artemis.test",
      ARTEMIS_MCP_TRANSPORT: "http",
      ARTEMIS_MCP_PUBLIC_URL: "https://mcp.example.com",
      PLUGIN_ROOT: path.resolve("."),
    },
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const who = init.headers?.Authorization === `Bearer ${jwtA}` ? "a" : "b";
      if (parsed.pathname === "/api/lecture/lectures/4/details") {
        return jsonResponse(200, lectureDetails(who === "a" ? 1 : 2, `${who}.pdf`));
      }
      if (parsed.pathname.endsWith(`/student/${who}.pdf`)) {
        return new Response(Buffer.from(`file-${who}`));
      }
      return new Response(null, { status: 404 });
    },
    host: "127.0.0.1",
    port: 0,
    log() {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await downloadOverHttp(base, alpha.token, 1);
    const second = await downloadOverHttp(base, beta.token, 2);
    assert.equal(first.body.download.filename, "a.pdf");
    assert.equal(first.body.download.uri, "artemis://files/attachments/attachment-video-units/1/student/a.pdf");
    assert.equal(first.link.type, "resource_link");
    assert.equal(first.link.uri, first.body.download.uri);
    assert.equal(first.body.download.absolutePath, undefined);
    assert.equal(first.body.download.downloadUrl, undefined);
    assert.equal(second.body.download.uri, "artemis://files/attachments/attachment-video-units/2/student/b.pdf");
    const read = await readOverHttp(base, first.session, alpha.token, first.link.uri);
    assert.equal(Buffer.from(read.result.contents[0].blob, "base64").toString("utf8"), "file-a");
    const again = await readOverHttp(base, first.session, alpha.token, first.link.uri);
    assert.equal(Buffer.from(again.result.contents[0].blob, "base64").toString("utf8"), "file-a");
    const other = await readOverHttp(base, second.session, beta.token, second.body.download.uri);
    assert.equal(Buffer.from(other.result.contents[0].blob, "base64").toString("utf8"), "file-b");
    const refused = await readOverHttp(base, first.session, alpha.token, "artemis://files/%2e%2e/secret.pdf");
    assert.equal(typeof refused.error.message, "string");
    const anonymous = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: first.link.uri } }),
    });
    assert.equal(anonymous.status, 401);
    const removed = await fetch(`${base}/files/${"a".repeat(43)}`);
    assert.equal(removed.status, 404);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

async function downloadOverHttp(base, token, unitId) {
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
  const response = await rpc(base, token, session, "tools/call", {
    name: "download_attachment",
    arguments: { lectureId: 4, unitId },
  });
  assert.equal(response.result.isError, false);
  return { session, body: JSON.parse(response.result.content[0].text), link: response.result.content[1] };
}

function readOverHttp(base, session, token, uri) {
  return rpc(base, token, session, "resources/read", { uri });
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
