import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "./subsystem.js";

const diag = createSubsystemLogger("diagnostic");

type SessionStateValue = "idle" | "processing" | "waiting";
type RecoveryStage = "soft" | "hard";
export type ActiveRunProgressKind =
  | "run_started"
  | "assistant_delta"
  | "tool_start"
  | "tool_update"
  | "tool_result"
  | "tool_delivery"
  | "block_delivery";

type SessionState = {
  sessionId?: string;
  sessionKey?: string;
  lastActivity: number;
  state: SessionStateValue;
  queueDepth: number;
  recoveryStage?: RecoveryStage;
  recoveryInFlight: boolean;
};

type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
};

type ActiveRunRef = SessionRef & {
  conversationKey?: string;
};

type ActiveRunState = {
  conversationKey: string;
  sessionId: string;
  sessionKey?: string;
  startedAt: number;
  lastProgressAt: number;
  lastProgressKind: ActiveRunProgressKind;
  progressCount: number;
  recoveryStage?: RecoveryStage;
  recoveryInFlight: boolean;
};

const sessionStates = new Map<string, SessionState>();
const sessionAliases = new Map<string, string>();
const activeRunStates = new Map<string, ActiveRunState>();
const activeRunAliases = new Map<string, string>();
const activeRunAliasKeys = new Map<string, Set<string>>();
const SESSION_STATE_PRIORITY: Record<SessionStateValue, number> = {
  idle: 0,
  waiting: 1,
  processing: 2,
};

const HEARTBEAT_IDLE_SUPPRESS_MS = 120_000;
const SOFT_RECOVERY_MS = 2 * 60_000;
const HARD_RECOVERY_MS = 4 * 60_000;
const SOFT_RECOVERY_WAIT_MS = 15_000;
const HARD_RECOVERY_WAIT_MS = 2_000;
const HARD_RECOVERY_RESTART_WINDOW_MS = 15 * 60_000;
const HARD_RECOVERY_RESTART_THRESHOLD = 3;

const webhookStats = {
  received: 0,
  processed: 0,
  errors: 0,
  lastReceived: 0,
};

let lastActivityAt = 0;
let hardRecoveryTimestamps: number[] = [];
let didLoadPersistedActiveRuns = false;
let didScheduleStartupSweep = false;
let activeRunPersistTimer: NodeJS.Timeout | null = null;

function resolveActiveRunStatePath() {
  return path.join(resolveStateDir(process.env, os.homedir), "logs", "diagnostic-active-runs.json");
}

function markActivity() {
  lastActivityAt = Date.now();
}

function normalizeSessionRefValue(value?: string) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function normalizeUnknownSessionRefValue(value: unknown) {
  return typeof value === "string" ? normalizeSessionRefValue(value) : undefined;
}

function getRefIdentifiers(ref: SessionRef): string[] {
  return [normalizeSessionRefValue(ref.sessionKey), normalizeSessionRefValue(ref.sessionId)].filter(
    (value): value is string => Boolean(value),
  );
}

function getActiveRunIdentifiers(ref: ActiveRunRef): string[] {
  return [
    normalizeSessionRefValue(ref.conversationKey),
    normalizeSessionRefValue(ref.sessionKey),
    normalizeSessionRefValue(ref.sessionId),
  ].filter((value): value is string => Boolean(value));
}

function chooseRecoveryStage(a?: RecoveryStage, b?: RecoveryStage): RecoveryStage | undefined {
  if (a === "hard" || b === "hard") {
    return "hard";
  }
  if (a === "soft" || b === "soft") {
    return "soft";
  }
  return undefined;
}

function mergeSessionState(target: SessionState, source: SessionState) {
  if (source === target) {
    return;
  }
  if (source.sessionId && !target.sessionId) {
    target.sessionId = source.sessionId;
  }
  if (source.sessionKey && !target.sessionKey) {
    target.sessionKey = source.sessionKey;
  }
  if (source.lastActivity > target.lastActivity) {
    target.lastActivity = source.lastActivity;
  }
  if (source.queueDepth > target.queueDepth) {
    target.queueDepth = source.queueDepth;
  }
  if (SESSION_STATE_PRIORITY[source.state] > SESSION_STATE_PRIORITY[target.state]) {
    target.state = source.state;
  }
  target.recoveryStage = chooseRecoveryStage(target.recoveryStage, source.recoveryStage);
  target.recoveryInFlight = target.recoveryInFlight || source.recoveryInFlight;
}

