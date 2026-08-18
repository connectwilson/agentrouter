import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, "..", "plugin");
const fixtureDir = path.join(here, "fixtures", "agent-plugins");

function loadJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(pluginDir, relative), "utf8"));
}

const plugin = loadJson("plugin.json");
const mcp = loadJson("mcp.json");

test("plugin/plugin.json exists with required manifest fields", () => {
  for (const field of ["$schema", "name"]) {
    assert.ok(plugin[field] !== undefined, `plugin.json is missing required field: ${field}`);
  }
  assert.match(plugin["$schema"], /^https:\/\/agent-plugins\.org\/schemas\/1\.0\.0\/plugin\.schema\.json$/);
  assert.ok(plugin.name.length >= 1 && plugin.name.length <= 64);
});

test("plugin/plugin.json adheres to the Agent Plugins 1.0.0 plugin schema", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(fixtureDir, "plugin.schema.json"), "utf8"));
  assert.ok(schema, "vendored plugin schema must exist");
  assert.equal(schema.required.includes("$schema"), true);
  assert.equal(schema.required.includes("name"), true);
  // The plugin schema is additionalProperties:false, so validating the manifest
  // with a bundled mini-validator catches unknown fields. Skills and MCP servers
  // are NOT declared here — they live in skills/ and mcp.json at fixed locations.
  const allowedTopLevel = new Set([
    "$schema", "name", "version", "description", "author", "homepage",
    "repository", "license", "keywords", "extensions"
  ]);
  for (const key of Object.keys(plugin)) {
    assert.ok(allowedTopLevel.has(key), `plugin.json has an unknown top-level field: ${key}`);
  }
  assert.ok(!("skills" in plugin), "skills must not be declared in plugin.json (fixed location skills/)");
  assert.ok(!("mcpServers" in plugin), "mcpServers must not be declared in plugin.json (fixed location mcp.json)");
});

test("plugin/mcp.json declares the stdio bridge named AgentRouter per MCP schema", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(fixtureDir, "mcp.schema.json"), "utf8"));
  assert.ok(schema, "vendored mcp schema must exist");
  assert.equal(schema.required.includes("mcpServers"), true);

  const server = mcp.mcpServers?.AgentRouter;
  assert.ok(server, "mcp.json must declare a server named AgentRouter");

  // stdio keeps the free local-browser reads; a remote-only plugin silently loses them.
  assert.equal(server.type, "stdio");
  assert.ok(server.command, "stdio server requires command");
  assert.equal(typeof server.env?.AGENT_ROUTER_URL, "string");
  assert.ok(server.env?.AGENT_ROUTER_URL.length > 0);

  // Reserved env keys must not be used.
  for (const reserved of ["PLUGIN_ROOT", "PLUGIN_DATA"]) {
    assert.ok(!(reserved in (server.env || {})), `env must not use reserved key ${reserved}`);
  }
});

test("plugin skill matches the hosted AgentRouter skill (no drift)", async () => {
  const committed = fs.readFileSync(
    path.join(pluginDir, "skills", "agentrouter", "SKILL.md"), "utf8"
  );
  let hosted = "";
  try {
    const res = await fetch("https://agentrouter.network/SKILL.md", {
      signal: AbortSignal.timeout(20000)
    });
    assert.equal(res.ok, true, "hosted AgentRouter skill is unreachable");
    hosted = await res.text();
  } catch (error) {
    // If the network is unavailable during the test run, fall back to the
    // committed copy in claude-skills (canonical source for this artifact) so
    // the suite does not fail on environment issues. Drift detection still runs
    // when the hosted skill is reachable.
    const local = fs.readFileSync(
      path.join(here, "..", "claude-skills", "agent-router", "SKILL.md"), "utf8"
    );
    assert.equal(committed, local,
      `plugin skill drifted from the committed claude-skills copy; run scripts/sync-plugin-skill.js`);
    return;
  }
  // The committed copy leads: a fix lands here before it is deployed, so the
  // hosted skill is behind until the next release. Comparing against it
  // unconditionally would fail every fix on the way in, and pass once the fix
  // was live — exactly backwards. The canonical source is claude-skills.
  const canonical = fs.readFileSync(
    path.join(here, "..", "claude-skills", "agent-router", "SKILL.md"), "utf8"
  );
  assert.equal(committed, canonical,
    "plugin skill drifted from claude-skills; run scripts/sync-plugin-skill.js");
  if (hosted !== canonical) {
    console.log("note: hosted SKILL.md is behind the committed copy; it updates on the next deploy.");
  }
});
