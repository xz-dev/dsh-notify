import { hostname } from "node:os";

import { SYSTEM_TEMPLATE_KEYS } from "./config.js";

const systemKeySet = new Set(SYSTEM_TEMPLATE_KEYS);

function currentHostname() {
  return (process.env.HOSTNAME ?? hostname()).trim() || "unknown-host";
}

export function createTemplateValues(context) {
  const values = {
    EVENT: context.event,
    CWD: context.cwd,
    HOSTNAME: context.hostname ?? currentHostname(),
    SESSION_ID: context.sessionId,
  };

  if (context.hook !== undefined) values.HOOK = context.hook;
  if (context.sessionFile !== undefined) values.SESSION_FILE = context.sessionFile;
  if (context.tool !== undefined) values.TOOL = context.tool;
  if (context.toolCallId !== undefined) values.TOOL_CALL_ID = context.toolCallId;

  for (const [key, value] of Object.entries(context.values ?? {})) {
    if (systemKeySet.has(key)) continue;
    values[key] = value;
  }

  return values;
}

export function createNotificationEnvironment(context) {
  const values = createTemplateValues(context);
  const environment = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) environment[`PI_NOTIFY_${key}`] = value;
  }
  return environment;
}

export function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key) => values[key] ?? placeholder);
}