function registerSessionAliases(canonicalKey: string, state: SessionState, ref?: SessionRef) {
  const identifiers = new Set<string>([
    ...getRefIdentifiers(ref ?? {}),
    ...getRefIdentifiers({ sessionId: state.sessionId, sessionKey: state.sessionKey }),
  ]);
  for (const identifier of identifiers) {
    sessionAliases.set(identifier, canonicalKey);
  }
}

function getCandidateCanonicalKeys(ref: SessionRef): string[] {
  const candidates = new Set<string>();
  for (const identifier of getRefIdentifiers(ref)) {
    const aliased = sessionAliases.get(identifier);
    if (aliased) {
      candidates.add(aliased);
    }
    if (sessionStates.has(identifier)) {
      candidates.add(identifier);
    }
  }
  return [...candidates];
}

function getTrackedSessionStates(): SessionState[] {
  return Array.from(sessionStates.values());
}

function getCanonicalSessionKey(ref: SessionRef): string {
  const preferredKey = normalizeSessionRefValue(ref.sessionKey);
  if (preferredKey) {
    return preferredKey;
  }
  const preferredId = normalizeSessionRefValue(ref.sessionId);
  if (preferredId) {
    return preferredId;
  }
  return "unknown";
}

function resetSessionRecoveryState(state: SessionState) {
  state.recoveryStage = undefined;
  state.recoveryInFlight = false;
}

function resetActiveRunRecoveryState(state: ActiveRunState) {
  state.recoveryStage = undefined;
  state.recoveryInFlight = false;
}

function getSessionState(ref: SessionRef): SessionState {
  const canonicalKey = getCanonicalSessionKey(ref);
  const candidateKeys = getCandidateCanonicalKeys(ref);
  let state = sessionStates.get(canonicalKey);

  for (const candidateKey of candidateKeys) {
    const candidateState = sessionStates.get(candidateKey);
    if (!candidateState) {
      continue;
    }
    if (!state) {
      state = candidateState;
      continue;
    }
    mergeSessionState(state, candidateState);
    if (candidateState !== state) {
      sessionStates.delete(candidateKey);
    }
  }

  if (!state) {
    state = {
      sessionId: normalizeSessionRefValue(ref.sessionId),
      sessionKey: normalizeSessionRefValue(ref.sessionKey),
      lastActivity: Date.now(),
      state: "idle",
      queueDepth: 0,
      recoveryInFlight: false,
    };
  } else {
    if (ref.sessionId) {
      state.sessionId = normalizeSessionRefValue(ref.sessionId);
    }
    if (ref.sessionKey) {
      state.sessionKey = normalizeSessionRefValue(ref.sessionKey);
    }
  }

  sessionStates.set(canonicalKey, state);
  registerSessionAliases(canonicalKey, state, ref);
  return state;
}

function touchSessionActivity(ref: SessionRef) {
  if (!ref.sessionId && !ref.sessionKey) {
    return;
  }
  const state = getSessionState(ref);
  state.lastActivity = Date.now();
}

function trackActiveRunAlias(alias: string, conversationKey: string) {
  activeRunAliases.set(alias, conversationKey);
  const aliases = activeRunAliasKeys.get(conversationKey) ?? new Set<string>();
  aliases.add(alias);
  activeRunAliasKeys.set(conversationKey, aliases);
}

function clearActiveRunAliases(conversationKey: string) {
  const aliases = activeRunAliasKeys.get(conversationKey);
  if (!aliases) {
    return;
  }
  for (const alias of aliases) {
    if (activeRunAliases.get(alias) === conversationKey) {
      activeRunAliases.delete(alias);
    }
  }
  activeRunAliasKeys.delete(conversationKey);
}

