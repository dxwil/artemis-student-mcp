# cursor.directory listing draft

This file is listing copy. Submit the GitHub repository https://github.com/dxwil/artemis-student-mcp. The plugin name is `artemis-student`.

This is an unofficial community plugin. It is not affiliated with the Artemis team or the Technical University of Munich.

## Short description

Unofficial Artemis student tools for one signed-in student, including TUM: read courses and course work, mark notifications and conversations read, post plain text, and submit text, file, and quiz exercises. Every write shows a preview and waits for an explicit yes.

## Install

Node.js 22 or newer. No runtime dependencies.

```bash
git clone https://github.com/dxwil/artemis-student-mcp.git
cd artemis-student-mcp
chmod +x ./bin/artemis-student-mcp ./bin/artemis-student-auth
export PLUGIN_DATA="$HOME/.local/share/artemis-student"
mkdir -p "$PLUGIN_DATA"
chmod 700 "$PLUGIN_DATA"
```

Agent Plugins loads `plugin.json` and `mcp.json`. Cursor's plugin format is `.cursor-plugin/plugin.json` with `cursor-mcp.json`. `npm test` checks the Agent Plugins manifests against the vendored 1.0.0 schemas.

## Usage

```bash
./bin/artemis-student-auth login
./bin/artemis-student-auth courses
./bin/artemis-student-auth post COURSE_ID CONVERSATION_ID "plain text"
./bin/artemis-student-auth submit-text EXERCISE_ID "answer"
```

`login` prompts for a username and password with echo off. Write commands print a preview and ask `Send this write? [y/N]`. Set `ARTEMIS_BASE_URL` for a server other than the packaged profile default.
