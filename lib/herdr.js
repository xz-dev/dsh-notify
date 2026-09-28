/**
 * Herdr agent-state reporter — port of the herdr-managed pi extension
 * (herdr-agent-state.ts) to DSH agent events.
 *
 * Reports pane.report_agent_session / pane.report_agent over the herdr Unix
 * socket. Env-gated exactly like the original: active only when herdr
 * launched this process (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID).
 */
import net from "node:net";

const SOURCE = "herdr:pi";

export function createHerdrReporter(options = {}) {
  const env = options.env ?? process.env;
  const socketPath = env.HERDR_SOCKET_PATH;
  const socketEndpoint =
    process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const paneId = env.HERDR_PANE_ID;

  const enabled = () => env.HERDR_ENV === "1" && !!socketPath && !!paneId;

  function sendRequestAttempt(request, timeoutMs) {
    if (!enabled()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      let timeout;
      const socket = net.createConnection(socketEndpoint);
      const finish = (delivered) => {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        socket.destroy();
        resolve(delivered);
      };
      socket.on("error", () => finish(false));
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", () => finish(true));
      socket.on("end", () => finish(false));
      timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref?.();
    });
  }

  async function sendRequest(request) {
    if (await sendRequestAttempt(request, 500)) return;
    await sendRequestAttempt(request, 1500);
  }

  let reportSeq = Date.now() * 1000;
  let currentAgentSessionId;
  let currentAgentSessionPath;

  function nextReportSeq() {
    reportSeq += 1;
    return reportSeq;
  }

  function withSessionRef(params) {
    if (currentAgentSessionPath) return { ...params, agent_session_path: currentAgentSessionPath };
    if (currentAgentSessionId) return { ...params, agent_session_id: currentAgentSessionId };
    return params;
  }

  function currentSessionRef() {
    if (currentAgentSessionPath) return { agent_session_path: currentAgentSessionPath };
    if (currentAgentSessionId) return { agent_session_id: currentAgentSessionId };
    return undefined;
  }

  function reportSession(sessionStartSource) {
    const sessionRef = currentSessionRef();
    if (!sessionRef) return Promise.resolve();
    return sendRequest({
      id: `${SOURCE}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId,
        source: SOURCE,
        agent: "pi",
        seq: nextReportSeq(),
        session_start_source: sessionStartSource,
        ...sessionRef,
      },
    });
  }

  function sendState(state, message, seq = nextReportSeq()) {
    return sendRequest({
      id: `${SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent",
      params: withSessionRef({
        pane_id: paneId,
        source: SOURCE,
        agent: "pi",
        state,
        message,
        seq,
      }),
    });
  }

  let sendInFlight = false;
  let queuedState;

  function queueState(state, message) {
    queuedState = { state, message, seq: nextReportSeq() };
    if (!sendInFlight) void drainStateQueue();
  }

  async function drainStateQueue() {
    if (sendInFlight) return;
    sendInFlight = true;
    try {
      while (queuedState) {
        const next = queuedState;
        queuedState = undefined;
        await sendState(next.state, next.message, next.seq);
      }
    } finally {
      sendInFlight = false;
      if (queuedState) void drainStateQueue();
    }
  }

  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage;
  let lastState;
  let lastMessage;

  // Waits observed from DSH state (approvals, ask_user); key -> label.
  const waits = new Map();

  function desiredState() {
    if (blockedCount > 0) return { state: "blocked", message: blockedMessage };
    if (waits.size > 0) return { state: "blocked", message: [...waits.values()].at(-1) };
    if (agentActive) return { state: "working", message: undefined };
    return { state: "idle", message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  return {
    enabled,

    /** Update the reported session identity (session id and optional absolute file path). */
    updateSessionRef({ sessionId, sessionPath } = {}) {
      currentAgentSessionPath =
        typeof sessionPath === "string" && (sessionPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(sessionPath))
          ? sessionPath
          : undefined;
      currentAgentSessionId =
        typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
    },

    /** Root session started (agent/created); reports the session then current activity. */
    async sessionStarted(sessionStartSource, { running } = { running: false }) {
      await reportSession(sessionStartSource);
      agentActive = running === true;
      publishState(true);
    },

    /** Agent entered running (agent/status running or fresh activity). */
    agentRunning() {
      void reportSession();
      agentActive = true;
      publishState();
    },

    /** Agent became idle; the turn is over, so no user-facing wait can still be open. */
    agentIdle() {
      agentActive = false;
      waits.clear();
      publishState();
    },

    /** A user-facing wait (approval, ask_user) opened; idempotent per key. */
    waitStarted(key, label) {
      waits.set(key, label);
      publishState();
    },

    /** A user-facing wait closed; unknown keys are ignored. */
    waitFinished(key) {
      if (waits.delete(key)) publishState();
    },

    /** External counted overlay (`herdr:blocked` event, Pi pi-subagents contract). */
    blocked(active, label) {
      if (!active) {
        blockedCount = Math.max(0, blockedCount - 1);
        if (blockedCount === 0) blockedMessage = undefined;
        publishState();
        return;
      }
      blockedCount += 1;
      blockedMessage = label;
      publishState();
    },
  };
}
