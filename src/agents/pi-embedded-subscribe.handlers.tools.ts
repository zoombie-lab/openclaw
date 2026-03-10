import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { normalizeTextForComparison } from "./pi-embedded-helpers.js";
import { isMessagingTool, isMessagingToolSendAction } from "./pi-embedded-messaging.js";
import {
  extractToolErrorMessage,
  extractToolResultText,
  extractMessagingToolSend,
  isToolResultError,
  sanitizeToolResult,
} from "./pi-embedded-subscribe.tools.js";
import { inferToolMetaFromArgs } from "./pi-embedded-utils.js";
import { normalizeToolParams } from "./pi-tools.read.js";
import { normalizeToolName } from "./tool-policy.js";

const ARG_SUMMARY_MAX_LEN = 240;
const MESSAGE_PREVIEW_MAX_LEN = 160;
const TASK_PREVIEW_MAX_LEN = 240;
const REDACTED_VALUE = "[redacted]";
const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /api[-_]?key/i,
  /authorization/i,
  /cookie/i,
  /bearer/i,
];

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "exec" && normalized !== "bash") {
    return meta;
  }
  if (!args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) {
    flags.push("pty");
  }
  if (record.elevated === true) {
    flags.push("elevated");
  }
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

function truncateForLog(value: string, maxLen = ARG_SUMMARY_MAX_LEN): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function sanitizeValueForLog(value: unknown, depth = 0): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value === "string") {
    return truncateForLog(normalizeWhitespace(value));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array:${value.length}]`;
    }
    return value.slice(0, 8).map((entry) => sanitizeValueForLog(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 2) {
      return "[object]";
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shouldRedactKey(key) ? REDACTED_VALUE : sanitizeValueForLog(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

function safeJsonForLog(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseTaskContract(task: string): Record<string, string> {
  const summary: Record<string, string> = {};
  const matchers: Array<[key: string, pattern: RegExp]> = [
    ["taskId", /^Task ID:\s*(.+)$/im],
    ["agentId", /^Agent ID:\s*(.+)$/im],
    ["question", /^Question:\s*(.+)$/im],
    ["artifact", /^Artifact path:\s*(.+)$/im],
  ];
  for (const [key, pattern] of matchers) {
    const match = task.match(pattern);
    if (match?.[1]) {
      summary[key] = truncateForLog(normalizeWhitespace(match[1]));
    }
  }
  return summary;
}

function summarizeMessageArgs(argsRecord: Record<string, unknown>): Record<string, unknown> {
  const messageText =
    typeof argsRecord.message === "string"
      ? argsRecord.message
      : typeof argsRecord.content === "string"
        ? argsRecord.content
        : "";
  return {
    action: typeof argsRecord.action === "string" ? argsRecord.action : undefined,
    channel: typeof argsRecord.channel === "string" ? argsRecord.channel : undefined,
    target: typeof argsRecord.target === "string" ? argsRecord.target : undefined,
    to: typeof argsRecord.to === "string" ? argsRecord.to : undefined,
    replyTo: typeof argsRecord.replyTo === "string" ? argsRecord.replyTo : undefined,
    threadId:
      typeof argsRecord.threadId === "string" || typeof argsRecord.threadId === "number"
        ? String(argsRecord.threadId)
        : undefined,
    messageLen: messageText.length || undefined,
    messagePreview: messageText
      ? truncateForLog(normalizeWhitespace(messageText), MESSAGE_PREVIEW_MAX_LEN)
      : undefined,
  };
}

function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
  const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  if (!argsRecord) {
    if (typeof args === "string") {
      return truncateForLog(normalizeWhitespace(args));
    }
    return undefined;
  }

  let summary: Record<string, unknown> | undefined;
  if (toolName === "read") {
    const normalized = normalizeToolParams(args);
    const record =
      normalized ?? (args && typeof args === "object" ? (args as Record<string, unknown>) : {});
    summary = {
      path: typeof record.path === "string" ? record.path : undefined,
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      encoding: typeof record.encoding === "string" ? record.encoding : undefined,
      offset: typeof record.offset === "number" ? record.offset : undefined,
      length: typeof record.length === "number" ? record.length : undefined,
    };
  } else if (toolName === "write" || toolName === "edit") {
    const text =
      typeof argsRecord.content === "string"
        ? argsRecord.content
        : typeof argsRecord.text === "string"
          ? argsRecord.text
          : "";
    summary = {
      path: typeof argsRecord.path === "string" ? argsRecord.path : undefined,
      contentLen: text.length || undefined,
    };
  } else if (toolName === "shopify_ops") {
    summary = sanitizeValueForLog(argsRecord) as Record<string, unknown>;
  } else if (toolName === "sessions_spawn") {
    const task = typeof argsRecord.task === "string" ? argsRecord.task : "";
    summary = {
      agentId: typeof argsRecord.agentId === "string" ? argsRecord.agentId : undefined,
      label: typeof argsRecord.label === "string" ? argsRecord.label : undefined,
      runTimeoutSeconds:
        typeof argsRecord.runTimeoutSeconds === "number" ? argsRecord.runTimeoutSeconds : undefined,
      cleanup: typeof argsRecord.cleanup === "string" ? argsRecord.cleanup : undefined,
      ...parseTaskContract(task),
      taskPreview: task
        ? truncateForLog(normalizeWhitespace(task), TASK_PREVIEW_MAX_LEN)
        : undefined,
    };
  } else if (isMessagingTool(toolName)) {
    summary = summarizeMessageArgs(argsRecord);
  } else {
    summary = sanitizeValueForLog(argsRecord) as Record<string, unknown>;
  }

  const compactEntries = Object.entries(summary).filter(([, value]) => value !== undefined);
  if (compactEntries.length === 0) {
    return undefined;
  }
  return safeJsonForLog(Object.fromEntries(compactEntries));
}

export const __test__ = {
  parseTaskContract,
  summarizeToolArgs,
};

export async function handleToolExecutionStart(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & { toolName: string; toolCallId: string; args: unknown },
) {
  // Flush pending block replies to preserve message boundaries before tool execution.
  ctx.flushBlockReplyBuffer();
  if (ctx.params.onBlockReplyFlush) {
    void ctx.params.onBlockReplyFlush();
  }

  const rawToolName = String(evt.toolName);
  const toolName = normalizeToolName(rawToolName);
  const toolCallId = String(evt.toolCallId);
  const args = evt.args;
  const argsSummary = summarizeToolArgs(toolName, args);

  if (toolName === "read") {
    const normalized = normalizeToolParams(args);
    const record =
      normalized ?? (args && typeof args === "object" ? (args as Record<string, unknown>) : {});
    const filePath = typeof record.path === "string" ? record.path.trim() : "";
    if (!filePath) {
      const argsPreview = typeof args === "string" ? args.slice(0, 200) : undefined;
      const argKeys = record && typeof record === "object" ? Object.keys(record).join(",") : "";
      ctx.log.warn(
        `read tool called without path: toolCallId=${toolCallId} argsType=${typeof args}${argKeys ? ` argKeys=${argKeys}` : ""}${argsPreview ? ` argsPreview=${argsPreview}` : ""}`,
      );
    }
  }

  const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
  ctx.state.toolMetaById.set(toolCallId, meta);
  ctx.state.toolStartTimes.set(toolCallId, { startMs: Date.now(), args: argsSummary });
  ctx.log.debug(
    `embedded run tool start: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}${argsSummary ? ` args=${argsSummary}` : ""}`,
  );

  const shouldEmitToolEvents = ctx.shouldEmitToolResult();
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "start",
      name: toolName,
      toolCallId,
      args: args as Record<string, unknown>,
      argsSummary,
    },
  });
  // Best-effort typing signal; do not block tool summaries on slow emitters.
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: { phase: "start", name: toolName, toolCallId },
  });

  if (
    ctx.params.onToolResult &&
    shouldEmitToolEvents &&
    !ctx.state.toolSummaryById.has(toolCallId)
  ) {
    ctx.state.toolSummaryById.add(toolCallId);
    ctx.emitToolSummary(toolName, meta);
  }

  // Track messaging tool sends (pending until confirmed in tool_execution_end).
  if (isMessagingTool(toolName)) {
    const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const isMessagingSend = isMessagingToolSendAction(toolName, argsRecord);
    if (isMessagingSend) {
      const sendTarget = extractMessagingToolSend(toolName, argsRecord);
      if (sendTarget) {
        ctx.state.pendingMessagingTargets.set(toolCallId, sendTarget);
      }
      // Field names vary by tool: Discord/Slack use "content", sessions_send uses "message"
      const text = (argsRecord.content as string) ?? (argsRecord.message as string);
      if (text && typeof text === "string") {
        ctx.state.pendingMessagingTexts.set(toolCallId, text);
        ctx.log.debug(`Tracking pending messaging text: tool=${toolName} len=${text.length}`);
      }
    }
  }
}

export function handleToolExecutionUpdate(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    partialResult?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const partial = evt.partialResult;
  const sanitized = sanitizeToolResult(partial);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
      partialResult: sanitized,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "update",
      name: toolName,
      toolCallId,
    },
  });
}

export function handleToolExecutionEnd(
  ctx: EmbeddedPiSubscribeContext,
  evt: AgentEvent & {
    toolName: string;
    toolCallId: string;
    isError: boolean;
    result?: unknown;
  },
) {
  const toolName = normalizeToolName(String(evt.toolName));
  const toolCallId = String(evt.toolCallId);
  const isError = Boolean(evt.isError);
  const result = evt.result;
  const isToolError = isError || isToolResultError(result);
  const sanitizedResult = sanitizeToolResult(result);
  const meta = ctx.state.toolMetaById.get(toolCallId);
  ctx.state.toolMetas.push({ toolName, meta });
  ctx.state.toolMetaById.delete(toolCallId);
  ctx.state.toolSummaryById.delete(toolCallId);
  if (isToolError) {
    const errorMessage = extractToolErrorMessage(sanitizedResult);
    ctx.state.lastToolError = {
      toolName,
      meta,
      error: errorMessage,
    };
  }

  // Commit messaging tool text on success, discard on error.
  const pendingText = ctx.state.pendingMessagingTexts.get(toolCallId);
  const pendingTarget = ctx.state.pendingMessagingTargets.get(toolCallId);
  if (pendingText) {
    ctx.state.pendingMessagingTexts.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTexts.push(pendingText);
      ctx.state.messagingToolSentTextsNormalized.push(normalizeTextForComparison(pendingText));
      ctx.log.debug(`Committed messaging text: tool=${toolName} len=${pendingText.length}`);
      ctx.trimMessagingToolSent();
    }
  }
  if (pendingTarget) {
    ctx.state.pendingMessagingTargets.delete(toolCallId);
    if (!isToolError) {
      ctx.state.messagingToolSentTargets.push(pendingTarget);
      ctx.trimMessagingToolSent();
    }
  }

  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
      result: sanitizedResult,
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "tool",
    data: {
      phase: "result",
      name: toolName,
      toolCallId,
      meta,
      isError: isToolError,
    },
  });

  const toolStart = ctx.state.toolStartTimes.get(toolCallId);
  if (toolStart) {
    const endMs = Date.now();
    ctx.state.toolTrace.push({
      tool: toolName,
      toolCallId,
      args: toolStart.args,
      startMs: toolStart.startMs,
      endMs,
      durationMs: endMs - toolStart.startMs,
      error: isToolError || undefined,
    });
    ctx.state.toolStartTimes.delete(toolCallId);
  }
  ctx.log.debug(
    `embedded run tool end: runId=${ctx.params.runId} tool=${toolName} toolCallId=${toolCallId}`,
  );

  if (ctx.params.onToolResult && ctx.shouldEmitToolOutput()) {
    const outputText = extractToolResultText(sanitizedResult);
    if (outputText) {
      ctx.emitToolOutput(toolName, meta, outputText);
    }
  }
}
