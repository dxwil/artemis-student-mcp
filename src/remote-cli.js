import { listCourses, loginWithPassword, logout, resolveConfig } from "./auth.js";
import {
  createAccessToken,
  envForAccount,
  findAccessToken,
  listAccessTokens,
  resolveStateDir,
  revokeAccessToken,
} from "./access.js";
import { readLoginSecrets } from "./cli.js";
import { SafeError } from "./errors.js";
import { isExpired, isInstructorToken, loadSession, readExpiry } from "./session.js";

export async function runManagement(positionals, flags, env, fetchImpl, io) {
  const command = positionals[0];
  if (command === "token") {
    return tokenCommand(positionals.slice(1), flags, env, io);
  }
  if (command === "login" || command === "logout" || command === "status") {
    assertFlags(flags, []);
    if (positionals.length !== 2) {
      throw new SafeError("usage", `Usage: artemis-student-mcp ${command} <id>`);
    }
    const stateDir = resolveStateDir(env);
    const usage = `Usage: artemis-student-mcp ${command} <id>`;
    if (command === "login") {
      return loginAccount(stateDir, positionals[1], env, fetchImpl, io, usage);
    }
    if (command === "logout") {
      return logoutAccount(stateDir, positionals[1], env, fetchImpl, io, usage);
    }
    return statusAccount(stateDir, positionals[1], env, io, usage);
  }
  throw new SafeError("usage", "Unknown command.");
}

function tokenCommand(args, flags, env, io) {
  const sub = args[0];
  const stateDir = resolveStateDir(env);
  if (sub === "create") {
    assertFlags(flags, ["label"]);
    if (args.length !== 1) {
      throw new SafeError("usage", "Usage: artemis-student-mcp token create [--label NAME]");
    }
    const created = createAccessToken(stateDir, { label: flags.label });
    io.stdout(`id: ${created.id}\n`);
    io.stdout(`label: ${created.label || "-"}\n`);
    io.stdout(`token: ${created.token}\n`);
    io.stderr("Save this token now. It is not shown again.\n");
    return 0;
  }
  if (sub === "list") {
    assertFlags(flags, []);
    if (args.length !== 1) {
      throw new SafeError("usage", "Usage: artemis-student-mcp token list");
    }
    const tokens = listAccessTokens(stateDir);
    io.stdout(`tokens: ${tokens.length}\n`);
    for (const record of tokens) {
      io.stdout(`id: ${record.id}\n`);
      io.stdout(`label: ${record.label || "-"}\n`);
      io.stdout(`created: ${record.createdAt}\n`);
      io.stdout(`revoked: ${record.revokedAt ? "yes" : "no"}\n`);
      io.stdout(sessionSummary(env, stateDir, record).line);
    }
    return 0;
  }
  if (sub === "revoke") {
    assertFlags(flags, []);
    if (args.length !== 2) {
      throw new SafeError("usage", "Usage: artemis-student-mcp token revoke <id>");
    }
    const revoked = revokeAccessToken(stateDir, args[1]);
    io.stdout(`revoked: ${revoked.id}\n`);
    return 0;
  }
  throw new SafeError("usage", "Usage: artemis-student-mcp token <create|list|revoke>");
}

async function loginAccount(stateDir, tokenId, env, fetchImpl, io, usage) {
  const record = findAccessToken(stateDir, tokenId, usage);
  if (record.revokedAt) {
    throw new SafeError("revoked", "That access token is revoked.");
  }
  const secrets = await readLoginSecrets(env);
  let password = secrets.password;
  secrets.password = "";
  try {
    const accountEnv = envForAccount(env, stateDir, record.userId);
    accountEnv.ARTEMIS_USERNAME = secrets.username;
    accountEnv.ARTEMIS_PASSWORD = password;
    await loginWithPassword(resolveConfig(accountEnv), fetchImpl);
    const courses = await listCourses(envForAccount(env, stateDir, record.userId), fetchImpl);
    io.stdout(`courses: ${courses.length}\n`);
    return 0;
  } finally {
    password = "";
    secrets.username = "";
  }
}

async function logoutAccount(stateDir, tokenId, env, fetchImpl, io, usage) {
  const record = findAccessToken(stateDir, tokenId, usage);
  await logout(envForAccount(env, stateDir, record.userId), fetchImpl);
  io.stdout("Cleared the local session.\n");
  return 0;
}

function statusAccount(stateDir, tokenId, env, io, usage) {
  const record = findAccessToken(stateDir, tokenId, usage);
  const summary = sessionSummary(env, stateDir, record);
  io.stdout(`id: ${record.id}\n`);
  io.stdout(`label: ${record.label || "-"}\n`);
  io.stdout(`revoked: ${record.revokedAt ? "yes" : "no"}\n`);
  io.stdout(`origin: ${summary.origin}\n`);
  if (summary.tokenFile) {
    io.stdout(`session file: ${summary.tokenFile}\n`);
  }
  io.stdout(summary.line);
  if (summary.strategy) {
    io.stdout(`auth: ${summary.strategy}\n`);
  }
  if (summary.expires) {
    io.stdout(`expires: ${summary.expires}\n`);
  }
  return 0;
}

function sessionSummary(env, stateDir, record) {
  const accountEnv = envForAccount(env, stateDir, record.userId);
  let config;
  try {
    config = resolveConfig(accountEnv);
  } catch {
    return { line: "session: absent\n", origin: "", tokenFile: null };
  }
  const session = config.tokenFile ? loadSession(config.tokenFile, config.origin) : null;
  if (!session) {
    return { line: "session: absent\n", origin: config.origin, tokenFile: config.tokenFile };
  }
  if (isInstructorToken(session.accessToken)) {
    return { line: "session: refused\n", origin: config.origin, tokenFile: config.tokenFile };
  }
  const exp = readExpiry(session.accessToken);
  const expired = isExpired(session.accessToken, Date.now());
  return {
    line: `session: ${expired ? "expired" : "present"}\n`,
    origin: config.origin,
    tokenFile: config.tokenFile,
    strategy: session.strategy,
    expires: exp == null ? "unknown" : new Date(exp * 1000).toISOString(),
  };
}

function assertFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) {
      throw new SafeError("usage", "That option does not apply to this command.");
    }
  }
}
