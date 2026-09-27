import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  clipDiagnostic,
  isKebabCaseName,
  isPlainObject,
  readOwnDataProperty,
} from "./config-value.js";

export const LIFECYCLE_EVENT_KEYS = [
  "agent_settled",
  "tool_execution_start:ask_user_question",
];

/** Consumer-owned keys that producer values cannot override. */
export const SYSTEM_TEMPLATE_KEYS = [
  "EVENT",
  "HOOK",
  "CWD",
  "HOSTNAME",
  "SESSION_ID",
  "SESSION_FILE",
  "TOOL",
  "TOOL_CALL_ID",
];

/** @deprecated Legacy flat key list retained only for migration diagnostics. */
export const LEGACY_TOP_LEVEL_KEYS = [
  "agent_settled",
  "tool_execution_start:ask_user_question",
  "pi_notify:agent_notify",
];

/** Node timer maximum (2^31-1). */
export const MAX_DELAY_MS = 2_147_483_647;

/** Bound action text so malformed config diagnostics stay finite. */
export const MAX_ACTION_TEXT_LENGTH = 8_192;

const lifecycleKeys = new Set(LIFECYCLE_EVENT_KEYS);
const legacyTopLevelKeys = new Set(LEGACY_TOP_LEVEL_KEYS);

function emptyHooks() {
  return Object.create(null);
}

function emptyEvents() {
  return Object.create(null);
}

export function isShellTupleAction(value) {
  if (!Array.isArray(value) || value.length < 2) return false;
  if (!value.every((item) => typeof item === "string")) return false;
  const head = value[0];
  if (!head.startsWith("shell:")) return false;
  if (head.length > MAX_ACTION_TEXT_LENGTH) return false;
  if (value.some((item) => item.length > MAX_ACTION_TEXT_LENGTH)) return false;
  const interpreter = head.slice("shell:".length);
  return interpreter.trim().length > 0;
}

function isStringAction(value) {
  if (value === "bel" || value === "osc") return true;
  if (typeof value !== "string") return false;
  if (value.length > MAX_ACTION_TEXT_LENGTH) return false;
  if (value.startsWith("cmd:")) return value.slice(4).trim().length > 0;
  if (value.startsWith("js:")) return value.slice(3).trim().length > 0;
  // Obsolete string form shell:<interpreter>:<raw> is intentionally invalid.
  if (value.startsWith("shell:")) return false;
  if (!value.startsWith("osc:")) return false;

  const template = value.slice(4);
  const separator = template.indexOf("|");
  return separator > 0 && separator < template.length - 1;
}

function isAction(value) {
  return isStringAction(value) || isShellTupleAction(value);
}

export function parseShellTuple(action) {
  const head = action[0];
  return {
    interpreter: head.slice("shell:".length),
    args: action.slice(1),
  };
}

function isSafeDelayMs(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DELAY_MS
  );
}

function formatActionForDiagnostic(action) {
  try {
    const text = typeof action === "string" ? action : JSON.stringify(action);
    return clipDiagnostic(text ?? String(action));
  } catch {
    return "[unprintable action]";
  }
}

/**
 * Parse an actions array.
 * - `[]` is a valid explicit disable list.
 * - A nonempty array whose every entry is rejected is invalid (caller preserves lower-precedence binding).
 * - Mixed arrays keep only valid entries.
 */
function parseActions(value, pathLabel, bindingLabel, options) {
  if (!Array.isArray(value)) {
    options.warn(`Ignoring ${bindingLabel} in ${pathLabel}: actions must be an array`);
    return undefined;
  }

  const actions = [];
  let rejected = 0;
  for (const action of value) {
    if (options.rejectBareOsc && action === "osc") {
      options.warn(
        `Ignoring bare osc action for hook binding ${bindingLabel} in ${pathLabel}: hook bindings require osc:<title>|<body> or notification.osc in js`,
      );
      rejected += 1;
      continue;
    }
    if (isAction(action)) actions.push(action);
    else {
      rejected += 1;
      options.warn(
        `Ignoring invalid action ${JSON.stringify(formatActionForDiagnostic(action))} for ${bindingLabel} in ${pathLabel}`,
      );
    }
  }

  // Explicit empty actions is a valid whole-unit disable.
  if (value.length === 0) return actions;

  // Nonempty but all-rejected means the higher-precedence binding is invalid.
  if (actions.length === 0 && rejected > 0) {
    options.warn(`Ignoring ${bindingLabel} in ${pathLabel}: no valid actions after validation`);
    return undefined;
  }

  return actions;
}

