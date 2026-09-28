import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

let apply;
let resolveGlobalConfigPath;
try {
  ({ apply, resolveGlobalConfigPath } = await import("../index.js"));
} catch {
  apply = undefined;
}

function fakeCtx() {
  const hooks = new Map();
  const tools = [];
  const ctx = {
    tools: { register(tool) { tools.push(tool); } },
    logger: { warn() {} },
    effect() {},
    on(name, fn) {
      const list = hooks.get(name) ?? [];
      list.push(fn);
      hooks.set(name, list);
      return () => {};
    },
    emit(name, ...args) {
      for (const fn of hooks.get(name) ?? []) fn(...args);
    },
    hooks,
    toolsRegistered: tools,
  };
  return ctx;
}

async function listeners(ctx, name) {
  return ctx.hooks.get(name) ?? [];
}

test("plugin ask-user tool publishes semantic hooks and still calls next()", { skip: !apply }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notify-plugin-"));
  const file = join(dir, "cfg.json");
  const seen = [];
  globalThis.__dshNotifySeen = seen;
  writeFileSync(
    file,
    JSON.stringify({
      events: {
        "tool_execution_start:ask_user_question": {
          delayMs: 0,
          actions: ["js:globalThis.__dshNotifySeen.push(['event', event.args.questions[0].question])"],
        },
        agent_settled: { delayMs: 0, actions: ["js:globalThis.__dshNotifySeen.push(['settled'])"] },
      },
      hooks: {
        "agent-notify": { delayMs: 0, actions: ["js:globalThis.__dshNotifySeen.push(['hook', notification.values.TITLE])"] },
        "ask-user-wait-started": { delayMs: 0, actions: ["js:globalThis.__dshNotifySeen.push(['started'])"] },
        "ask-user-wait-finished": { delayMs: 0, actions: ["js:globalThis.__dshNotifySeen.push(['finished'])"] },
      },
    }),
  );
  const ctx = fakeCtx();
  await apply(ctx, { configPath: file, enableHerdr: false });
  assert.equal(ctx.toolsRegistered.length, 1);
  assert.equal(ctx.toolsRegistered[0].name, "agent_notify");

  let nextCalls = 0;
  const pre = (await listeners(ctx, "tools/pre-execute"))[0];
  const agent = { id: "root", status: "running", session: { header: { cwd: "/work" } } };
  await pre(
    { name: "ask_user_question", callId: "c1", arguments: { questions: [{ question: "Go?" }] }, agent },
    () => {
      nextCalls += 1;
      return { kind: "allow" };
    },
  );
  await pre({ name: "bash", callId: "c2", arguments: {}, agent }, () => {
    nextCalls += 1;
    return { kind: "allow" };
  });
  const result = (await listeners(ctx, "tools/result"))[0];
  result({ name: "ask_user_question", callId: "c1", agent });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(nextCalls, 2);
  assert.ok(seen.some((row) => row[0] === "started"));
  assert.ok(seen.some((row) => row[0] === "finished"));
  assert.ok(seen.some((row) => row[0] === "event" && row[1] === "Go?"));

  const status = (await listeners(ctx, "agent/status"))[0];
  status({ agent, status: "idle" });
  await ctx.toolsRegistered[0].execute({ title: "Ping", content: "pong" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(seen.some((row) => row[0] === "settled"));
  assert.ok(seen.some((row) => row[0] === "hook" && row[1] === "Ping"));
  rmSync(dir, { recursive: true, force: true });
  delete globalThis.__dshNotifySeen;
});

test("herdr:blocked does not follow ask_user_question", { skip: !apply }, async () => {
  const ctx = fakeCtx();
  const blocked = [];
  ctx.on("herdr:blocked", (data) => blocked.push(data));
  await apply(ctx, { configPath: join(tmpdir(), "missing-dsh-notify.json"), enableHerdr: false, enableAgentNotifyTool: false });
  const pre = (await listeners(ctx, "tools/pre-execute"))[0];
  await pre({ name: "ask_user_question", callId: "c", arguments: {}, agent: { id: "r", session: { header: {} } } }, () => ({ kind: "allow" }));
  assert.equal(blocked.length, 0);
});

test("resolveGlobalConfigPath uses only the DSH file", () => {
  if (!resolveGlobalConfigPath) return;
  const dir = mkdtempSync(join(tmpdir(), "dsh-notify-path-"));
  assert.equal(resolveGlobalConfigPath(undefined, dir), join(dir, "dsh-notify.json"));
  const explicit = resolveGlobalConfigPath("  /tmp/custom.json  ", dir);
  assert.equal(explicit, "/tmp/custom.json");
  rmSync(dir, { recursive: true, force: true });
});
