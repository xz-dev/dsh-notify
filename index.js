/**
 * dsh-notify — port of pi-notify (neutral semantic hooks, agent_notify tool,
 * configured bel/osc/cmd/shell/js actions) plus the ask-user-semantic-hook
 * and herdr-agent-state extensions to DeepSeek Harness.
 *
 * Behaviour contract and gap list: see BEHAVIOR.md.
 */
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { runActions } from "./lib/actions.js";
import { createBelLauncher } from "./lib/bel.js";
import { createCommandLauncher, createShellLauncher } from "./lib/command.js";
import { getHookBinding, loadConfig, SYSTEM_TEMPLATE_KEYS } from "./lib/config.js";
import { createOscLauncher } from "./lib/osc.js";
import { resolvePowerShell } from "./lib/powershell.js";
import { publishSemanticHook, subscribeSemanticHooks } from "./lib/semantic-hook.js";
import { createHerdrReporter } from "./lib/herdr.js";

export const name = "dsh-notify";
export const inject = ["tools"];

export const Config = z.object({
  /** Explicit global config file; default `$DSH_HOME/dsh-notify.json` (~/.dsh/dsh-notify.json). */
  configPath: z.string().default(""),
  /** Also read `<cwd>/.dsh/dsh-notify.json` (whole-unit overrides). Off by default: DSH has no trust seam yet. */
  allowProjectConfig: z.boolean().default(false),
  /** Register the model-facing `agent_notify` tool when the `agent-notify` hook has actions. */
  enableAgentNotifyTool: z.boolean().default(true),
  /** Publish ask-user-wait-started/finished semantic hooks around ask_user_question calls. */
  enableAskUserHook: z.boolean().default(true),
  /** Report agent working/blocked/idle state to herdr when launched inside a herdr pane. */
  enableHerdr: z.boolean().default(true),
});

const AGENT_NOTIFY_HOOK = "agent-notify";
const ASK_USER_TOOL = "ask_user_question";
const ASK_USER_WAIT_STARTED_HOOK = "ask-user-wait-started";
const ASK_USER_WAIT_FINISHED_HOOK = "ask-user-wait-finished";

const LIFECYCLE_DEFAULT_OSC = {
  agent_settled: { title: "DSH", body: "Ready for input" },
  "tool_execution_start:ask_user_question": { title: "DSH", body: "Question needs your input" },
};

const systemTemplateKeySet = new Set(SYSTEM_TEMPLATE_KEYS);

function copyProducerValues(values) {
  const copied = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (systemTemplateKeySet.has(key)) continue;
    copied[key] = value;
  }
  return Object.freeze(copied);
}