function parseBinding(value, pathLabel, bindingLabel, options) {
  if (!isPlainObject(value)) {
    options.warn(`Ignoring ${bindingLabel} in ${pathLabel}: binding must be an object`);
    return undefined;
  }

  if (!Object.hasOwn(value, "actions")) {
    options.warn(`Ignoring ${bindingLabel} in ${pathLabel}: actions is required`);
    return undefined;
  }

  const actionsProp = readOwnDataProperty(value, "actions");
  if (!actionsProp.ok) {
    options.warn(`Ignoring ${bindingLabel} in ${pathLabel}: actions ${actionsProp.reason}`);
    return undefined;
  }

  let delayMs = 0;
  if (Object.hasOwn(value, "delayMs")) {
    const delayProp = readOwnDataProperty(value, "delayMs");
    if (!delayProp.ok) {
      options.warn(`Ignoring ${bindingLabel} in ${pathLabel}: delayMs ${delayProp.reason}`);
      return undefined;
    }
    if (delayProp.value !== undefined) {
      if (!isSafeDelayMs(delayProp.value)) {
        options.warn(
          `Ignoring ${bindingLabel} in ${pathLabel}: delayMs must be a nonnegative safe integer ms within the Node timer maximum`,
        );
        return undefined;
      }
      delayMs = delayProp.value;
    }
  }

  const actions = parseActions(actionsProp.value, pathLabel, bindingLabel, options);
  if (actions === undefined) return undefined;

  return { delayMs, actions };
}

function emptyConfig() {
  return { events: emptyEvents(), hooks: emptyHooks() };
}

function ownKeys(object) {
  try {
    return Object.keys(object);
  } catch {
    return [];
  }
}

