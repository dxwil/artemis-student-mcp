import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAccount } from "../src/account.js";
import { SafeError } from "../src/errors.js";
import { fakeJwt, jsonResponse, scriptedFetch, tempDir } from "./support.js";

function env(directory) {
  fs.writeFileSync(
    path.join(directory, "session.json"),
    JSON.stringify({ version: 1, origin: "https://artemis.test", accessToken: fakeJwt(4_102_444_800) }),
    { mode: 0o600 },
  );
  return { ARTEMIS_BASE_URL: "https://artemis.test", PLUGIN_DATA: directory, PLUGIN_ROOT: path.resolve(".") };
}

test("get_account keeps the public profile and drops secrets", async () => {
  const directory = tempDir();
  const script = scriptedFetch([
    () =>
      jsonResponse(200, {
        id: 42,
        login: "ada",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.edu",
        visibleRegistrationNumber: "01234567",
        langKey: "en",
        groups: ["students"],
        courseRoles: [{ courseId: 7, roles: ["STUDENT"] }],
        authorities: ["ROLE_USER", "ROLE_ADMIN"],
        vcsAccessToken: "vcs-do-not-print",
        password: "pw-do-not-print",
        imageUrl: "files/users/42/profile-pictures/avatar.png",
      }),
  ]);
  const account = await getAccount(env(directory), script.fetchImpl);
  assert.deepEqual(account, {
    login: "ada",
    firstName: "Ada",
    lastName: "Lovelace",
    name: "Ada Lovelace",
    email: "ada@example.edu",
    registrationNumber: "01234567",
    language: "en",
    groups: ["students"],
    courseRoles: [{ courseId: 7, roles: ["STUDENT"] }],
  });
  assert.equal(new URL(script.calls[0].href).pathname, "/api/core/public/account");
  assert.equal(script.calls[0].method, "GET");
  const serialized = JSON.stringify(account);
  assert.equal(serialized.includes("vcs-do-not-print"), false);
  assert.equal(serialized.includes("pw-do-not-print"), false);
  assert.equal(serialized.includes("ROLE_ADMIN"), false);
});

test("a nameless account uses the server display name", async () => {
  const directory = tempDir();
  const script = scriptedFetch([() => jsonResponse(200, { login: "ada", name: "Lovelace, Ada", langKey: "de" })]);
  const account = await getAccount(env(directory), script.fetchImpl);
  assert.equal(account.name, "Lovelace, Ada");
  assert.equal(account.registrationNumber, null);
  assert.equal(account.language, "de");
  assert.deepEqual(account.groups, []);
  await assert.rejects(
    () => getAccount(env(directory), scriptedFetch([() => jsonResponse(200, { firstName: "Ada" })]).fetchImpl),
    (error) => error instanceof SafeError && error.code === "malformed",
  );
});
