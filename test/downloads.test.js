import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAccessToken, userDirectory } from "../src/access.js";
import { downloadAttachment } from "../src/downloads.js";
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

test("stdio download returns an absolute path for a 10.6 student file and refuses other units", async () => {
  const directory = tempDir();
  const script = scripted([
    () => jsonResponse(200, lectureDetails(1, "slides.pdf")),
    () => new Response(Buffer.from("pdf-bytes")),
  ]);
  const saved = await downloadAttachment(env(directory), 4, { unitId: 1 }, script.fetchImpl);
  assert.equal(saved.download.bytes, 9);
  assert.equal(saved.download.filename, "slides.pdf");
  assert.equal(saved.download.mimeType, "application/pdf");
  assert.equal(path.isAbsolute(saved.download.absolutePath), true);
  assert.equal(fs.readFileSync(saved.download.absolutePath, "utf8"), "pdf-bytes");
  assert.equal(saved.resource.mimeType, "application/pdf");
  assert.equal(Buffer.from(saved.resource.blob, "base64").toString("utf8"), "pdf-bytes");
  assert.equal(new URL(script.calls[1].href).pathname, "/api/core/files/attachments/attachment-video-units/1/student/slides.pdf");
  const blocked = scripted([() => jsonResponse(200, lectureDetails(1, "slides.pdf"))]);
  await assert.rejects(
    () => downloadAttachment(env(directory), 4, { unitId: 99 }, blocked.fetchImpl),
    (error) => error instanceof SafeError && error.code === "not_found",
  );
  assert.equal(blocked.calls.length, 1);
  assert.equal(new URL(blocked.calls[0].href).pathname.endsWith("/details"), true);
});

test("http downloads return a one-time url for that user only", async () => {
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
    assert.equal(first.body.download.downloadUrl.startsWith("https://mcp.example.com/files/"), true);
    assert.equal(first.body.download.absolutePath, undefined);
    assert.equal(second.body.download.downloadUrl.startsWith("https://mcp.example.com/files/"), true);
    assert.equal(first.body.download.downloadUrl === second.body.download.downloadUrl, false);
    assert.equal(JSON.stringify(second.body).includes(first.body.download.downloadUrl), false);
    assert.equal(first.resource.mimeType, "application/pdf");
    assert.equal(Buffer.from(first.resource.blob, "base64").toString("utf8"), "file-a");
    const fetched = await fetch(first.body.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get("content-type"), "application/pdf");
    assert.match(fetched.headers.get("content-disposition"), /filename="a.pdf"/);
    assert.equal(Buffer.from(await fetched.arrayBuffer()).toString("utf8"), "file-a");
    const again = await fetch(first.body.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(again.status, 404);
    const other = await fetch(second.body.download.downloadUrl.replace("https://mcp.example.com", base));
    assert.equal(Buffer.from(await other.arrayBuffer()).toString("utf8"), "file-b");
    const guessed = first.body.download.downloadUrl.replace(/.$/, first.body.download.downloadUrl.endsWith("a") ? "b" : "a");
    const missed = await fetch(guessed.replace("https://mcp.example.com", base));
    assert.equal(missed.status, 404);
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
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-session-id": session,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "download_attachment", arguments: { lectureId: 4, unitId } },
    }),
  });
  const body = await response.json();
  assert.equal(body.result.isError, false);
  return { body: JSON.parse(body.result.content[0].text), resource: body.result.content[1].resource };
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
