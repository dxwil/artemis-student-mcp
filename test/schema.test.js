import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateSchema } from "./json-schema.js";

const root = path.resolve(".");
const pluginSchema = JSON.parse(fs.readFileSync(path.join(root, "vendor/agent-plugins/1.0.0/plugin.schema.json"), "utf8"));
const mcpSchema = JSON.parse(fs.readFileSync(path.join(root, "vendor/agent-plugins/1.0.0/mcp.schema.json"), "utf8"));

test("plugin.json and mcp.json match the vendored Agent Plugins 1.0.0 schemas", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
  const mcp = JSON.parse(fs.readFileSync(path.join(root, "mcp.json"), "utf8"));
  assert.deepEqual(validateSchema(pluginSchema, plugin), []);
  assert.deepEqual(validateSchema(mcpSchema, mcp), []);
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.equal(mcp.mcpServers["artemis-student"].command, "./bin/artemis-student-mcp");
  assert.equal(Object.hasOwn(mcp.mcpServers["artemis-student"], "cwd"), false);
  assert.equal(JSON.stringify(mcp).includes("CURSOR_PLUGIN_ROOT"), false);
  assert.equal(JSON.stringify(mcp).includes("PLUGIN_ROOT"), false);
});

test("Cursor cwd placeholder is a different format and fails the Agent Plugins schema", () => {
  const cursorMcp = JSON.parse(fs.readFileSync(path.join(root, "cursor-mcp.json"), "utf8"));
  const cursorManifest = JSON.parse(fs.readFileSync(path.join(root, ".cursor-plugin/plugin.json"), "utf8"));
  assert.equal(cursorManifest.mcpServers, "./cursor-mcp.json");
  assert.equal(cursorMcp.mcpServers["artemis-student"].cwd, "${CURSOR_PLUGIN_ROOT}");
  const asStandard = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      "artemis-student": {
        type: "stdio",
        command: "./bin/artemis-student-mcp",
        cwd: "${CURSOR_PLUGIN_ROOT}",
      },
    },
  };
  assert.equal(validateSchema(mcpSchema, asStandard).length > 0, true);
});

test("schema rejects an uppercase plugin name, an extra manifest field, and a reserved env name", () => {
  assert.equal(validateSchema(pluginSchema, { $schema: pluginSchema.$id, name: "Artemis" }).length > 0, true);
  assert.equal(validateSchema(pluginSchema, { $schema: pluginSchema.$id, name: "artemis-student", tools: [] }).length > 0, true);
  const reserved = {
    $schema: mcpSchema.$id,
    mcpServers: {
      demo: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/tmp" } },
    },
  };
  assert.equal(validateSchema(mcpSchema, reserved).length > 0, true);
});

test("the skill names list_courses and the package does not embed a credential", () => {
  const skill = fs.readFileSync(path.join(root, "skills/artemis-student/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: artemis-student\n/);
  assert.match(skill, /list_courses/);
  const scanned = [];
  for (const relative of ["src", "bin", "skills", "README.md", "plugin.json", "mcp.json", "docs"]) {
    walk(path.join(root, relative), scanned);
  }
  const text = scanned.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(/art_pat_[A-Za-z0-9]{8,}/.test(text), false);
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text), false);
  assert.equal(text.includes("pw-do-not-print"), false);
});

function walk(target, files) {
  if (!fs.existsSync(target)) {
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      walk(path.join(target, entry), files);
    }
    return;
  }
  files.push(target);
}
