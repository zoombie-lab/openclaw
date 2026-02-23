import crypto from "node:crypto";
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

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
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
    if (!params.requesterSessionKey || params.requesterSessionKey === params.targetSessionKey) {
      return;
    }

    const completion = await waitForRunCompletion(runId);
    const callbackMessage = buildCompletionCallbackMessage({
      runId,
      displayKey: params.displayKey,
      completion,
      taskPath: extractTaskPathFromMessage(params.sourceMessage),
    });
    await callGateway({
      method: "agent",
      params: {
        message: callbackMessage,
        sessionKey: params.requesterSessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_NESTED,
        extraSystemPrompt: [
          "Task completion callback from sessions_send.",
          params.requesterChannel ? `Requester channel: ${params.requesterChannel}.` : undefined,
          `Target session: ${params.displayKey}.`,
          "Acknowledge completion and decide if follow-up work is needed.",
        ]
          .filter(Boolean)
          .join("\n"),
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
