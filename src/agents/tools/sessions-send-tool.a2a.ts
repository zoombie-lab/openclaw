import crypto from "node:crypto";
import fs from "node:fs/promises";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";

const log = createSubsystemLogger("agents/sessions-send");
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

const taskReadySignalDispatched = new Set<string>();

function extractTaskPathFromMessage(message?: string): string | undefined {
  if (typeof message !== "string") {
    return undefined;
  }
  const match = message.match(/\/data\/shared\/tasks\/queue\/[^\s`"')]+\.md/i);
  return match?.[0];
}

async function waitForRunCompletion(runId: string): Promise<RunCompletion> {
  const deadline = Date.now() + MAX_COMPLETION_WATCH_MS;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const waitMs = Math.max(1, Math.min(WAIT_POLL_TIMEOUT_MS, remainingMs));
    const wait = await callGateway<{ status?: string; error?: string }>({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs: waitMs,
      },
      timeoutMs: waitMs + 2000,
    });
    if (wait?.status === "ok") {
      return { status: "ok" };
    }
    if (wait?.status === "error") {
      return { status: "error", error: wait.error };
    }
    if (wait?.status !== "timeout") {
      return {
        status: "error",
        error: `unexpected wait status: ${String(wait?.status ?? "unknown")}`,
      };
    }
  }
  return {
    status: "timeout",
    error: "completion watcher timeout exceeded",
  };
}

function buildCompletionCallbackMessage(params: {
  runId: string;
  displayKey: string;
  completion: RunCompletion;
  taskPath?: string;
}) {
  const lines = [
    "TASK_COMPLETE",
    `runId: ${params.runId}`,
    `targetSession: ${params.displayKey}`,
    `status: ${params.completion.status}`,
    params.taskPath ? `taskFile: ${params.taskPath}` : undefined,
  ];
  if (params.completion.error) {
    lines.push(`error: ${params.completion.error}`);
  }
  return lines.filter((line): line is string => typeof line === "string").join("\n");
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

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  callbackSessionKey?: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  waitRunId?: string;
  sourceMessage?: string;
}) {
  const runId = params.waitRunId;
  try {
    if (!runId) {
      return;
    }
    const callbackSessionKey =
      typeof params.callbackSessionKey === "string" && params.callbackSessionKey.trim()
        ? params.callbackSessionKey.trim()
        : typeof params.requesterSessionKey === "string" && params.requesterSessionKey.trim()
          ? params.requesterSessionKey.trim()
          : undefined;
    if (!callbackSessionKey || callbackSessionKey === params.targetSessionKey) {
      return;
    }

    const completion = await waitForRunCompletion(runId);
    const taskPath = extractTaskPathFromMessage(params.sourceMessage);
    const callbackMessage = buildCompletionCallbackMessage({
      runId,
      displayKey: params.displayKey,
      completion,
      taskPath,
    });
    await callGateway({
      method: "agent",
      params: {
        message: callbackMessage,
        sessionKey: callbackSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: [
          "Task completion callback from sessions_send.",
          params.requesterChannel ? `Requester channel: ${params.requesterChannel}.` : undefined,
          params.requesterSessionKey
            ? `Original requester session: ${params.requesterSessionKey}.`
            : undefined,
          `Callback target session: ${callbackSessionKey}.`,
          `Target session: ${params.displayKey}.`,
          "Acknowledge completion and decide if follow-up work is needed.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      timeoutMs: 10_000,
    });

    if (completion.status !== "ok" || !taskPath) {
      return;
    }
    const completionState = await readTaskCompletionState(taskPath).catch(() => undefined);
    if (!completionState?.allComplete) {
      return;
    }
    const signalKey = `${callbackSessionKey}::${taskPath}`;
    if (taskReadySignalDispatched.has(signalKey)) {
      return;
    }
    taskReadySignalDispatched.add(signalKey);
    const taskReadyMessage = buildTaskReadyForSynthesisMessage({
      taskPath,
      runId,
      displayKey: params.displayKey,
      completionState,
    });
    await callGateway({
      method: "agent",
      params: {
        message: taskReadyMessage,
        sessionKey: callbackSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: [
          "Deterministic orchestration signal from sessions_send.",
          "All specialist sections in the task file are marked Status: Complete.",
          "Re-read the task file now, write synthesis if missing, send final report if required, then archive the task.",
        ].join("\n"),
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    log.warn("sessions_send completion callback failed", {
      runId: runId ?? "unknown",
      error: formatErrorMessage(err),
    });
  }
}
