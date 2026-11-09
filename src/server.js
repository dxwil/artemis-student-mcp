import { pathToFileURL } from "node:url";
import { SafeError } from "./errors.js";
import { formatListenAddress, startHttpServer } from "./http-server.js";
import { createToolImpl } from "./impl.js";
import { createMcpHandler, parseRpcLine } from "./mcp.js";
import { runManagement } from "./remote-cli.js";

const USAGE = `Usage:
  artemis-student-mcp [--stdio]
  artemis-student-mcp --http [--host 127.0.0.1] [--port 8080]
  artemis-student-mcp token create [--label NAME]
  artemis-student-mcp token list
  artemis-student-mcp token revoke <id>
  artemis-student-mcp login <id>
  artemis-student-mcp logout <id>
  artemis-student-mcp status <id>
`;

const defaultIo = {
  stdout(text) {
    process.stdout.write(text);
  },
  stderr(text) {
    process.stderr.write(text);
  },
};

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, io = defaultIo) {
  let parsed;
  try {
    parsed = parseInvocation(argv);
  } catch (error) {
    const safe = error instanceof SafeError ? error : new SafeError("usage", "Unknown option.");
    io.stderr(`${safe.message}\n${USAGE}`);
    return 1;
  }
  if (parsed.flags.help) {
    io.stdout(USAGE);
    return 0;
  }
  try {
    if (parsed.positionals.length === 0) {
      const mode = resolveMode(parsed.flags, env);
      if (mode === "http") {
        assertFlags(parsed.flags, ["http", "host", "port"]);
        await runHttp(parsed.flags, env, fetchImpl, io);
        return 0;
      }
      assertFlags(parsed.flags, ["stdio"]);
      await runStdio(env, fetchImpl);
      return 0;
    }
    return await runManagement(parsed.positionals, parsed.flags, env, fetchImpl, io);
  } catch (error) {
    if (error instanceof SafeError) {
      io.stderr(`${error.message}\n`);
      if (error.code === "usage") {
        io.stderr(USAGE);
      }
      return error.code === "sso_required" ? 2 : 1;
    }
    io.stderr("artemis-student-mcp failed\n");
    return 1;
  }
}

export async function runStdio(env = process.env, fetchImpl = globalThis.fetch) {
  const handle = createMcpHandler(createToolImpl(env, fetchImpl));
  let buffer = "";
  let chain = Promise.resolve();

  const onLine = (line) => {
    chain = chain.then(async () => {
      const message = parseRpcLine(line);
      const response = message.invalid
        ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }
        : await handle(message);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    });
    return chain;
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim() !== "") {
        onLine(line);
      }
      index = buffer.indexOf("\n");
    }
  });

  await new Promise((resolve) => {
    process.stdin.on("end", () => {
      chain.then(resolve, resolve);
    });
  });
}

async function runHttp(flags, env, fetchImpl, io) {
  const server = await startHttpServer({
    env,
    fetchImpl,
    host: flags.host,
    port: flags.port,
    log: (line) => io.stderr(line.endsWith("\n") ? line : `${line}\n`),
  });
  io.stderr(`artemis-student-mcp listening on ${formatListenAddress(server)}\n`);
  await new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      server.close(() => resolve());
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function resolveMode(flags, env) {
  if (flags.http && flags.stdio) {
    throw new SafeError("usage", "Choose either --http or --stdio.");
  }
  if (flags.stdio) {
    return "stdio";
  }
  if (flags.http) {
    return "http";
  }
  const configured = typeof env.ARTEMIS_MCP_TRANSPORT === "string" ? env.ARTEMIS_MCP_TRANSPORT.trim().toLowerCase() : "";
  if (configured === "" || configured === "stdio") {
    return "stdio";
  }
  if (configured === "http") {
    return "http";
  }
  throw new SafeError("usage", "ARTEMIS_MCP_TRANSPORT must be stdio or http.");
}

function parseInvocation(argv) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--http" || arg === "--stdio") {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (arg === "--host" || arg === "--port" || arg === "--label") {
      const value = argv[index + 1];
      if (value == null || value.startsWith("-")) {
        throw new SafeError("usage", `Missing value for ${arg}.`);
      }
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new SafeError("usage", "Unknown option.");
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function assertFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) {
      throw new SafeError("usage", "That option does not apply to this command.");
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then((code) => {
    if (typeof code === "number") {
      process.exitCode = code;
    }
  }).catch(() => {
    process.stderr.write("artemis-student-mcp failed\n");
    process.exitCode = 1;
  });
}