async function readNestedConfig(path, warn) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { config: emptyConfig(), sawLegacyTopLevel: false };
    }
    warn(`Cannot read ${path}: ${String(error)}`);
    return { config: emptyConfig(), sawLegacyTopLevel: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    warn(`Invalid JSON in ${path}: ${String(error)}`);
    return { config: emptyConfig(), sawLegacyTopLevel: false };
  }

  if (!isPlainObject(parsed)) {
    warn(`Ignoring ${path}: the top level must be an object`);
    return { config: emptyConfig(), sawLegacyTopLevel: false };
  }

  const root = parsed;
  const config = emptyConfig();
  let sawLegacyTopLevel = false;

  for (const key of ownKeys(root)) {
    if (key === "events" || key === "hooks") continue;
    const prop = readOwnDataProperty(root, key);
    if (!prop.ok) {
      warn(`Ignoring unsupported top-level key ${JSON.stringify(clipDiagnostic(key))} in ${path}: ${prop.reason}`);
      continue;
    }
    if (legacyTopLevelKeys.has(key)) {
      sawLegacyTopLevel = true;
      continue;
    }
    if (isPlainObject(prop.value)) {
      warn(`Ignoring unsupported top-level key ${JSON.stringify(clipDiagnostic(key))} in ${path}`);
    } else if (Array.isArray(prop.value)) {
      sawLegacyTopLevel = true;
    } else {
      warn(`Ignoring unsupported top-level key ${JSON.stringify(clipDiagnostic(key))} in ${path}`);
    }
  }

  if (sawLegacyTopLevel) {
    warn(`Ignoring legacy top-level dsh-notify configuration in ${path}; migrate to nested events/hooks bindings`);
  }

  if (Object.hasOwn(root, "events")) {
    const eventsProp = readOwnDataProperty(root, "events");
    if (!eventsProp.ok) {
      warn(`Ignoring events in ${path}: ${eventsProp.reason}`);
    } else if (!isPlainObject(eventsProp.value)) {
      warn(`Ignoring events in ${path}: value must be an object`);
    } else {
      for (const name of ownKeys(eventsProp.value)) {
        if (!lifecycleKeys.has(name)) {
          warn(`Ignoring unsupported event binding ${JSON.stringify(clipDiagnostic(name))} in ${path}`);
          continue;
        }
        const bindingProp = readOwnDataProperty(eventsProp.value, name);
        if (!bindingProp.ok) {
          warn(`Ignoring events.${name} in ${path}: ${bindingProp.reason}`);
          continue;
        }
        const binding = parseBinding(bindingProp.value, path, `events.${name}`, {
          rejectBareOsc: false,
          warn,
        });
        if (binding) config.events[name] = binding;
      }
    }
  }

  if (Object.hasOwn(root, "hooks")) {
    const hooksProp = readOwnDataProperty(root, "hooks");
    if (!hooksProp.ok) {
      warn(`Ignoring hooks in ${path}: ${hooksProp.reason}`);
    } else if (!isPlainObject(hooksProp.value)) {
      warn(`Ignoring hooks in ${path}: value must be an object`);
    } else {
      for (const name of ownKeys(hooksProp.value)) {
        if (!isKebabCaseName(name)) {
          warn(
            `Ignoring invalid hook name ${JSON.stringify(clipDiagnostic(name))} in ${path}: expected lowercase kebab-case`,
          );
          continue;
        }
        const bindingProp = readOwnDataProperty(hooksProp.value, name);
        if (!bindingProp.ok) {
          warn(`Ignoring hooks.${clipDiagnostic(name)} in ${path}: ${bindingProp.reason}`);
          continue;
        }
        const binding = parseBinding(bindingProp.value, path, `hooks.${name}`, {
          rejectBareOsc: true,
          warn,
        });
        if (binding) config.hooks[name] = binding;
      }
    }
  }

  return { config, sawLegacyTopLevel };
}

function mergeConfigs(base, overlay) {
  const events = emptyEvents();
  const hooks = emptyHooks();
  for (const key of Object.keys(base.events)) {
    const binding = base.events[key];
    if (binding) events[key] = binding;
  }
  for (const key of Object.keys(overlay.events)) {
    const binding = overlay.events[key];
    if (binding) events[key] = binding;
  }
  for (const key of Object.keys(base.hooks)) {
    if (Object.hasOwn(base.hooks, key)) hooks[key] = base.hooks[key];
  }
  for (const key of Object.keys(overlay.hooks)) {
    if (Object.hasOwn(overlay.hooks, key)) hooks[key] = overlay.hooks[key];
  }
  return { events, hooks };
}

/**
 * Load nested events/hooks configuration (same JSON schema as pi-notify).
 * Project bindings replace matching global bindings as whole units when allowed.
 * An invalid higher-precedence binding is ignored and does not erase a valid lower-precedence binding.
 * An explicit empty `actions` array is a valid whole-unit disable.
 *
 * options.globalPath: absolute path of the global config file.
 * options.cwd: working directory for the project config (`<cwd>/.dsh/dsh-notify.json`).
 * options.allowProjectConfig: whether the project file is read at all.
 */
export async function loadConfig(options) {
  const globalParsed = await readNestedConfig(options.globalPath, options.warn);
  if (!options.allowProjectConfig) return globalParsed.config;

  // Capture only valid project bindings; invalid ones warn during parse and are omitted,
  // so merge keeps the corresponding global binding.
  const projectParsed = await readNestedConfig(
    join(options.cwd, ".dsh", "dsh-notify.json"),
    options.warn,
  );
  return mergeConfigs(globalParsed.config, projectParsed.config);
}

/** Safe own-property hook lookup; avoids prototype pollution on ordinary maps. */
export function getHookBinding(hooks, name) {
  return Object.hasOwn(hooks, name) ? hooks[name] : undefined;
}
