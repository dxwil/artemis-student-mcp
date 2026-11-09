import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { startHttpServer } from "../src/http-server.js";
import { assertClean, dashboardBody, fakeJwt, jsonResponse, PASSWORD, tempDir, USERNAME } from "./support.js";

const SECOND_USER = "student2";
const SECOND_PASSWORD = "pw-second-user-654321";
const ACCEPT = "application/json, text/event-stream";
const REDIRECT = "http://127.0.0.1:9/callback";

function initMessage() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  };
}

function artemisFetch(jwts, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    let username = "";
    let password = "";
    if (init.body) {
      try {
        const body = JSON.parse(init.body);
        username = body.username ?? "";
        password = body.password ?? "";
      } catch {
        password = "";
      }
    }
    calls.push({
      path: parsed.pathname,
      method: init.method ?? "GET",
      username,
      password,
      authorization: init.headers?.Authorization ?? "",
    });
    if (parsed.pathname === "/api/core/public/login-options") {
      return jsonResponse(200, options.loginOptions ?? { loginMethod: "PASSWORD", idpName: null });
    }
    if (parsed.pathname === "/management/info") {
      return jsonResponse(200, options.info ?? { activeModuleFeatures: ["passkey"] });
    }
    if (parsed.pathname === "/api/core/public/authenticate") {
      const expected = username === SECOND_USER ? SECOND_PASSWORD : PASSWORD;
      if (!jwts[username] || password !== expected) {
        return new Response(null, { status: 401 });
      }
      return jsonResponse(200, { access_token: jwts[username] });
    }
    if (parsed.pathname === "/api/course/courses/for-dashboard") {
      if (options.dashboardStatus) {
        return new Response(null, { status: options.dashboardStatus });
      }
      return jsonResponse(200, dashboardBody());
    }
    if (parsed.pathname === "/api/notification/courses/7/status") {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  };
  return { calls, fetchImpl };
}

async function closeServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerClient(base, redirectUri, name = "Test Client") {
  const response = await fetch(new URL("/register", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  return body.client_id;
}

async function browserLogin(base, { clientId, redirectUri, resource, username, password, verifier, challenge, state }) {
  const authorize = new URL("/authorize", base);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", resource);
  authorize.searchParams.set("scope", "mcp:tools");
  if (state) {
    authorize.searchParams.set("state", state);
  }
  const page = await fetch(authorize);
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 200));
  const txn = html.match(/name="txn" value="([^"]+)"/)?.[1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.equal(typeof txn, "string");
  const cookie = (page.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
  assert.equal(cookie?.startsWith("oauth_csrf="), true);
  const posted = await fetch(new URL("/authorize", base), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ txn, csrf, username, password }),
  });
  return { html, status: posted.status, location: posted.headers.get("location") };
}

