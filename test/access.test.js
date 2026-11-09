import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createAccessToken, findAccessToken, resolveStateDir, revokeAccessToken, userDirectory, verifyBearer } from "../src/access.js";
import { SafeError } from "../src/errors.js";
import { loadHttpConfig } from "../src/http-server.js";
import { main } from "../src/server.js";
import { dashboardBody, fakeJwt, jsonResponse, PASSWORD, scriptedFetch, tempDir, USERNAME } from "./support.js";

const root = path.resolve(".");

function capture() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout(text) {
        out.stdout += text;
      },
      stderr(text) {
        out.stderr += text;
      },
    },
  };
}

function cliEnv(directory, extra = {}) {
  return {
    ARTEMIS_MCP_STATE_DIR: directory,
    ARTEMIS_BASE_URL: "https://artemis.test",
    PLUGIN_ROOT: root,
    ...extra,
  };
}

function treeText(directory) {
  if (!fs.existsSync(directory)) {
    return "";
  }
  const parts = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      parts.push(treeText(full));
    } else {
      parts.push(fs.readFileSync(full));
    }
  }
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(String(part))))).toString("utf8");
}

test("state defaults, public origins, and bearer hashes stay private", async () => {
  const directory = tempDir();
  assert.equal(resolveStateDir({}), "/var/lib/artemis-student-mcp");
  assert.equal(loadHttpConfig({ ARTEMIS_MCP_STATE_DIR: directory }).host, "127.0.0.1");
  assert.equal(loadHttpConfig({ ARTEMIS_MCP_STATE_DIR: directory }).port, 8080);
  assert.throws(
    () => loadHttpConfig({ ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_MCP_PUBLIC_URL: "http://mcp.example.com" }),
    (error) => error instanceof SafeError && error.code === "invalid_public_url",
  );
  assert.throws(
    () => loadHttpConfig({ ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_MCP_PUBLIC_URL: "https://user:SECRET_IN_URL@mcp.example.com" }),
    (error) => error instanceof SafeError && !String(error.message).includes("SECRET_IN_URL"),
  );
  const { out, io } = capture();
  const code = await main(["token", "create", "--label", "phone"], cliEnv(directory), globalThis.fetch, io);
  assert.equal(code, 0);
  const id = out.stdout.match(/^id: (t_[a-f0-9]{16})$/m)?.[1];
  const token = out.stdout.match(/^token: (asm_\S+)$/m)?.[1];
  assert.equal(typeof id, "string");
  assert.equal(typeof token, "string");
  assert.equal(out.stderr, "Save this token now. It is not shown again.\n");
  assert.equal(out.stderr.includes(token), false);
  const stored = fs.readFileSync(path.join(directory, "access-tokens.json"), "utf8");
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(crypto.createHash("sha256").update(token).digest("hex")), true);
  assert.equal(fs.statSync(path.join(directory, "access-tokens.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, "users")).mode & 0o777, 0o700);
  const verdict = verifyBearer(directory, token);
  assert.equal(verdict.account.id, id);
  assert.equal(verifyBearer(directory, `${token}nope`).account, null);
  assert.equal(verifyBearer(directory, "").account, null);
  const second = capture();
  assert.equal(await main(["token", "create", "--label", "tablet"], cliEnv(directory), globalThis.fetch, second.io), 0);
  const secondToken = second.out.stdout.match(/^token: (asm_\S+)$/m)[1];
  assert.equal(verifyBearer(directory, secondToken).account.id !== id, true);
  assert.equal(await main(["token", "revoke", id], cliEnv(directory), globalThis.fetch, capture().io), 0);
  const revoked = verifyBearer(directory, token);
  assert.equal(revoked.account, null);
  assert.equal(revoked.revokedUserId, verdict.account.userId);
  assert.equal(verifyBearer(directory, secondToken).account.label, "tablet");
  const listed = capture();
  assert.equal(await main(["token", "list"], cliEnv(directory), globalThis.fetch, listed.io), 0);
  assert.equal(listed.out.stdout.includes(token), false);
  assert.equal(listed.out.stdout.includes(secondToken), false);
  assert.match(listed.out.stdout, /revoked: yes/);
  assert.equal(await main(["token", "create", "--label", "../x"], cliEnv(directory), globalThis.fetch, capture().io), 1);
  const echoed = capture();
  const refused = await main(["login", token], cliEnv(directory), globalThis.fetch, echoed.io);
  assert.equal(refused, 1);
  assert.equal(echoed.out.stderr.includes(token), false);
  assert.equal(echoed.out.stdout.includes(token), false);
});

test("login reuses directory password flow and stores no password", async () => {
  const directory = tempDir();
  const { out, io } = capture();
  assert.equal(await main(["token", "create", "--label", "cli"], cliEnv(directory), globalThis.fetch, io), 0);
  const id = out.stdout.match(/^id: (t_[a-f0-9]{16})$/m)[1];
  const bearer = out.stdout.match(/^token: (asm_\S+)$/m)[1];
  const record = findAccessToken(directory, id);
  const token = fakeJwt(4_102_444_800);
  const script = scriptedFetch([
    () => jsonResponse(200, { loginMethod: "OIDC", idpName: "Directory" }),
    () => jsonResponse(200, { activeModuleFeatures: ["ldap"], oidc: { buttonLabel: "Directory" } }),
    () => jsonResponse(200, { access_token: token }),
    () => jsonResponse(200, dashboardBody()),
  ]);
  const logged = capture();
  const code = await main(
    ["login", id],
    cliEnv(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }),
    script.fetchImpl,
    logged.io,
  );
  assert.equal(code, 0);
  assert.equal(logged.out.stdout, "courses: 2\n");
  assert.equal(script.calls[2].passwordMatches(PASSWORD), true);
  assert.equal(script.calls[3].authorizationMatches(token), true);
  const sessionPath = path.join(directory, "users", record.userId, "session.json");
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  assert.equal(session.strategy, "directory-password");
  assert.equal(session.accessToken, token);
  assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
  const files = treeText(directory);
  assert.equal(files.includes(PASSWORD), false);
  assert.equal(files.includes(bearer), false);
  assert.equal(logged.out.stdout.includes(PASSWORD), false);
  assert.equal(logged.out.stderr.includes(PASSWORD), false);
  assert.equal(logged.out.stdout.includes(token), false);
  const status = capture();
  assert.equal(await main(["status", id], cliEnv(directory), globalThis.fetch, status.io), 0);
  assert.match(status.out.stdout, /session: present/);
  assert.match(status.out.stdout, /auth: directory-password/);
  assert.equal(status.out.stdout.includes(token), false);
  assert.equal(status.out.stdout.includes(bearer), false);
  const cleared = capture();
  const logoutScript = scriptedFetch([() => new Response(null, { status: 200 })]);
  assert.equal(await main(["logout", id], cliEnv(directory), logoutScript.fetchImpl, cleared.io), 0);
  assert.equal(cleared.out.stdout, "Cleared the local session.\n");
  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(logoutScript.calls[0].authorizationMatches(token), true);
  assert.equal(revokeAccessToken(directory, id).revokedAt != null, true);
  const again = capture();
  const blocked = scriptedFetch([]);
  assert.equal(
    await main(["login", id], cliEnv(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }), blocked.fetchImpl, again.io),
    1,
  );
  assert.equal(blocked.calls.length, 0);
  assert.equal(again.out.stderr.includes(PASSWORD), false);
});

test("single sign-on still refuses before a password is sent", async () => {
  const directory = tempDir();
  const created = capture();
  assert.equal(await main(["token", "create"], cliEnv(directory), globalThis.fetch, created.io), 0);
  const id = created.out.stdout.match(/^id: (t_[a-f0-9]{16})$/m)[1];
  const script = scriptedFetch([
    () => jsonResponse(200, { loginMethod: "OIDC", idpName: "Directory" }),
    () => jsonResponse(200, { activeModuleFeatures: ["passkey"] }),
  ]);
  const logged = capture();
  const code = await main(
    ["login", id],
    cliEnv(directory, { ARTEMIS_USERNAME: USERNAME, ARTEMIS_PASSWORD: PASSWORD }),
    script.fetchImpl,
    logged.io,
  );
  assert.equal(code, 2);
  assert.equal(script.calls.length, 2);
  assert.equal(script.calls.some((call) => call.passwordMatches(PASSWORD)), false);
  const record = findAccessToken(directory, id);
  assert.equal(fs.existsSync(path.join(userDirectory(directory, record.userId), "session.json")), false);
  assert.equal(treeText(directory).includes(PASSWORD), false);
  assert.equal(logged.out.stderr.includes(PASSWORD), false);
});
