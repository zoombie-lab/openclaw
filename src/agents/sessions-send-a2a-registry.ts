import crypto from "node:crypto";
import fs from "node:fs/promises";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type GatewayMessageChannel, INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "./lanes.js";
import {
  loadSessionsSendA2ARegistryFromDisk,
  saveSessionsSendA2ARegistryToDisk,
} from "./sessions-send-a2a-registry.store.js";

const log = createSubsystemLogger("agents/sessions-send/a2a-registry");
const WAIT_POLL_TIMEOUT_MS = 60_000;
const MAX_COMPLETION_WATCH_MS = 6 * 60 * 60_000;

type RunCompletion = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

type TaskCompletionState = {
  allComplete: boolean;
  totalSections: number;
  completeSections: number;
};

export type SessionsSendA2ARunRecord = {
  runId: string;
  targetSessionKey: string;
  displayKey: string;
  callbackSessionKey: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  sourceMessage?: string;
  taskPath?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  completion?: RunCompletion;
  callbackCompletedAt?: number;
  synthesisCompletedAt?: number;
  archiveAtMs?: number;
};

const a2aRuns = new Map<string, SessionsSendA2ARunRecord>();
const waitingRuns = new Set<string>();
const processingRuns = new Set<string>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
let restoreAttempted = false;

function persistA2ARuns() {
  try {
    saveSessionsSendA2ARegistryToDisk(a2aRuns);
  } catch {
    // ignore persistence failures
  }
}

function resolveArchiveAfterMs(cfg?: ReturnType<typeof loadConfig>) {
  const config = cfg ?? loadConfig();
  const minutes = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    void sweepA2ARuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

function isSettled(entry: SessionsSendA2ARunRecord) {
  return (
    typeof entry.callbackCompletedAt === "number" && typeof entry.synthesisCompletedAt === "number"
  );
}

async function sweepA2ARuns() {
  const now = Date.now();
  let mutated = false;
  for (const [runId, entry] of a2aRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) {
      continue;
    }
    if (!isSettled(entry)) {
      continue;
    }
    a2aRuns.delete(runId);
    mutated = true;
  }
  if (mutated) {
    persistA2ARuns();
  }
  if (a2aRuns.size === 0) {
    stopSweeper();
  }
}

