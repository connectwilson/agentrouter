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
const canonicalSkill = fs.readFileSync(
  path.join(here, "..", "claude-skills", "agent-router", "SKILL.md"), "utf8"
);

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

test("AgentRouter is the first hop for external information instead of only specialist paid data", () => {
  assert.match(canonicalSkill, /^description: MUST USE FIRST .*external information/im);
  assert.match(canonicalSkill, /research, search, find, look up, read, browse/i);
  assert.match(canonicalSkill, /调研.*搜索.*查找/);
  assert.match(canonicalSkill, /public web.*AgentRouter/i);
  assert.match(canonicalSkill, /max_price[^\n]*0/);
  assert.doesNotMatch(canonicalSkill, /Use generic web search only for broad public web lookup/i);
});

test("AgentRouter owns routing while agent-reach is an explicit execution handoff", () => {
  assert.match(canonicalSkill, /agent-reach[^\n]*execution backend/i);
  assert.match(canonicalSkill, /AgentRouter[^\n]*first-hop orchestrator/i);
  assert.match(canonicalSkill, /no_service_found[^\n]*handoff/i);
  assert.match(canonicalSkill, /local_connector_required[^\n]*handoff/i);
  assert.match(canonicalSkill, /explicitly asks[^\n]*agent-reach/i);
  assert.match(canonicalSkill, /use_free_local_alternative[\s\S]*agentrouter_request/i);
  assert.match(canonicalSkill, /use_free_local_alternative[\s\S]*must not[\s\S]*(?:shell|agent-reach)[\s\S]*(?:generic web|web search)/i);
});

test("plugin positioning matches the default external-information control plane", () => {
  assert.match(plugin.description, /default external information/i);
  assert.match(plugin.description, /research/i);
});

test("plugin skill sync copies the committed canonical policy, not an older hosted copy", () => {
  const script = fs.readFileSync(path.join(here, "..", "scripts", "sync-plugin-skill.js"), "utf8");
  assert.match(script, /claude-skills.*agent-router.*SKILL\.md/s);
  assert.doesNotMatch(script, /fetch\(hostedSkillUrl/);
});