async function redeem(base, { code, clientId, redirectUri, resource, verifier }) {
  const response = await fetch(new URL("/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  return { status: response.status, body: await response.json() };
}

test("oauth discovery, PKCE login, refresh rotation, and account isolation", async () => {
  const directory = tempDir();
  const jwtA = fakeJwt(4_102_444_800);
  const jwtB = fakeJwt(4_102_444_900);
  const logs = [];
  const route = artemisFetch({ [USERNAME]: jwtA, [SECOND_USER]: jwtB });
  const server = await startHttpServer({
    env: {
      ARTEMIS_MCP_STATE_DIR: directory,
      ARTEMIS_BASE_URL: "https://artemis.test",
      PLUGIN_ROOT: path.resolve("."),
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
  const resource = `${base}/mcp`;
  const texts = [];
  try {
    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify(initMessage()),
    });
    const deniedText = await denied.text();
    texts.push(deniedText);
    assert.equal(denied.status, 401);
    assert.equal(JSON.parse(deniedText).error, "unauthorized");
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(denied.headers.get("www-authenticate"))?.[1];
    assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource`);
    const metadata = await (await fetch(metadataUrl)).json();
    const pathMetadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    const authorization = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(metadata.resource, resource);
    assert.deepEqual(metadata.authorization_servers, [base]);
    assert.deepEqual(pathMetadata, metadata);
    assert.equal(authorization.issuer, base);
    assert.equal(authorization.authorization_endpoint, `${base}/authorize`);
    assert.equal(authorization.token_endpoint, `${base}/token`);
    assert.equal(authorization.registration_endpoint, `${base}/register`);
    assert.deepEqual(authorization.code_challenge_methods_supported, ["S256"]);
    assert.equal(authorization.token_endpoint_auth_methods_supported.includes("none"), true);

    const clientId = await registerClient(base, REDIRECT, "<script>alert(1)</script>");
    const pair = pkce();
    const signed = await browserLogin(base, {
      clientId,
      redirectUri: REDIRECT,
      resource,
      username: USERNAME,
      password: PASSWORD,
      ...pair,
      state: "state-1",
    });
    texts.push(signed.html);
    assert.equal(signed.html.includes("<script"), false);
    assert.match(signed.html, /unofficial/i);
    assert.match(signed.html, /not stored/i);
    assert.match(signed.html, /https:\/\/artemis\.test/);
    assert.equal(signed.html.includes(PASSWORD), false);
    assert.equal(signed.status, 302);
    const redirected = new URL(signed.location);
    assert.equal(redirected.origin + redirected.pathname, "http://127.0.0.1:9/callback");
    assert.equal(redirected.searchParams.get("state"), "state-1");
    const code = redirected.searchParams.get("code");
    const tokens = await redeem(base, { code, clientId, redirectUri: REDIRECT, resource, verifier: pair.verifier });
    assert.equal(tokens.status, 200);
    assert.equal(tokens.body.token_type, "Bearer");
    assert.equal(typeof tokens.body.access_token, "string");
    assert.equal(typeof tokens.body.refresh_token, "string");
    assert.equal(tokens.body.expires_in > 0, true);

    const opened = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    const openedBody = await opened.json();
    texts.push(JSON.stringify(openedBody));
    assert.equal(opened.status, 200);
    assert.equal(openedBody.result.protocolVersion, "2025-06-18");
    const session = opened.headers.get("mcp-session-id");
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const courses = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": session,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_courses", arguments: {} } }),
    });
    const courseBody = await courses.json();
    texts.push(JSON.stringify(courseBody));
    assert.equal(courseBody.result.isError, false);
    assert.equal(JSON.parse(courseBody.result.content[0].text).courses[0].shortName, "ds");

    const refreshed = await fetch(new URL("/token", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.body.refresh_token,
        client_id: clientId,
        resource,
      }),
    });
    const next = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.notEqual(next.refresh_token, tokens.body.refresh_token);
    assert.notEqual(next.access_token, tokens.body.access_token);

    const other = pkce();
    const second = await browserLogin(base, {
      clientId,
      redirectUri: REDIRECT,
      resource,
      username: SECOND_USER,
      password: SECOND_PASSWORD,
      ...other,
      state: "state-2",
    });
    const secondCode = new URL(second.location).searchParams.get("code");
    const secondTokens = await redeem(base, {
      code: secondCode,
      clientId,
      redirectUri: REDIRECT,
      resource,
      verifier: other.verifier,
    });
    assert.equal(secondTokens.status, 200);
    const secondOpen = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondTokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    const secondSession = secondOpen.headers.get("mcp-session-id");
    const preview = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": session,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "mark_notifications_read", arguments: { courseId: 7, notificationIds: [4] } },
      }),
    });
    const previewBody = JSON.parse((await preview.json()).result.content[0].text);
    const stolen = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secondTokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
        "mcp-session-id": secondSession,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "mark_notifications_read",
          arguments: { courseId: 7, notificationIds: [4], confirmationToken: previewBody.confirmationToken },
        },
      }),
    });
    const stolenBody = JSON.parse((await stolen.json()).result.content[0].text);
    assert.equal(stolenBody.error, "confirmation_required");
    const puts = route.calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 0);
    assert.equal(route.calls.some((call) => call.authorization === `Bearer ${jwtA}`), true);
    assert.equal(route.calls.some((call) => call.authorization === `Bearer ${jwtB}`), true);
    const reused = await fetch(new URL("/token", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.body.refresh_token,
        client_id: clientId,
        resource,
      }),
    });
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error, "invalid_grant");

    const stored = fs.readFileSync(path.join(directory, "oauth.json"), "utf8");
    assert.equal(fs.statSync(path.join(directory, "oauth.json")).mode & 0o777, 0o600);
    const tree = walk(directory);
    assert.equal(tree.includes(PASSWORD), false);
    assert.equal(tree.includes(SECOND_PASSWORD), false);
    assert.equal(tree.includes(tokens.body.access_token), false);
    assert.equal(tree.includes(tokens.body.refresh_token), false);
    assert.equal(tree.includes(code), false);
    assert.equal(stored.includes(tokens.body.access_token), false);
    assert.equal(logs.join("").includes(PASSWORD), false);
    assert.equal(logs.join("").includes(tokens.body.access_token), false);
  } finally {
    await closeServer(server);
  }
  assertClean(texts.join("\n"), [PASSWORD, SECOND_PASSWORD, jwtA, jwtB]);
});

test("a wrong PKCE verifier is rejected and cannot be retried", async () => {
  const directory = tempDir();
  const jwt = fakeJwt(4_102_444_800);
  const route = artemisFetch({ [USERNAME]: jwt });
  const server = await startHttpServer({
    env: { ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_BASE_URL: "https://artemis.test" },
    fetchImpl: route.fetchImpl,
    host: "127.0.0.1",
    port: 0,
    log() {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/mcp`;
  try {
    const clientId = await registerClient(base, REDIRECT);
    const pair = pkce();
    const signed = await browserLogin(base, {
      clientId,
      redirectUri: REDIRECT,
      resource,
      username: USERNAME,
      password: PASSWORD,
      ...pair,
      state: "state-pkce",
    });
    const code = new URL(signed.location).searchParams.get("code");
    const wrong = await redeem(base, {
      code,
      clientId,
      redirectUri: REDIRECT,
      resource,
      verifier: crypto.randomBytes(32).toString("base64url"),
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    const again = await redeem(base, { code, clientId, redirectUri: REDIRECT, resource, verifier: pair.verifier });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "invalid_grant");
    assert.equal(walk(directory).includes(PASSWORD), false);
  } finally {
    await closeServer(server);
  }
});

test("the public origin is the OAuth issuer and forwarded headers are ignored", async () => {
  const directory = tempDir();
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
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, {
      headers: { "x-forwarded-proto": "http", "x-forwarded-host": "evil.example" },
    });
    const body = await response.json();
    assert.equal(body.issuer, "https://mcp.example.com");
    assert.equal(body.authorization_endpoint, "https://mcp.example.com/authorize");
    const resource = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).json();
    assert.equal(resource.resource, "https://mcp.example.com/mcp");
    assert.equal(JSON.stringify(body).includes("evil.example"), false);
  } finally {
    await closeServer(server);
  }
});

test("oauth login is rate limited and uses directory password when Artemis lists ldap", async () => {
  const directory = tempDir();
  const jwt = fakeJwt(4_102_444_800);
  const route = artemisFetch(
    { [USERNAME]: jwt, [SECOND_USER]: jwt },
    { loginOptions: { loginMethod: "OIDC", idpName: "Directory" }, info: { activeModuleFeatures: ["ldap"] } },
  );
  const server = await startHttpServer({
    env: { ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_BASE_URL: "https://artemis.test" },
    fetchImpl: route.fetchImpl,
    host: "127.0.0.1",
    port: 0,
    loginFailureLimit: 2,
    log() {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/mcp`;
  try {
    const clientId = await registerClient(base, REDIRECT);
    const pair = pkce();
    const authorize = new URL("/authorize", base);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", REDIRECT);
    authorize.searchParams.set("code_challenge", pair.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", resource);
    const page = await fetch(authorize);
    const html = await page.text();
    const txn = html.match(/name="txn" value="([^"]+)"/)[1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
    const cookie = page.headers.getSetCookie()[0].split(";")[0];
    async function post(password) {
      return fetch(new URL("/authorize", base), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ txn, csrf, username: USERNAME, password }),
      });
    }
    const first = await post("not-the-password");
    const second = await post("still-not-it");
    const before = route.calls.filter((call) => call.path === "/api/core/public/authenticate").length;
    const third = await post("another-wrong-one");
    const after = route.calls.filter((call) => call.path === "/api/core/public/authenticate").length;
    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(third.status, 429);
    assert.equal(after, before);
    assert.match(await third.text(), /Too many sign-in attempts/);
    const fresh = pkce();
    const signed = await browserLogin(base, {
      clientId,
      redirectUri: REDIRECT,
      resource,
      username: SECOND_USER,
      password: SECOND_PASSWORD,
      ...fresh,
      state: "ldap",
    });
    assert.equal(signed.status, 302);
    assert.equal(route.calls.some((call) => call.path === "/management/info"), true);
    assert.equal(route.calls.some((call) => call.path === "/api/core/public/authenticate" && call.username === SECOND_USER), true);
  } finally {
    await closeServer(server);
  }
});

test("an expired Artemis session returns invalid_token and blocks refresh", async () => {
  const directory = tempDir();
  const jwt = fakeJwt(4_102_444_800);
  const route = artemisFetch({ [USERNAME]: jwt });
  const server = await startHttpServer({
    env: { ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_ROOT: path.resolve(".") },
    fetchImpl: route.fetchImpl,
    host: "127.0.0.1",
    port: 0,
    log() {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/mcp`;
  try {
    const clientId = await registerClient(base, REDIRECT);
    const pair = pkce();
    const signed = await browserLogin(base, {
      clientId,
      redirectUri: REDIRECT,
      resource,
      username: USERNAME,
      password: PASSWORD,
      ...pair,
      state: "exp",
    });
    const code = new URL(signed.location).searchParams.get("code");
    const tokens = await redeem(base, { code, clientId, redirectUri: REDIRECT, resource, verifier: pair.verifier });
    const sessionFile = findSession(directory);
    const stored = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    stored.accessToken = fakeJwt(Math.floor(Date.now() / 1000) - 120);
    fs.writeFileSync(sessionFile, JSON.stringify(stored), { mode: 0o600 });
    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error, "invalid_token");
    assert.match(denied.headers.get("www-authenticate"), /error="invalid_token"/);
    const refreshed = await fetch(new URL("/token", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.body.refresh_token,
        client_id: clientId,
        resource,
      }),
    });
    assert.equal(refreshed.status, 400);
    assert.equal((await refreshed.json()).error, "invalid_grant");
  } finally {
    await closeServer(server);
  }
});

test("revoking an access token blocks it and a refresh can mint another", async () => {
  const directory = tempDir();
  const jwt = fakeJwt(4_102_444_800);
  const route = artemisFetch({ [USERNAME]: jwt });
  const server = await startHttpServer({
    env: { ARTEMIS_MCP_STATE_DIR: directory, ARTEMIS_BASE_URL: "https://artemis.test" },
    fetchImpl: route.fetchImpl,
    host: "127.0.0.1",
    port: 0,
    log() {},
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/mcp`;
  try {
    const clientId = await registerClient(base, REDIRECT);
    const pair = pkce();
    const signed = await browserLogin(base, {
      clientId,
      redirectUri: REDIRECT,
      resource,
      username: USERNAME,
      password: PASSWORD,
      ...pair,
      state: "revoke",
    });
    const code = new URL(signed.location).searchParams.get("code");
    const tokens = await redeem(base, { code, clientId, redirectUri: REDIRECT, resource, verifier: pair.verifier });
    const revoked = await fetch(new URL("/revoke", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.body.access_token, token_type_hint: "access_token", client_id: clientId }),
    });
    assert.equal(revoked.status, 200);
    const denied = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.body.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    assert.equal(denied.status, 401);
    const refreshed = await fetch(new URL("/token", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.body.refresh_token,
        client_id: clientId,
        resource,
      }),
    });
    const next = await refreshed.json();
    assert.equal(refreshed.status, 200);
    const allowed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${next.access_token}`,
        "content-type": "application/json",
        accept: ACCEPT,
      },
      body: JSON.stringify(initMessage()),
    });
    assert.equal(allowed.status, 200);
  } finally {
    await closeServer(server);
  }
});

function walk(directory) {
  const parts = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      parts.push(walk(full));
    } else {
      parts.push(fs.readFileSync(full, "utf8"));
    }
  }
  return parts.join("\n");
}

function findSession(directory) {
  const users = path.join(directory, "users");
  for (const entry of fs.readdirSync(users)) {
    const file = path.join(users, entry, "session.json");
    if (fs.existsSync(file)) {
      return file;
    }
  }
  throw new Error("missing session");
}
