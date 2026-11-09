# MCP path compatibility

The verifier flag is real. `${PLUGIN_ROOT}` and `${CURSOR_PLUGIN_ROOT}` are not the same placeholder, and one string cannot satisfy both hosts.

## Agent Plugins

[Agent Plugins 1.0.0](https://agent-plugins.org/specification) requires `mcp.json` at the plugin root. For stdio:

- `command` is one token. A `./` path is resolved against the plugin root. Placeholders are not expanded in `command`.
- `cwd` may be omitted. An omitted `cwd` is the plugin root.
- When `cwd` is set, it must be `./...`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}`. The vendored schema pattern is `^(?:\./|\$\{PLUGIN_ROOT\}(?:/|$)|\$\{PLUGIN_DATA\}(?:/|$))`.
- A conformant client also sets the `PLUGIN_ROOT` and `PLUGIN_DATA` environment variables. Those names are not allowed as `env` keys.

Author guide: [MCP servers](https://agent-plugins.org/plugin-authors/mcp-servers).

`mcp.json` keeps that schema. It launches `./bin/artemis-student-mcp` and omits `cwd`, so a conformant client uses the plugin root without a placeholder Cursor would leave unexpanded.

## Cursor

[Cursor plugins](https://cursor.com/docs/plugins) and the [plugins reference](https://cursor.com/docs/reference/plugins) describe two formats:

- Agent Plugins: root `plugin.json`
- Cursor Plugins: `.cursor-plugin/plugin.json`

Both pages say Cursor does not expand `${PLUGIN_ROOT}` or `${PLUGIN_DATA}` in `mcp.json`. The reference's Agent Plugin example sets `cwd` to `${CURSOR_PLUGIN_ROOT}`, and says Cursor expands `${CURSOR_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` in `command`, `args`, `env`, and `cwd`.

`${CURSOR_PLUGIN_ROOT}` does not match the Agent Plugins `cwd` pattern. Putting it in root `mcp.json` would make that server entry invalid for a conformant Agent Plugins client. The schema test asserts that.

Cursor's format in this package is separate:

- `.cursor-plugin/plugin.json` sets `mcpServers` to `./cursor-mcp.json`
- `cursor-mcp.json` sets `cwd` to `${CURSOR_PLUGIN_ROOT}`

That file is not an Agent Plugins `mcp.json`.

## What was checked here

- Vendored Agent Plugins 1.0.0 schemas accept root `plugin.json` and `mcp.json`.
- The same schema rejects `cwd` `${CURSOR_PLUGIN_ROOT}`.
- `npm view @anysphere/cursor-plugins` against `https://registry.npmjs.org` returned `E404` / `Not Found` (`@anysphere/cursor-plugins@*` is not in this registry). That is a missing package, not an authentication failure.
- This environment has no Cursor IDE. No IDE load, no Cursor loader, and no shared plugin host was run. IDE load remains unproven.

## Live course count

The user reported `courses: 2` from their own run of the previous build. That is user-confirmed. It was not run again here.