function copyJson(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function defaultScheduler() {
  return {
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

function currentHostname() {
  return (process.env.HOSTNAME ?? hostname()).trim() || "unknown-host";
}

/** Pi-shaped tool event so existing js: actions reading event.args.* keep working. */
function toolEventOf(exec) {
  return {
    toolName: exec.name,
    toolCallId: exec.callId,
    args: exec.arguments,
  };
}

function sessionRefOf(agent) {
  return {
    sessionId: typeof agent?.id === "string" && agent.id.length > 0 ? agent.id : "unknown-session",
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
  };
}

function buildLifecycleNotification(key, agent, toolEvent) {
  const ref = sessionRefOf(agent);
  return {
    event: key,
    cwd: ref.cwd,
    hostname: currentHostname(),
    sessionId: ref.sessionId,
    values: Object.freeze({}),
    ...(toolEvent?.toolName === undefined ? {} : { tool: toolEvent.toolName }),
    ...(toolEvent?.toolCallId === undefined ? {} : { toolCallId: toolEvent.toolCallId }),
  };
}

function buildHookNotification(name, values, agent) {
  const ref = sessionRefOf(agent);
  return {
    event: `hook:${name}`,
    hook: name,
    cwd: ref.cwd,
    hostname: currentHostname(),
    sessionId: ref.sessionId,
    values: copyProducerValues(values),
  };
}

function isRootAgent(agent) {
  try {
    const depth = agent?.session?.header?.delegationDepth;
    return depth === undefined || depth === 0;
  } catch {
    return false;
  }
}

function bindingHasActions(binding) {
  return (
    !!binding &&
    binding.actions.some((action) =>
      Array.isArray(action) ? true : typeof action === "string" && action.trim().length > 0,
    )
  );
}

/** `$DSH_HOME/dsh-notify.json`, else the live Pi file, else the DSH path (missing = empty). */
export function resolveGlobalConfigPath(configPath, dshHome) {
  const explicit = typeof configPath === "string" ? configPath.trim() : "";
  if (explicit) return explicit;
  const dshPath = join(dshHome, "dsh-notify.json");
  if (existsSync(dshPath)) return dshPath;
  const piPath = join(homedir(), ".pi", "agent", "pi-notify.json");
  if (existsSync(piPath)) return piPath;
  return dshPath;
}

export async function apply(ctx, config = {}) {
  const warn = (message) => ctx.logger.warn(`[dsh-notify] ${message}`);
  const notifyError = (message) => {
    try {
      const toast = ctx.tuiToast;
      if (toast && typeof toast.show === "function") toast.show(message, { color: "error" });
    } catch (error) {
      warn(`Cannot show notification action failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const globalPath = resolveGlobalConfigPath(config.configPath, dshHome);
  const configOptions = {
    globalPath,
    get cwd() {
      return process.cwd();
    },
    allowProjectConfig: config.allowProjectConfig === true,
    warn,
  };

  const runtime = {
    launchBel: createBelLauncher(),
    launchOsc: createOscLauncher({ warn }),
    launchCommand: createCommandLauncher({ warn }),
    launchShell: createShellLauncher({ warn }),
    resolvePowerShell: () => resolvePowerShell(),
    warn,
  };
  const scheduler = defaultScheduler();

  const state = {
    generation: 0,
    pending: new Set(),
    cleaned: false,
  };
  const isCurrent = (generation) => !state.cleaned && state.generation === generation;

  function cancelPending() {
    for (const work of state.pending) {
      try {
        scheduler.clearTimeout(work.handle);
      } catch {
        // ignore
      }
    }
    state.pending.clear();
  }

  function scheduleBinding(options) {
    if (state.cleaned) return;
    const generation = state.generation;
    const actions = options.actions.slice();
    const causalEvent = copyJson(options.causalEvent);
    const defaultOsc = options.defaultOsc ? { ...options.defaultOsc } : undefined;
    const key = options.key;

    const run = async () => {
      if (!isCurrent(generation)) return;
      try {
        const notification = options.buildNotification();
        if (!isCurrent(generation)) return;
        await runActions({
          key,
          actions,
          ctx,
          event: causalEvent,
          runtime,
          notification,
          throwOnFailure: false,
          defaultOsc,
          isCurrent: () => isCurrent(generation),
          onActionFailure: (label, error) => {
            if (!isCurrent(generation)) return;
            const message = error instanceof Error ? error.message : String(error);
            const diagnostic = `dsh-notify · ${key.startsWith("hook:") ? key : `event:${key}`} · ${label} action failed: ${message}`;
            warn(diagnostic);
            notifyError(diagnostic);
          },
        });
      } catch (error) {
        if (!isCurrent(generation)) return;
        const message = error instanceof Error ? error.message : String(error);
        warn(`Notification pipeline failed (${key}): ${message}`);
      }
    };

    if (options.delayMs === 0) {
      // Same conceptual flow without an unnecessary timer: schedule as a microtask-like async turn.
      const handle = { unref() { return this; } };
      const work = { handle, generation };
      state.pending.add(work);
      queueMicrotask(() => {
        state.pending.delete(work);
        void run();
      });
      return;
    }

    const work = { generation, handle: undefined };
    work.handle = scheduler.setTimeout(() => {
      state.pending.delete(work);
      void run();
    }, options.delayMs);
    try {
      work.handle.unref?.();
    } catch {
      // ignore
    }
    state.pending.add(work);
  }

  async function handleLifecycle(key, event, agent, toolEvent) {
    if (state.cleaned) return;
    try {
      const fileConfig = await loadConfig(configOptions);
      if (state.cleaned) return;
      const binding = fileConfig.events[key];
      if (!bindingHasActions(binding)) return;

      scheduleBinding({
        delayMs: binding.delayMs,
        actions: binding.actions,
        key,
        defaultOsc: LIFECYCLE_DEFAULT_OSC[key],
        causalEvent: event,
        buildNotification: () => buildLifecycleNotification(key, agent, toolEvent),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Lifecycle notification failed (${key}): ${message}`);
    }
  }

  function handleSemanticHook(envelope) {
    if (state.cleaned) return;
    void dispatchHook(envelope);
  }

  async function dispatchHook(envelope) {
    if (state.cleaned) return;
    try {
      const fileConfig = await loadConfig(configOptions);
      if (state.cleaned) return;
      const binding = getHookBinding(fileConfig.hooks, envelope.name);
      // Unconfigured names are silent (including prototype names like constructor).
      if (!bindingHasActions(binding)) return;

      const values = copyProducerValues(envelope.values);
      scheduleBinding({
        delayMs: binding.delayMs,
        actions: binding.actions,
        key: `hook:${envelope.name}`,
        causalEvent: {
          version: 1,
          name: envelope.name,
          ...(Object.keys(values).length > 0 ? { values: { ...values } } : {}),
        },
        buildNotification: () => buildHookNotification(envelope.name, values, currentRootAgent),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Hook notification failed (${envelope.name}): ${message}`);
    }
  }

  // --- Herdr agent state ---
  // Driven by DSH agent/session state, not the TUI: active when herdr launched this
  // process (HERDR_ENV + socket + pane); only the root agent owns the pane.
  const herdr = config.enableHerdr === false ? null : createHerdrReporter();
  const herdrActive = herdr?.enabled() === true;
  let currentRootAgent;
  let rootSession = false;

  // --- Listeners ---
  const disposers = [];

  disposers.push(
    subscribeSemanticHooks(
      ctx,
      (envelope) => handleSemanticHook(envelope),
      (reason) => warn(`Ignoring invalid semantic hook envelope: ${reason}`),
    ),
  );

  if (config.enableAskUserHook !== false) {
    disposers.push(
      ctx.on("rpiv:ask-user:blocked", (payload) => {
        if (state.cleaned || payload === null || typeof payload !== "object" || typeof payload.active !== "boolean") return;
        const hookName = payload.active ? ASK_USER_WAIT_STARTED_HOOK : ASK_USER_WAIT_FINISHED_HOOK;
        try {
          publishSemanticHook(ctx, { name: hookName });
        } catch (error) {
          warn(`Cannot publish ${hookName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
  }

  disposers.push(
    ctx.on("agent/created", async ({ agent, source }) => {
      if (state.cleaned || !isRootAgent(agent)) return;
      currentRootAgent = agent;
      if (!herdrActive) return;
      rootSession = true;
      herdr.updateSessionRef({ sessionId: agent.id });
      await herdr.sessionStarted(source, { running: agent.status === "running" });
    }),
  );

  disposers.push(
    ctx.on("herdr:blocked", (data) => {
      if (!herdrActive || !rootSession || state.cleaned) return;
      herdr.blocked(data?.active === true, typeof data?.label === "string" ? data.label : undefined);
    }),
  );

  disposers.push(
    ctx.on("agent/status", ({ agent, status }) => {
      if (state.cleaned) return;
      if (isRootAgent(agent)) currentRootAgent = agent;
      if (herdrActive && rootSession && isRootAgent(agent)) {
        herdr.updateSessionRef({ sessionId: agent.id });
        if (status === "running") herdr.agentRunning();
        else herdr.agentIdle();
      }
      if (status === "idle" && isRootAgent(agent)) {
        // Pi agent_settled: root agent ready for input.
        void handleLifecycle("agent_settled", { agentId: agent?.id }, agent);
      }
    }),
  );

  // Tool approvals from the durable session log (dsh-user-approval): any agent in
  // this process, because a child's approval also waits on the human.
  disposers.push(
    ctx.on("session/event", (_session, event) => {
      if (!herdrActive || !rootSession || state.cleaned) return;
      const id = event?.data?.id;
      if (typeof id !== "string") return;
      if (event.type === "approval/asked") {
        const tool = typeof event.data.toolName === "string" ? event.data.toolName : "tool";
        herdr.waitStarted(`approval:${id}`, `approval: ${tool}`);
      } else if (event.type === "approval/decided") {
        herdr.waitFinished(`approval:${id}`);
      }
    }),
  );

  disposers.push(
    ctx.on("tools/pre-execute", async (exec, next) => {
      if (exec.name !== ASK_USER_TOOL || state.cleaned) return next();
      if (herdrActive && rootSession) herdr.waitStarted(`ask:${exec.callId}`, "question");
      const toolEvent = toolEventOf(exec);
      if (exec.agent && isRootAgent(exec.agent)) currentRootAgent = exec.agent;
      // DSH ask_user_question does not emit rpiv:ask-user:blocked; synthesize it.
      if (config.enableAskUserHook !== false) ctx.emit("rpiv:ask-user:blocked", { active: true });
      void handleLifecycle("tool_execution_start:ask_user_question", toolEvent, exec.agent, toolEvent);
      return next();
    }),
  );

  disposers.push(
    ctx.on("tools/result", (exec) => {
      if (exec.name !== ASK_USER_TOOL || state.cleaned) return;
      if (herdrActive && rootSession) herdr.waitFinished(`ask:${exec.callId}`);
      if (config.enableAskUserHook !== false) ctx.emit("rpiv:ask-user:blocked", { active: false });
    }),
  );

  // --- agent_notify tool: registered only when the hook binding has actions (Pi parity). ---
  if (config.enableAgentNotifyTool !== false) {
    try {
      const fileConfig = await loadConfig(configOptions);
      if (bindingHasActions(getHookBinding(fileConfig.hooks, AGENT_NOTIFY_HOOK))) {
        ctx.tools.register(
          defineTool({
            name: "agent_notify",
            description:
              "Publish a neutral agent-notify semantic hook with required title and content for configured dsh-notify consumers.",
            parameters: {
              title: { type: "string", required: true, description: "User-facing notification title" },
              content: { type: "string", required: true, description: "User-facing notification content/body" },
            },
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  published: { type: "boolean", required: true },
                },
              },
              render: (_args, value) => [
                { type: "text", text: value.published ? "Notification hook published" : "Notification hook not published" },
              ],
            },
            async execute(args) {
              publishSemanticHook(ctx, {
                name: AGENT_NOTIFY_HOOK,
                values: { TITLE: args.title, CONTENT: args.content },
              });
              return { published: true };
            },
          }),
        );
      }
    } catch (error) {
      warn(`Cannot evaluate agent_notify registration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  ctx.effect(() => () => {
    state.cleaned = true;
    state.generation += 1;
    cancelPending();
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
  });
}
