import { CommandLaunchError } from "./command.js";
import { isShellTupleAction, parseShellTuple } from "./config.js";
import { createNotificationEnvironment, createTemplateValues, renderTemplate } from "./context.js";
import { isBarePowerShellExe, resolvePowerShell } from "./powershell.js";

function defaultRunJs(code, scope) {
  const runner = new Function(
    "ctx",
    "event",
    "notification",
    `"use strict"; return (async () => { ${code}\n })();`,
  );
  return Promise.resolve(runner(scope.ctx, scope.event, scope.notification)).then(() => undefined);
}

function parseOscAction(action, values, key, defaultOsc) {
  if (action === "osc") {
    if (defaultOsc) return defaultOsc;
    throw new Error(`Missing default OSC copy for ${key}`);
  }

  const template = action.slice(4);
  const separator = template.indexOf("|");
  return {
    title: renderTemplate(template.slice(0, separator), values),
    body: renderTemplate(template.slice(separator + 1), values),
  };
}

function resolveShellInterpreter(interpreter, runtime) {
  if (!isBarePowerShellExe(interpreter)) return interpreter;
  const resolved =
    runtime.resolvePowerShell?.() ?? resolvePowerShell({ platform: runtime.platform ?? process.platform });
  return resolved ?? interpreter;
}

function actionLabel(action) {
  if (isShellTupleAction(action)) return "shell";
  if (action === "bel") return "bel";
  if (action === "osc" || action.startsWith("osc:")) return "osc";
  if (action.startsWith("cmd:")) return "cmd";
  if (action.startsWith("js:")) return "js";
  return "action";
}

function buildJsNotification(notification, runtime, failures, createObserver, isCurrent) {
  const values = Object.freeze({ ...(notification.values ?? {}) });
  const launch = (label, operation) => {
    if (isCurrent && !isCurrent()) return;
    const observer = createObserver(label);
    try {
      operation(observer);
    } catch (error) {
      // Record once for aggregate reporting; still rethrow so surrounding js can observe.
      const message = error instanceof Error ? error.message : String(error);
      const failure = `${label}: ${message}`;
      if (!failures.includes(failure)) failures.push(failure);
      observer.reportFailure(error);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  return {
    ...notification,
    values,
    bel() {
      launch("bel", () => runtime.launchBel());
    },
    osc(title, body) {
      launch("osc", (observer) => runtime.launchOsc(title, body, observer));
    },
  };
}

export async function runActions(options) {
  const { actions, runtime, notification, throwOnFailure, isCurrent } = options;
  if (isCurrent && !isCurrent()) return;

  const values = createTemplateValues(notification);
  const environment = createNotificationEnvironment(notification);
  const failures = [];
  const runJs = runtime.runJs ?? defaultRunJs;
  const reportFailure = (label, error) => {
    if (isCurrent && !isCurrent()) return;
    options.onActionFailure?.(label, error);
  };
  const createObserver = (label) => {
    let reported = false;
    return {
      isCurrent: () => !isCurrent || isCurrent(),
      reportFailure(error) {
        if (reported || (isCurrent && !isCurrent())) return;
        reported = true;
        reportFailure(label, error);
      },
    };
  };
  const jsNotification = buildJsNotification(notification, runtime, failures, createObserver, isCurrent);

  for (const action of actions) {
    if (isCurrent && !isCurrent()) return;
    const label = actionLabel(action);
    const observer = createObserver(label);
    try {
      if (isShellTupleAction(action)) {
        const { interpreter, args } = parseShellTuple(action);
        const resolved = resolveShellInterpreter(interpreter, runtime);
        runtime.launchShell(resolved, args, notification.cwd, environment, observer);
        continue;
      }

      if (action === "bel") {
        runtime.launchBel();
        continue;
      }

      if (action === "osc" || action.startsWith("osc:")) {
        const { title, body } = parseOscAction(action, values, options.key, options.defaultOsc);
        runtime.launchOsc(title, body, observer);
        continue;
      }

      if (action.startsWith("cmd:")) {
        runtime.launchCommand(action.slice(4), notification.cwd, environment, observer);
        continue;
      }

      if (action.startsWith("js:")) {
        await runJs(action.slice(3), {
          ctx: options.ctx,
          event: options.event,
          notification: jsNotification,
        });
        if (isCurrent && !isCurrent()) return;
        continue;
      }
    } catch (error) {
      // Stale generation after await/shutdown: no warnings, no further actions, no aggregate report.
      if (isCurrent && !isCurrent()) return;

      const message = error instanceof Error ? error.message : String(error);
      const failure = `${label}: ${message}`;
      // notification.bel/osc already recorded their own failure; do not also count/report as js failure.
      const alreadyRecordedByHelper =
        label === "js" && (failures.includes(`bel: ${message}`) || failures.includes(`osc: ${message}`));
      if (!alreadyRecordedByHelper && !failures.includes(failure)) failures.push(failure);
      if (!alreadyRecordedByHelper) observer.reportFailure(error);
      if (!throwOnFailure && !options.onActionFailure && !alreadyRecordedByHelper) {
        // CommandLaunchError already warned at the launcher. Terminal actions report through the aggregate below.
        if (!(error instanceof CommandLaunchError) && label !== "bel" && label !== "osc") {
          runtime.warn(`Notification action failed (${label}): ${message}`);
        }
      }
    }
  }

  if (isCurrent && !isCurrent()) return;

  if (throwOnFailure && failures.length > 0) {
    throw new Error(`dsh-notify action failures: ${failures.join("; ")}`);
  }

  if (!throwOnFailure && !options.onActionFailure && failures.length > 0) {
    runtime.warn(`Notification actions reported ${failures.length} failure(s): ${failures.join("; ")}`);
  }
}
