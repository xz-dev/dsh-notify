import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

let apply;
try {
  ({ apply } = await import("../index.js"));
} catch {
  apply = undefined;
}

function fakeCtx() {
  const hooks = new Map();
  return {
    tools: { register() {} },
    logger: { warn() {} },
    effect() {},
    on(name, fn) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
      return () => {};
    },
    emit(name, ...args) {
      for (const fn of hooks.get(name) ?? []) fn(...args);
    },
    hook: (name) => (hooks.get(name) ?? [])[0],
  };
}

async function herdrServer() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notify-waits-"));
  const sock = join(dir, "herdr.sock");
  const lines = [];
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        socket.write("ok\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  return {
    sock,
    states: () => lines.filter((l) => l.method === "pane.report_agent").map((l) => [l.params.state, l.params.message]),
    close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

// DSH state, not the TUI: gate is HERDR_ENV + pane + root agent, no isTTY.
test("approval/asked -> blocked, approval/decided -> working, idle clears", { skip: !apply }, async () => {
  const srv = await herdrServer();
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: srv.sock, HERDR_PANE_ID: "p1" });
  try {
    const ctx = fakeCtx();
    await apply(ctx, { configPath: join(tmpdir(), "missing-dsh-notify.json"), enableAgentNotifyTool: false });
    const root = { id: "root", status: "running", session: { header: { delegationDepth: 0 } } };
    const child = { id: "child", status: "running", session: { header: { delegationDepth: 1 } } };
    await ctx.hook("agent/created")({ agent: root, source: "startup" });
    const ev = ctx.hook("session/event");
    // Child approval also waits on the human.
    ev(child.session, { type: "approval/asked", data: { id: "a1", toolName: "bash" } });
    await settle();
    ev(child.session, { type: "approval/decided", data: { id: "a1", outcome: "allowed-once" } });
    await settle();
    // Unmatched decision and unrelated events are ignored.
    ev(root.session, { type: "approval/decided", data: { id: "zz", outcome: "denied" } });
    ev(root.session, { type: "assistant/message", data: {} });
    // Open approval then turn ends without a decision (crash tail): idle clears it.
    ev(root.session, { type: "approval/asked", data: { id: "a2", toolName: "edit" } });
    await settle();
    ctx.hook("agent/status")({ agent: root, status: "idle" });
    await settle();
    assert.deepEqual(srv.states(), [
      ["working", undefined],
      ["blocked", "approval: bash"],
      ["working", undefined],
      ["blocked", "approval: edit"],
      ["idle", undefined],
    ]);
  } finally {
    process.env = saved;
    srv.close();
  }
});

test("ask_user_question -> blocked until its tools/result", { skip: !apply }, async () => {
  const srv = await herdrServer();
  const saved = { ...process.env };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: srv.sock, HERDR_PANE_ID: "p1" });
  try {
    const ctx = fakeCtx();
    await apply(ctx, { configPath: join(tmpdir(), "missing-dsh-notify.json"), enableAgentNotifyTool: false });
    const root = { id: "root", status: "running", session: { header: {} } };
    await ctx.hook("agent/created")({ agent: root, source: "startup" });
    await ctx.hook("tools/pre-execute")({ name: "ask_user_question", callId: "q1", arguments: {}, agent: root }, () => ({ kind: "allow" }));
    await settle();
    ctx.hook("tools/result")({ name: "ask_user_question", callId: "q1", agent: root });
    await settle();
    assert.deepEqual(srv.states(), [
      ["working", undefined],
      ["blocked", "question"],
      ["working", undefined],
    ]);
  } finally {
    process.env = saved;
    srv.close();
  }
});

test("outside a herdr pane nothing is reported", { skip: !apply }, async () => {
  const saved = { ...process.env };
  delete process.env.HERDR_ENV;
  try {
    const ctx = fakeCtx();
    await apply(ctx, { configPath: join(tmpdir(), "missing-dsh-notify.json"), enableAgentNotifyTool: false });
    const root = { id: "root", status: "running", session: { header: {} } };
    await ctx.hook("agent/created")({ agent: root, source: "startup" });
    ctx.hook("session/event")(root.session, { type: "approval/asked", data: { id: "a", toolName: "bash" } });
  } finally {
    process.env = saved;
  }
});
