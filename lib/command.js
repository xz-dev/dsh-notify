import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class CommandLaunchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CommandLaunchError";
  }
}

function clearNotificationEnvironment(environment) {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("PI_NOTIFY_")) delete environment[key];
  }
}

function buildEnvironment(inheritedEnvironment, notificationEnvironment) {
  const env = { ...inheritedEnvironment };
  clearNotificationEnvironment(env);
  for (const [key, value] of Object.entries(notificationEnvironment)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024;

function captureOutput(stream) {
  const chunks = [];
  let capturedBytes = 0;
  let truncated = false;
  stream?.on("data", (chunk) => {
    if (capturedBytes >= MAX_CAPTURED_OUTPUT_BYTES) {
      truncated = true;
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_CAPTURED_OUTPUT_BYTES - capturedBytes;
    const captured = bytes.subarray(0, remaining);
    chunks.push(captured);
    capturedBytes += captured.length;
    if (captured.length < bytes.length) truncated = true;
  });
  stream?.unref?.();
  return () => {
    const decoder = new StringDecoder("utf8");
    const bytes = Buffer.concat(chunks);
    const output = `${decoder.write(bytes)}${truncated ? "" : decoder.end()}`
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .trimEnd();
    return `${output}${truncated ? `${output ? "\n" : ""}…[truncated]` : ""}`;
  };
}

function observeChild(child, noun, observer) {
  const stdout = captureOutput(child.stdout);
  const stderr = captureOutput(child.stderr);
  child.once("error", (error) => observer.reportFailure(error));
  child.once("close", (code, signal) => {
    if (code === 0 && signal === null) return;
    const outcome = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    const capturedStdout = stdout();
    const capturedStderr = stderr();
    const output = [
      capturedStdout ? `stdout:\n${capturedStdout}` : "stdout: <empty>",
      capturedStderr ? `stderr:\n${capturedStderr}` : "stderr: <empty>",
    ].join("\n");
    observer.reportFailure(new Error(`Notification ${noun} exited with ${outcome}\n${output}`));
  });
}

export function createCommandLauncher(options) {
  const inheritedEnvironment = options.inheritedEnvironment ?? process.env;
  const spawn = options.spawn ?? ((command, spawnOptions) => nodeSpawn(command, spawnOptions));

  return (command, cwd, notificationEnvironment, observer) => {
    const env = buildEnvironment(inheritedEnvironment, notificationEnvironment);

    try {
      const child = spawn(command, {
        cwd,
        env,
        shell: true,
        detached: true,
        stdio: observer ? ["ignore", "pipe", "pipe"] : "ignore",
        windowsHide: true,
      });
      if (observer) observeChild(child, "command", observer);
      else child.once("error", (error) => options.warn(`Cannot launch notification command: ${error.message}`));
      child.unref();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!observer) options.warn(`Cannot launch notification command: ${message}`);
      throw new CommandLaunchError(`Cannot launch notification command: ${message}`, { cause: error });
    }
  };
}

export function createShellLauncher(options) {
  const inheritedEnvironment = options.inheritedEnvironment ?? process.env;
  const spawn =
    options.spawn ??
    ((executable, args, spawnOptions) => nodeSpawn(executable, [...args], spawnOptions));

  return (executable, args, cwd, notificationEnvironment, observer) => {
    const env = buildEnvironment(inheritedEnvironment, notificationEnvironment);

    try {
      const child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: observer ? ["ignore", "pipe", "pipe"] : "ignore",
        windowsHide: true,
      });
      if (observer) observeChild(child, "shell", observer);
      else child.once("error", (error) => options.warn(`Cannot launch notification shell: ${error.message}`));
      child.unref();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!observer) options.warn(`Cannot launch notification shell: ${message}`);
      throw new CommandLaunchError(`Cannot launch notification shell: ${message}`, { cause: error });
    }
  };
}
