import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SafeError } from "./errors.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "bin", "artemis-student-mcp");

/**
 * Speak MCP over stdio to this plugin and call list_courses.
 * The child does not receive ARTEMIS_PASSWORD, so a stored session has to work.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ show?: boolean }} [options]
 */
export async function callToolOverMcp(env, name, args = {}) {
  return speak(env, name, args);
}

export async function listCoursesOverMcp(env, options = {}) {
  const body = await speak(env, "list_courses", {});
  return presentCourses(body.courses, options.show === true);
}

async function speak(env, name, args) {
  const childEnv = { ...env, PLUGIN_ROOT: env.PLUGIN_ROOT || ROOT };
  delete childEnv.ARTEMIS_PASSWORD;
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  let settled = false;
  const closed = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(1));
  });
  try {
    const response = await callTool(child, name, args);
    settled = true;
    child.stdin.end();
    await closed;
    return response;
  } catch (error) {
    if (!settled) {
      child.kill();
    }
    child.stdin.end();
    await closed;
    if (error instanceof SafeError) {
      throw error;
    }
    throw new SafeError("internal", "The course list could not be loaded.");
  }
}

async function callTool(child, name, args) {
  const pending = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = pending.shift();
      if (waiter) {
        waiter(line);
      }
      index = buffer.indexOf("\n");
    }
  });
  const request = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SafeError("internal", "The course list did not answer in time.")), 60_000);
      pending.push((line) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new SafeError("internal", "The course list could not be loaded."));
        }
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });

  const initialized = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "artemis-student-auth", version: "0.1.0" },
    },
  });
  if (!initialized.result) {
    throw new SafeError("internal", "The course list could not be loaded.");
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const called = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (called.error) {
    throw new SafeError("internal", "The course list could not be loaded.");
  }
  const result = called.result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string" || looksSecret(text)) {
    throw new SafeError("internal", "The course list could not be loaded.");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  if (result.isError) {
    const code = typeof body.error === "string" ? body.error : "internal";
    const message = typeof body.message === "string" && !looksSecret(body.message) ? body.message : "The course list could not be loaded.";
    throw new SafeError(code, message);
  }
  return body;
}

function presentCourses(courses, show) {
  if (!Array.isArray(courses)) {
    throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
  }
  const safe = courses.map((course) => {
    if (!course || typeof course !== "object") {
      throw new SafeError("malformed", "Artemis returned a course list that does not match the student dashboard shape.");
    }
    return {
      id: course.id,
      title: course.title,
      shortName: course.shortName,
      startDate: course.startDate ?? null,
      endDate: course.endDate ?? null,
    };
  });
  return { count: safe.length, courses: show ? safe : undefined };
}

function looksSecret(text) {
  return text.includes("art_pat_") || /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text);
}