function extractTaskPathFromMessage(message?: string): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  const match = message.match(/\/data\/shared\/tasks\/queue\/[^\s`"')]+\.md/i);
  return match?.[0];
}

function evaluateSpecialistTaskCompletion(content: string): TaskCompletionState | undefined {
  const startMatch = content.match(/^##\s+Specialist Findings\b.*$/im);
  if (!startMatch || startMatch.index === undefined) {
    return undefined;
  }
  const afterSpecialistsHeadingIndex = startMatch.index + startMatch[0].length;
  const afterSpecialistsHeading = content.slice(afterSpecialistsHeadingIndex);
  const nextLevelTwoHeading = afterSpecialistsHeading.match(/^##\s+/m);
  const specialistBlock =
    nextLevelTwoHeading && nextLevelTwoHeading.index !== undefined
      ? afterSpecialistsHeading.slice(0, nextLevelTwoHeading.index)
      : afterSpecialistsHeading;
  const sectionBodies = specialistBlock.split(/^###\s+/m).slice(1);
  if (sectionBodies.length === 0) {
    return undefined;
  }
  let completeSections = 0;
  for (const body of sectionBodies) {
    if (/^\*\*Status:\*\*\s*Complete\b/im.test(body)) {
      completeSections += 1;
    }
  }
  return {
    allComplete: completeSections === sectionBodies.length,
    totalSections: sectionBodies.length,
    completeSections,
  };
}

async function readTaskCompletionState(taskPath: string): Promise<TaskCompletionState | undefined> {
  const content = await fs.readFile(taskPath, "utf8");
  return evaluateSpecialistTaskCompletion(content);
}

function buildCompletionCallbackMessage(entry: SessionsSendA2ARunRecord): string {
  const completion = entry.completion ?? { status: "error", error: "missing completion status" };
  const lines = [
    "TASK_COMPLETE",
    `runId: ${entry.runId}`,
    `targetSession: ${entry.displayKey}`,
    `status: ${completion.status}`,
    entry.taskPath ? `taskFile: ${entry.taskPath}` : undefined,
  ];
  if (completion.error) {
    lines.push(`error: ${completion.error}`);
  }
  return lines.filter((line): line is string => typeof line === "string").join("\n");
}

function buildTaskReadyForSynthesisMessage(params: {
  taskPath: string;
  runId: string;
  displayKey: string;
  completionState: TaskCompletionState;
}) {
  const lines = [
    "TASK_READY_FOR_SYNTHESIS",
    `runId: ${params.runId}`,
    `taskFile: ${params.taskPath}`,
    `targetSession: ${params.displayKey}`,
    `completeSections: ${params.completionState.completeSections}/${params.completionState.totalSections}`,
    "status: ready",
  ];
  return lines.join("\n");
}

async function waitForRunCompletion(runId: string): Promise<{
  completion: RunCompletion;
  startedAt?: number;
  endedAt?: number;
}> {
  const deadline = Date.now() + MAX_COMPLETION_WATCH_MS;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const waitMs = Math.max(1, Math.min(WAIT_POLL_TIMEOUT_MS, remainingMs));
    const wait = await callGateway<{
      status?: string;
      error?: string;
      startedAt?: number;
      endedAt?: number;
    }>({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs: waitMs,
      },
      timeoutMs: waitMs + 2000,
    });
    if (typeof wait?.startedAt === "number" && !startedAt) {
      startedAt = wait.startedAt;
    }
    if (typeof wait?.endedAt === "number" && !endedAt) {
      endedAt = wait.endedAt;
    }
    if (wait?.status === "ok") {
      return { completion: { status: "ok" }, startedAt, endedAt };
    }
    if (wait?.status === "error") {
      return { completion: { status: "error", error: wait.error }, startedAt, endedAt };
    }
    if (wait?.status !== "timeout") {
      return {
        completion: {
          status: "error",
          error: `unexpected wait status: ${String(wait?.status ?? "unknown")}`,
        },
        startedAt,
        endedAt,
      };
    }
  }
  return {
    completion: {
      status: "timeout",
      error: "completion watcher timeout exceeded",
    },
    startedAt,
    endedAt,
  };
}

function resolveCallbackSessionKey(params: {
  callbackSessionKey?: string;
  requesterSessionKey?: string;
}) {
  if (typeof params.callbackSessionKey === "string" && params.callbackSessionKey.trim()) {
    return params.callbackSessionKey.trim();
  }
  if (typeof params.requesterSessionKey === "string" && params.requesterSessionKey.trim()) {
    return params.requesterSessionKey.trim();
  }
  return undefined;
}

function hasSynthesisSignal(params: { callbackSessionKey: string; taskPath: string }) {
  for (const entry of a2aRuns.values()) {
    if (
      entry.callbackSessionKey === params.callbackSessionKey &&
      entry.taskPath === params.taskPath &&
      typeof entry.synthesisCompletedAt === "number"
    ) {
      return true;
    }
  }
  return false;
}

function markSynthesisSignaled(params: { callbackSessionKey: string; taskPath: string }) {
  const completedAt = Date.now();
  let mutated = false;
  for (const entry of a2aRuns.values()) {
    if (
      entry.callbackSessionKey !== params.callbackSessionKey ||
      entry.taskPath !== params.taskPath
    ) {
      continue;
    }
    if (typeof entry.synthesisCompletedAt === "number") {
      continue;
    }
    entry.synthesisCompletedAt = completedAt;
    mutated = true;
  }
  if (mutated) {
    persistA2ARuns();
  }
}

async function sendCompletionCallback(entry: SessionsSendA2ARunRecord) {
  await callGateway({
    method: "agent",
    params: {
      message: buildCompletionCallbackMessage(entry),
      sessionKey: entry.callbackSessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: false,
      channel: INTERNAL_MESSAGE_CHANNEL,
      lane: AGENT_LANE_NESTED,
      extraSystemPrompt: [
        "Task completion callback from sessions_send.",
        entry.requesterChannel ? `Requester channel: ${entry.requesterChannel}.` : undefined,
        entry.requesterSessionKey
          ? `Original requester session: ${entry.requesterSessionKey}.`
          : undefined,
        `Callback target session: ${entry.callbackSessionKey}.`,
        `Target session: ${entry.displayKey}.`,
        "This is a deterministic orchestration signal. Update internal tracking and keep waiting for remaining specialists as needed.",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    timeoutMs: 10_000,
  });
}

async function sendTaskReadyForSynthesis(
  entry: SessionsSendA2ARunRecord,
  state: TaskCompletionState,
) {
  if (!entry.taskPath) {
    return;
  }
  await callGateway({
    method: "agent",
    params: {
      message: buildTaskReadyForSynthesisMessage({
        taskPath: entry.taskPath,
        runId: entry.runId,
        displayKey: entry.displayKey,
        completionState: state,
      }),
      sessionKey: entry.callbackSessionKey,
      idempotencyKey: crypto.randomUUID(),
      deliver: false,
      channel: INTERNAL_MESSAGE_CHANNEL,
      lane: AGENT_LANE_NESTED,
      extraSystemPrompt: [
        "Deterministic orchestration signal from sessions_send.",
        "All specialist sections in the task file are now marked Status: Complete.",
        "Re-read the task file, synthesize final summary, then send the final external report (Slack or configured channel) if not yet sent.",
      ].join("\n"),
    },
    timeoutMs: 10_000,
  });
}

async function processA2ARun(runId: string) {
  if (!runId || processingRuns.has(runId)) {
    return;
  }
  processingRuns.add(runId);
  try {
    const entry = a2aRuns.get(runId);
    if (!entry?.completion) {
      return;
    }

    let mutated = false;
    if (typeof entry.callbackCompletedAt !== "number") {
      try {
        await sendCompletionCallback(entry);
        entry.callbackCompletedAt = Date.now();
        mutated = true;
      } catch (err) {
        log.warn("sessions_send callback dispatch failed", {
          runId,
          error: formatErrorMessage(err),
        });
        if (mutated) {
          persistA2ARuns();
        }
        return;
      }
    }

    if (entry.completion.status !== "ok" || !entry.taskPath) {
      if (typeof entry.synthesisCompletedAt !== "number") {
        entry.synthesisCompletedAt = Date.now();
        mutated = true;
      }
      if (mutated) {
        persistA2ARuns();
      }
      return;
    }

    if (
      hasSynthesisSignal({ callbackSessionKey: entry.callbackSessionKey, taskPath: entry.taskPath })
    ) {
      if (typeof entry.synthesisCompletedAt !== "number") {
        entry.synthesisCompletedAt = Date.now();
        mutated = true;
      }
      if (mutated) {
        persistA2ARuns();
      }
      return;
    }

    const completionState = await readTaskCompletionState(entry.taskPath).catch(() => undefined);
    if (!completionState?.allComplete) {
      if (mutated) {
        persistA2ARuns();
      }
      return;
    }

    try {
      await sendTaskReadyForSynthesis(entry, completionState);
      markSynthesisSignaled({
        callbackSessionKey: entry.callbackSessionKey,
        taskPath: entry.taskPath,
      });
      return;
    } catch (err) {
      log.warn("sessions_send synthesis trigger failed", {
        runId,
        error: formatErrorMessage(err),
      });
      if (mutated) {
        persistA2ARuns();
      }
      return;
    }
  } finally {
    processingRuns.delete(runId);
  }
}

async function waitForA2ARunCompletion(runId: string) {
  if (!runId || waitingRuns.has(runId)) {
    return;
  }
  waitingRuns.add(runId);
  try {
    const result = await waitForRunCompletion(runId);
    const entry = a2aRuns.get(runId);
    if (!entry) {
      return;
    }
    let mutated = false;
    if (typeof result.startedAt === "number" && !entry.startedAt) {
      entry.startedAt = result.startedAt;
      mutated = true;
    }
    if (typeof result.endedAt === "number") {
      entry.endedAt = result.endedAt;
      mutated = true;
    }
    if (!entry.endedAt) {
      entry.endedAt = Date.now();
      mutated = true;
    }
    entry.completion = result.completion;
    mutated = true;
    if (mutated) {
      persistA2ARuns();
    }
    await processA2ARun(runId);
  } catch (err) {
    log.warn("sessions_send completion watch failed", {
      runId,
      error: formatErrorMessage(err),
    });
  } finally {
    waitingRuns.delete(runId);
  }
}

function resumeA2ARun(runId: string) {
  const entry = a2aRuns.get(runId);
  if (!entry) {
    return;
  }
  if (entry.completion) {
    void processA2ARun(runId);
    return;
  }
  void waitForA2ARunCompletion(runId);
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const entry = a2aRuns.get(evt.runId);
    if (!entry) {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      if (startedAt && !entry.startedAt) {
        entry.startedAt = startedAt;
        persistA2ARuns();
      }
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
    entry.endedAt = endedAt;
    if (phase === "error") {
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      entry.completion = { status: "error", error };
    } else {
      entry.completion = { status: "ok" };
    }
    persistA2ARuns();
    void processA2ARun(evt.runId);
  });
}

function restoreA2ARunsOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restored = loadSessionsSendA2ARegistryFromDisk();
    if (restored.size === 0) {
      return;
    }
    for (const [runId, entry] of restored.entries()) {
      if (!runId || !entry) {
        continue;
      }
      if (!a2aRuns.has(runId)) {
        a2aRuns.set(runId, entry);
      }
    }
    ensureListener();
    startSweeper();
    for (const runId of a2aRuns.keys()) {
      resumeA2ARun(runId);
    }
  } catch {
    // ignore restore failures
  }
}

function ensureInitialized() {
  restoreA2ARunsOnce();
  ensureListener();
  if (a2aRuns.size > 0) {
    startSweeper();
  }
}

export function registerSessionsSendA2ARun(params: {
  targetSessionKey: string;
  displayKey: string;
  callbackSessionKey?: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  runId?: string;
  sourceMessage?: string;
}) {
  const runId = typeof params.runId === "string" ? params.runId.trim() : "";
  if (!runId) {
    return;
  }
  const callbackSessionKey = resolveCallbackSessionKey(params);
  if (!callbackSessionKey || callbackSessionKey === params.targetSessionKey) {
    return;
  }

  ensureInitialized();
  const cfg = loadConfig();
  const now = Date.now();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const existing = a2aRuns.get(runId);
  a2aRuns.set(runId, {
    runId,
    targetSessionKey: params.targetSessionKey,
    displayKey: params.displayKey,
    callbackSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    sourceMessage: params.sourceMessage,
    taskPath: extractTaskPathFromMessage(params.sourceMessage),
    createdAt: existing?.createdAt ?? now,
    startedAt: existing?.startedAt,
    endedAt: existing?.endedAt,
    completion: existing?.completion,
    callbackCompletedAt: existing?.callbackCompletedAt,
    synthesisCompletedAt: existing?.synthesisCompletedAt,
    archiveAtMs: existing?.archiveAtMs ?? archiveAtMs,
  });
  persistA2ARuns();
  startSweeper();
  resumeA2ARun(runId);
}

export function initSessionsSendA2ARegistry() {
  ensureInitialized();
}

export function resetSessionsSendA2ARegistryForTests() {
  a2aRuns.clear();
  waitingRuns.clear();
  processingRuns.clear();
  stopSweeper();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  persistA2ARuns();
}