function getTrackedActiveRun(
  ref: ActiveRunRef,
): { conversationKey: string; state: ActiveRunState } | undefined {
  const identifiers = getActiveRunIdentifiers(ref);
  for (const identifier of identifiers) {
    const direct = activeRunStates.get(identifier);
    if (direct) {
      return { conversationKey: identifier, state: direct };
    }
  }
  for (const identifier of identifiers) {
    const aliasedKey = activeRunAliases.get(identifier);
    if (!aliasedKey) {
      continue;
    }
    const aliased = activeRunStates.get(aliasedKey);
    if (aliased) {
      return { conversationKey: aliasedKey, state: aliased };
    }
  }
  return undefined;
}

function serializeActiveRuns() {
  return [...activeRunStates.values()].map((state) => ({
    conversationKey: state.conversationKey,
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    startedAt: state.startedAt,
    lastProgressAt: state.lastProgressAt,
    lastProgressKind: state.lastProgressKind,
    progressCount: state.progressCount,
  }));
}

function persistActiveRunsSync() {
  const activeRunStatePath = resolveActiveRunStatePath();
  const tempActiveRunStatePath = `${activeRunStatePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsSync.mkdirSync(path.dirname(activeRunStatePath), { recursive: true });
    fsSync.writeFileSync(
      tempActiveRunStatePath,
      JSON.stringify(serializeActiveRuns(), null, 2),
      "utf-8",
    );
    fsSync.renameSync(tempActiveRunStatePath, activeRunStatePath);
  } catch (err) {
    try {
      fsSync.rmSync(tempActiveRunStatePath, { force: true });
    } catch {}
    diag.warn(`active run state persist failed: error="${String(err)}"`);
  }
}

function schedulePersistActiveRuns() {
  if (activeRunPersistTimer) {
    return;
  }
  activeRunPersistTimer = setTimeout(() => {
    activeRunPersistTimer = null;
    persistActiveRunsSync();
  }, 250);
  activeRunPersistTimer.unref?.();
}

function loadPersistedActiveRuns() {
  if (didLoadPersistedActiveRuns) {
    return;
  }
  let raw = "";
  const activeRunStatePath = resolveActiveRunStatePath();
  try {
    raw = fsSync.readFileSync(activeRunStatePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      diag.warn(`active run state load failed: error="${String(err)}"`);
      return;
    }
    didLoadPersistedActiveRuns = true;
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      didLoadPersistedActiveRuns = true;
      return;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const conversationKey = normalizeUnknownSessionRefValue(
        (entry as { conversationKey?: unknown }).conversationKey,
      );
      const sessionId = normalizeUnknownSessionRefValue(
        (entry as { sessionId?: unknown }).sessionId,
      );
      const sessionKey = normalizeUnknownSessionRefValue(
        (entry as { sessionKey?: unknown }).sessionKey,
      );
      const startedAt = Number((entry as { startedAt?: unknown }).startedAt);
      const lastProgressAt = Number((entry as { lastProgressAt?: unknown }).lastProgressAt);
      const lastProgressKind = (entry as { lastProgressKind?: unknown }).lastProgressKind;
      const progressCount = Number((entry as { progressCount?: unknown }).progressCount);
      if (!conversationKey || !sessionId) {
        continue;
      }
      if (!Number.isFinite(startedAt) || !Number.isFinite(lastProgressAt)) {
        continue;
      }
      if (typeof lastProgressKind !== "string" || !lastProgressKind.trim()) {
        continue;
      }
      const state: ActiveRunState = {
        conversationKey,
        sessionId,
        sessionKey,
        startedAt,
        lastProgressAt,
        lastProgressKind: lastProgressKind as ActiveRunProgressKind,
        progressCount: Number.isFinite(progressCount) && progressCount > 0 ? progressCount : 1,
        recoveryInFlight: false,
      };
      activeRunStates.set(conversationKey, state);
      trackActiveRunAlias(conversationKey, conversationKey);
      trackActiveRunAlias(sessionId, conversationKey);
      if (sessionKey) {
        trackActiveRunAlias(sessionKey, conversationKey);
      }
    }
    didLoadPersistedActiveRuns = true;
  } catch (err) {
    diag.warn(`active run state parse failed: error="${String(err)}"`);
  }
}

function recordHardRecovery(now = Date.now()) {
  hardRecoveryTimestamps = hardRecoveryTimestamps.filter(
    (ts) => now - ts <= HARD_RECOVERY_RESTART_WINDOW_MS,
  );
  hardRecoveryTimestamps.push(now);
  return hardRecoveryTimestamps.length;
}

export function registerActiveRun(params: { sessionId: string; sessionKey?: string }) {
  const sessionId = normalizeSessionRefValue(params.sessionId);
  if (!sessionId) {
    return;
  }
  loadPersistedActiveRuns();
  const sessionKey = normalizeSessionRefValue(params.sessionKey);
  const conversationKey = sessionKey ?? sessionId;
  const existing = getTrackedActiveRun({ conversationKey, sessionId, sessionKey });
  if (existing) {
    activeRunStates.delete(existing.conversationKey);
    clearActiveRunAliases(existing.conversationKey);
  }
  const now = Date.now();
  activeRunStates.set(conversationKey, {
    conversationKey,
    sessionId,
    sessionKey,
    startedAt: now,
    lastProgressAt: now,
    lastProgressKind: "run_started",
    progressCount: 1,
    recoveryInFlight: false,
  });
  trackActiveRunAlias(conversationKey, conversationKey);
  trackActiveRunAlias(sessionId, conversationKey);
  if (sessionKey) {
    trackActiveRunAlias(sessionKey, conversationKey);
  }
  persistActiveRunsSync();
}

export function recordActiveRunProgress(
  params: ActiveRunRef & { kind: ActiveRunProgressKind },
): boolean {
  loadPersistedActiveRuns();
  const tracked = getTrackedActiveRun(params);
  if (!tracked) {
    return false;
  }
  const now = Date.now();
  tracked.state.lastProgressAt = now;
  tracked.state.lastProgressKind = params.kind;
  tracked.state.progressCount += 1;
  const sessionId = normalizeSessionRefValue(params.sessionId);
  const sessionKey = normalizeSessionRefValue(params.sessionKey);
  if (sessionId && tracked.state.sessionId !== sessionId) {
    tracked.state.sessionId = sessionId;
    trackActiveRunAlias(sessionId, tracked.conversationKey);
  }
  if (sessionKey && tracked.state.sessionKey !== sessionKey) {
    tracked.state.sessionKey = sessionKey;
    trackActiveRunAlias(sessionKey, tracked.conversationKey);
  }
  resetActiveRunRecoveryState(tracked.state);
  schedulePersistActiveRuns();
  return true;
}

export function clearActiveRun(params: ActiveRunRef): boolean {
  loadPersistedActiveRuns();
  const tracked = getTrackedActiveRun(params);
  if (!tracked) {
    return false;
  }
  activeRunStates.delete(tracked.conversationKey);
  clearActiveRunAliases(tracked.conversationKey);
  persistActiveRunsSync();
  return true;
}

function isTrackedActiveRunSnapshot(state: ActiveRunState): boolean {
  return activeRunStates.get(state.conversationKey) === state;
}

async function recoverStuckActiveRun(
  state: ActiveRunState,
  stage: RecoveryStage,
  ageMs: number,
): Promise<void> {
  if (state.recoveryInFlight) {
    return;
  }
  if (stage === "soft" && state.recoveryStage) {
    return;
  }
  if (stage === "hard" && state.recoveryStage === "hard") {
    return;
  }

  const sessionId = normalizeSessionRefValue(state.sessionId);
  const sessionKey = normalizeSessionRefValue(state.sessionKey);
  const conversationKey = state.conversationKey;
  const recoveryRef = { sessionId, sessionKey };
  state.recoveryInFlight = true;
  state.recoveryStage = stage;
  schedulePersistActiveRuns();

  try {
    logSessionStuck({
      sessionId,
      sessionKey,
      state: "processing",
      ageMs,
    });
    const [piEmbedded, commandQueue, replyQueue, restart] = await Promise.all([
      import("../agents/pi-embedded.js"),
      import("../process/command-queue.js"),
      import("../auto-reply/reply/queue.js"),
      import("../infra/restart.js"),
    ]);
    if (!isTrackedActiveRunSnapshot(state)) {
      return;
    }

    if (stage === "soft") {
      const aborted = sessionId ? piEmbedded.abortEmbeddedPiRun(sessionId) : false;
      diag.warn(
        `stuck run recovery: stage=soft sessionId=${sessionId ?? "unknown"} sessionKey=${
          sessionKey ?? "unknown"
        } conversationKey=${conversationKey} age=${Math.round(ageMs / 1000)}s kind=${
          state.lastProgressKind
        } aborted=${aborted}`,
      );
      if (aborted && sessionId) {
        const ended = await piEmbedded.waitForEmbeddedPiRunEnd(sessionId, SOFT_RECOVERY_WAIT_MS);
        if (ended && isTrackedActiveRunSnapshot(state)) {
          clearActiveRun({ conversationKey });
        }
      }
      return;
    }

    const aborted = sessionId ? piEmbedded.abortEmbeddedPiRun(sessionId) : false;
    const ended = sessionId
      ? await piEmbedded.waitForEmbeddedPiRunEnd(sessionId, HARD_RECOVERY_WAIT_MS)
      : false;
    if (!isTrackedActiveRunSnapshot(state)) {
      return;
    }
    const laneSource = sessionKey ?? sessionId;
    const laneRecovery = laneSource
      ? commandQueue.recoverCommandLane(piEmbedded.resolveEmbeddedSessionLane(laneSource))
      : { activeRecovered: 0, queued: 0 };
    const resumedFollowup =
      (sessionKey ? replyQueue.scheduleRegisteredFollowupDrain(sessionKey) : false) ||
      (sessionId && sessionId !== sessionKey
        ? replyQueue.scheduleRegisteredFollowupDrain(sessionId)
        : false);

    diag.warn(
      `stuck run recovery: stage=hard sessionId=${sessionId ?? "unknown"} sessionKey=${
        sessionKey ?? "unknown"
      } conversationKey=${conversationKey} age=${Math.round(ageMs / 1000)}s kind=${
        state.lastProgressKind
      } aborted=${aborted} ended=${ended} activeRecovered=${laneRecovery.activeRecovered} resumedFollowup=${resumedFollowup}`,
    );

    logSessionStateChange({
      ...recoveryRef,
      state: "idle",
      reason: "watchdog_recovered",
    });
    clearActiveRun({ conversationKey });

    const hardRecoveryCount = recordHardRecovery();
    const shouldRestart =
      (!ended && laneRecovery.activeRecovered === 0 && !resumedFollowup) ||
      hardRecoveryCount >= HARD_RECOVERY_RESTART_THRESHOLD;
    if (shouldRestart) {
      const scheduled = restart.scheduleGatewaySigusr1Restart({
        delayMs: 2_000,
        reason: `stuck_run:${sessionKey ?? sessionId ?? conversationKey}`,
      });
      diag.warn(
        `stuck run recovery restart scheduled: sessionId=${sessionId ?? "unknown"} sessionKey=${
          sessionKey ?? "unknown"
        } conversationKey=${conversationKey} reason=${scheduled.reason ?? "unknown"} delayMs=${scheduled.delayMs}`,
      );
    }
  } catch (err) {
    diag.error(
      `stuck run recovery failed: stage=${stage} sessionId=${sessionId ?? "unknown"} sessionKey=${
        sessionKey ?? "unknown"
      } conversationKey=${conversationKey} error="${String(err)}"`,
    );
  } finally {
    const tracked = activeRunStates.get(conversationKey);
    if (tracked === state) {
      tracked.recoveryInFlight = false;
      schedulePersistActiveRuns();
    }
  }
}

export function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}) {
  webhookStats.received += 1;
  webhookStats.lastReceived = Date.now();
  diag.debug(
    `webhook received: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
      params.chatId ?? "unknown"
    } total=${webhookStats.received}`,
  );
  emitDiagnosticEvent({
    type: "webhook.received",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
  });
  markActivity();
}

export function logWebhookProcessed(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
}) {
  webhookStats.processed += 1;
  diag.debug(
    `webhook processed: channel=${params.channel} type=${
      params.updateType ?? "unknown"
    } chatId=${params.chatId ?? "unknown"} duration=${params.durationMs ?? 0}ms processed=${
      webhookStats.processed
    }`,
  );
  emitDiagnosticEvent({
    type: "webhook.processed",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    durationMs: params.durationMs,
  });
  markActivity();
}

export function logWebhookError(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
}) {
  webhookStats.errors += 1;
  diag.error(
    `webhook error: channel=${params.channel} type=${params.updateType ?? "unknown"} chatId=${
      params.chatId ?? "unknown"
    } error="${params.error}" errors=${webhookStats.errors}`,
  );
  emitDiagnosticEvent({
    type: "webhook.error",
    channel: params.channel,
    updateType: params.updateType,
    chatId: params.chatId,
    error: params.error,
  });
  markActivity();
}

export function logMessageQueued(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}) {
  const state = getSessionState(params);
  state.queueDepth += 1;
  state.lastActivity = Date.now();
  diag.debug(
    `message queued: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } source=${params.source} queueDepth=${state.queueDepth} sessionState=${state.state}`,
  );
  emitDiagnosticEvent({
    type: "message.queued",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    channel: params.channel,
    source: params.source,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logMessageProcessed(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}) {
  touchSessionActivity({ sessionId: params.sessionId, sessionKey: params.sessionKey });
  const payload = `message processed: channel=${params.channel} chatId=${
    params.chatId ?? "unknown"
  } messageId=${params.messageId ?? "unknown"} sessionId=${
    params.sessionId ?? "unknown"
  } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} duration=${
    params.durationMs ?? 0
  }ms${params.reason ? ` reason=${params.reason}` : ""}${
    params.error ? ` error="${params.error}"` : ""
  }`;
  if (params.outcome === "error") {
    diag.error(payload);
  } else {
    diag.debug(payload);
  }
  emitDiagnosticEvent({
    type: "message.processed",
    channel: params.channel,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    durationMs: params.durationMs,
    outcome: params.outcome,
    reason: params.reason,
    error: params.error,
  });
  markActivity();
}

export function logSessionStateChange(
  params: SessionRef & {
    state: SessionStateValue;
    reason?: string;
  },
) {
  const state = getSessionState(params);
  const isProbeSession = state.sessionId?.startsWith("probe-") ?? false;
  const prevState = state.state;
  if (params.state !== "processing" || prevState !== "processing") {
    resetSessionRecoveryState(state);
  }
  state.state = params.state;
  state.lastActivity = Date.now();
  if (params.state === "idle") {
    state.queueDepth = Math.max(0, state.queueDepth - 1);
  }
  if (!isProbeSession) {
    diag.debug(
      `session state: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
        state.sessionKey ?? "unknown"
      } prev=${prevState} new=${params.state} reason="${params.reason ?? ""}" queueDepth=${
        state.queueDepth
      }`,
    );
  }
  emitDiagnosticEvent({
    type: "session.state",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    prevState,
    state: params.state,
    reason: params.reason,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logSessionStuck(params: SessionRef & { state: SessionStateValue; ageMs: number }) {
  const state = getSessionState(params);
  diag.warn(
    `stuck session: sessionId=${state.sessionId ?? "unknown"} sessionKey=${
      state.sessionKey ?? "unknown"
    } state=${params.state} age=${Math.round(params.ageMs / 1000)}s queueDepth=${state.queueDepth}`,
  );
  emitDiagnosticEvent({
    type: "session.stuck",
    sessionId: state.sessionId,
    sessionKey: state.sessionKey,
    state: params.state,
    ageMs: params.ageMs,
    queueDepth: state.queueDepth,
  });
  markActivity();
}

export function logLaneEnqueue(lane: string, queueSize: number) {
  diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.enqueue",
    lane,
    queueSize,
  });
  markActivity();
}

export function logLaneDequeue(lane: string, waitMs: number, queueSize: number) {
  diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
  emitDiagnosticEvent({
    type: "queue.lane.dequeue",
    lane,
    queueSize,
    waitMs,
  });
  markActivity();
}

export function logRunAttempt(params: SessionRef & { runId: string; attempt: number }) {
  touchSessionActivity(params);
  diag.debug(
    `run attempt: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
      params.sessionKey ?? "unknown"
    } runId=${params.runId} attempt=${params.attempt}`,
  );
  emitDiagnosticEvent({
    type: "run.attempt",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    attempt: params.attempt,
  });
  markActivity();
}

export function logActiveRuns() {
  loadPersistedActiveRuns();
  const activeSessions = [...activeRunStates.values()].map((state) => {
    const key = state.sessionKey ?? state.sessionId ?? state.conversationKey;
    return `${key}(progress=${state.lastProgressKind},age=${Math.round(
      (Date.now() - state.lastProgressAt) / 1000,
    )}s,count=${state.progressCount})`;
  });
  diag.debug(`active runs: count=${activeSessions.length} sessions=[${activeSessions.join(", ")}]`);
  markActivity();
}

let heartbeatInterval: NodeJS.Timeout | null = null;

async function recoverPersistedActiveRunsOnStartup(): Promise<void> {
  loadPersistedActiveRuns();
  if (activeRunStates.size === 0) {
    return;
  }
  const now = Date.now();
  const recoveryTasks: Promise<void>[] = [];
  for (const state of activeRunStates.values()) {
    const ageMs = now - state.lastProgressAt;
    if (ageMs < SOFT_RECOVERY_MS) {
      continue;
    }
    recoveryTasks.push(recoverStuckActiveRun(state, "hard", ageMs));
  }
  if (recoveryTasks.length > 0) {
    await Promise.allSettled(recoveryTasks);
  }
}

async function runDiagnosticHeartbeatTick(): Promise<void> {
  loadPersistedActiveRuns();
  const now = Date.now();
  const trackedStates = getTrackedSessionStates();
  const recoveryTasks: Promise<void>[] = [];
  const sessionActiveCount = trackedStates.filter((state) => state.state === "processing").length;
  const activeCount = Math.max(sessionActiveCount, activeRunStates.size);
  const waitingCount = trackedStates.filter((state) => state.state === "waiting").length;
  const totalQueued = trackedStates.reduce((sum, state) => sum + state.queueDepth, 0);
  const hasActivity =
    lastActivityAt > 0 ||
    webhookStats.received > 0 ||
    activeCount > 0 ||
    waitingCount > 0 ||
    totalQueued > 0;
  if (!hasActivity) {
    return;
  }
  if (
    now - lastActivityAt > HEARTBEAT_IDLE_SUPPRESS_MS &&
    activeCount === 0 &&
    waitingCount === 0
  ) {
    return;
  }

  diag.debug(
    `heartbeat: webhooks=${webhookStats.received}/${webhookStats.processed}/${webhookStats.errors} active=${activeCount} waiting=${waitingCount} queued=${totalQueued}`,
  );
  emitDiagnosticEvent({
    type: "diagnostic.heartbeat",
    webhooks: {
      received: webhookStats.received,
      processed: webhookStats.processed,
      errors: webhookStats.errors,
    },
    active: activeCount,
    waiting: waitingCount,
    queued: totalQueued,
  });

  for (const state of activeRunStates.values()) {
    const ageMs = now - state.lastProgressAt;
    if (ageMs >= HARD_RECOVERY_MS) {
      recoveryTasks.push(recoverStuckActiveRun(state, "hard", ageMs));
    } else if (ageMs >= SOFT_RECOVERY_MS) {
      recoveryTasks.push(recoverStuckActiveRun(state, "soft", ageMs));
    }
  }
  if (recoveryTasks.length > 0) {
    await Promise.allSettled(recoveryTasks);
  }
}

export function startDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    return;
  }
  if (!didScheduleStartupSweep) {
    didScheduleStartupSweep = true;
    void recoverPersistedActiveRunsOnStartup();
  }
  heartbeatInterval = setInterval(() => {
    void runDiagnosticHeartbeatTick();
  }, 30_000);
  heartbeatInterval.unref?.();
}

export function stopDiagnosticHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export const __testing = {
  async runHeartbeatTick() {
    await runDiagnosticHeartbeatTick();
  },
  async runStartupSweep() {
    await recoverPersistedActiveRunsOnStartup();
  },
  resetSessionTracking() {
    sessionStates.clear();
    sessionAliases.clear();
    activeRunStates.clear();
    activeRunAliases.clear();
    activeRunAliasKeys.clear();
    hardRecoveryTimestamps = [];
    lastActivityAt = 0;
    didLoadPersistedActiveRuns = false;
    didScheduleStartupSweep = false;
    if (activeRunPersistTimer) {
      clearTimeout(activeRunPersistTimer);
      activeRunPersistTimer = null;
    }
    stopDiagnosticHeartbeat();
  },
};

export { diag as diagnosticLogger };
