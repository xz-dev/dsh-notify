import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runActions } from "../lib/actions.js";
import { loadConfig, getHookBinding } from "../lib/config.js";
import { createTemplateValues, renderTemplate } from "../lib/context.js";
import { createHerdrReporter } from "../lib/herdr.js";
import { parseSemanticHook, publishSemanticHook } from "../lib/semantic-hook.js";

test("config keeps user-shaped events and hooks, drops bad actions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notify-"));
  const file = join(dir, "dsh-notify.json");
  writeFileSync(
    file,
    JSON.stringify({
      events: {
        agent_settled: { delayMs: 0, actions: ["bel", "nope"] },
        "tool_execution_start:ask_user_question": { delayMs: 0, actions: [] },
      },
      hooks: {
        "agent-notify": {
          delayMs: 0,
          actions: ["osc:{{TITLE}}|{{CONTENT}}", "cmd:echo hi"],
        },
        BadName: { delayMs: 0, actions: ["bel"] },
      },
    }),
  );
  const warnings = [];
  const config = await loadConfig({ globalPath: file, cwd: dir, allowProjectConfig: false, warn: (m) => warnings.push(m) });
  assert.deepEqual(config.events.agent_settled.actions, ["bel"]);
  assert.deepEqual(config.events["tool_execution_start:ask_user_question"].actions, []);
  assert.equal(getHookBinding(config.hooks, "agent-notify").actions.length, 2);
  assert.equal(getHookBinding(config.hooks, "constructor"), undefined);
  assert.ok(warnings.some((m) => m.includes("BadName")));
  rmSync(dir, { recursive: true });
});

test("live dsh-notify.json parses when present", async () => {
  const file = join(process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh"), "dsh-notify.json");
  const { existsSync } = await import("node:fs");
  if (!existsSync(file)) return;
  const warnings = [];
  const config = await loadConfig({
    globalPath: file,
    cwd: tmpdir(),
    allowProjectConfig: false,
    warn: (m) => warnings.push(m),
  });
  for (const name of ["agent-notify", "user-ready", "watchdog-continued", "watchdog-waiting", "reflection-completed"]) {
    assert.ok(getHookBinding(config.hooks, name)?.actions.length > 0, name);
  }
  assert.ok(config.events["tool_execution_start:ask_user_question"].actions.length > 0);
  assert.equal(warnings.length, 0, warnings.join("\n"));
});

test("semantic hook rejects bad envelopes and publishes valid ones", () => {
  assert.equal(parseSemanticHook({ version: 2, name: "agent-notify" }).ok, false);
  assert.equal(parseSemanticHook({ version: 1, name: "Agent" }).ok, false);
  const seen = [];
  const bus = {
    on(name, fn) {
      bus.fn = fn;
      bus.name = name;
    },
    emit(name, data) {
      seen.push([name, data]);
    },
  };
  const envelope = publishSemanticHook(bus, { name: "agent-notify", values: { TITLE: "T", CONTENT: "C" } });
  assert.equal(envelope.name, "agent-notify");
  assert.equal(seen[0][0], "pi:semantic-hook:v1");
  assert.equal(seen[0][1].values.TITLE, "T");
});

test("js action reads Pi-shaped event.args and calls notification.osc", async () => {
  const osc = [];
  await runActions({
    key: "tool_execution_start:ask_user_question",
    actions: [
      "js:const questions = event?.args?.questions?.map((item) => item?.question).filter((q) => typeof q === 'string') ?? []; notification.osc('Q', questions.join('\\n'));",
    ],
    event: { args: { questions: [{ question: "Ship it?" }] } },
    notification: {
      event: "tool_execution_start:ask_user_question",
      cwd: "/tmp",
      hostname: "box",
      sessionId: "s1",
      values: {},
    },
    runtime: {
      launchBel() {},
      launchOsc(title, body) {
        osc.push([title, body]);
      },
      launchCommand() {},
      launchShell() {},
      warn() {},
    },
    throwOnFailure: true,
  });
  assert.deepEqual(osc, [["Q", "Ship it?"]]);
});

test("cmd action exports PI_NOTIFY_* and osc templates render", async () => {
  const calls = [];
  const notification = {
    event: "hook:agent-notify",
    hook: "agent-notify",
    cwd: "/work",
    hostname: "box",
    sessionId: "sid",
    values: { TITLE: "Hi", CONTENT: "Body" },
  };
  const values = createTemplateValues(notification);
  assert.equal(renderTemplate("{{TITLE}} · {{HOSTNAME}}", values), "Hi · box");
  await runActions({
    key: "hook:agent-notify",
    actions: ["cmd:delivery agent"],
    event: {},
    notification,
    runtime: {
      launchBel() {},
      launchOsc() {},
      launchCommand(command, cwd, env) {
        calls.push({ command, cwd, title: env.PI_NOTIFY_TITLE, content: env.PI_NOTIFY_CONTENT, session: env.PI_NOTIFY_SESSION_ID });
      },
      launchShell() {},
      warn() {},
    },
    throwOnFailure: true,
  });
  assert.equal(calls[0].command, "delivery agent");
  assert.equal(calls[0].cwd, "/work");
  assert.equal(calls[0].title, "Hi");
  assert.equal(calls[0].content, "Body");
  assert.equal(calls[0].session, "sid");
});

test("herdr reports session then blocked/idle on the pane socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notify-herdr-"));
  const sock = join(dir, "herdr.sock");
  const lines = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes("\n")) {
        lines.push(JSON.parse(buf.trim()));
        socket.write("ok\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    const herdr = createHerdrReporter({
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: sock, HERDR_PANE_ID: "pane-1" },
    });
    assert.equal(herdr.enabled(), true);
    herdr.updateSessionRef({ sessionId: "sess" });
    await herdr.sessionStarted("startup", { running: true });
    herdr.blocked(true, "needs attention");
    await new Promise((resolve) => setTimeout(resolve, 50));
    herdr.blocked(false);
    herdr.agentIdle();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(lines[0].method, "pane.report_agent_session");
    assert.equal(lines[0].params.agent, "pi");
    assert.equal(lines[0].params.source, "herdr:pi");
    assert.equal(lines[0].params.agent_session_id, "sess");
    assert.equal(lines[0].params.session_start_source, "startup");
    const states = lines.filter((line) => line.method === "pane.report_agent").map((line) => line.params.state);
    assert.ok(states.includes("working"));
    assert.ok(states.includes("blocked"));
    assert.equal(states.at(-1), "idle");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
