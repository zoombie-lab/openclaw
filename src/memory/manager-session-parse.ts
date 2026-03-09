import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionHistoryDir } from "../config/sessions.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";
import { normalizeTimestampMs } from "./manager-time-filter.js";

const log = createSubsystemLogger("memory");

export type SessionIndexedMessage = {
  text: string;
  messageTs?: number;
  dateBucket?: string;
};

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  messages: SessionIndexedMessage[];
};

export function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export function parseSessionTimestamp(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return normalizeTimestampMs(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }
    return normalizeTimestampMs(numeric);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

export function toDateBucket(timestampMs?: number): string | undefined {
  if (!timestampMs) {
    return undefined;
  }
  try {
    return new Date(timestampMs).toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveRoleLabel(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "assistant") {
    return "Assistant";
  }
  if (normalized === "user") {
    return "User";
  }
  if (normalized === "system") {
    return "System";
  }
  if (normalized === "tool") {
    return "Tool";
  }
  if (!normalized) {
    return "Message";
  }
  return `${normalized[0]?.toUpperCase() ?? ""}${normalized.slice(1)}`;
}

export function parseOpenClawSessionRecord(
  record: Record<string, unknown>,
): SessionIndexedMessage | null {
  if (record.type !== "message") {
    return null;
  }
  const message = asRecord(record.message);
  if (!message || typeof message.role !== "string") {
    return null;
  }
  const text = extractSessionText(message.content);
  if (!text) {
    return null;
  }
  const messageTs =
    parseSessionTimestamp(message.timestamp) ??
    parseSessionTimestamp(message.ts) ??
    parseSessionTimestamp(record.timestamp) ??
    parseSessionTimestamp(record.ts);
  return {
    text: `${resolveRoleLabel(String(message.role))}: ${text}`,
    ...(messageTs != null ? { messageTs } : {}),
    ...(messageTs != null ? { dateBucket: toDateBucket(messageTs) } : {}),
  };
}

export function parseSlackLikeRecord(
  record: Record<string, unknown>,
): SessionIndexedMessage | null {
  const payload =
    record.subtype === "message_changed" ? (asRecord(record.message) ?? record) : record;
  const text = typeof payload.text === "string" ? normalizeSessionText(payload.text) : "";
  if (!text) {
    return null;
  }
  const username =
    (typeof payload.username === "string" && payload.username.trim()) ||
    (typeof payload.user === "string" && payload.user.trim()) ||
    (typeof payload.bot_id === "string" && payload.bot_id.trim()) ||
    (typeof record.username === "string" && record.username.trim()) ||
    (typeof record.user === "string" && record.user.trim()) ||
    (typeof record.bot_id === "string" && record.bot_id.trim()) ||
    "message";
  const messageTs =
    parseSessionTimestamp(payload.ts) ??
    parseSessionTimestamp(payload.thread_ts) ??
    parseSessionTimestamp(payload.event_ts) ??
    parseSessionTimestamp(record.ts) ??
    parseSessionTimestamp(record.thread_ts) ??
    parseSessionTimestamp(record.event_ts);
  return {
    text: `Slack ${username}: ${text}`,
    ...(messageTs != null ? { messageTs } : {}),
    ...(messageTs != null ? { dateBucket: toDateBucket(messageTs) } : {}),
  };
}

export function parseSessionRecord(record: unknown): SessionIndexedMessage | null {
  const root = asRecord(record);
  if (!root) {
    return null;
  }
  const direct = parseOpenClawSessionRecord(root) ?? parseSlackLikeRecord(root);
  if (direct) {
    return direct;
  }
  for (const key of ["event", "payload"]) {
    const nested = asRecord(root[key]);
    if (!nested) {
      continue;
    }
    const parsed = parseOpenClawSessionRecord(nested) ?? parseSlackLikeRecord(nested);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function sessionPathForFile(absPath: string, agentId: string): string {
  const sessionsDir = path.resolve(resolveSessionTranscriptsDirForAgent(agentId));
  const historyDir = path.resolve(resolveSessionHistoryDir());
  const resolved = path.resolve(absPath);
  if (resolved.startsWith(`${sessionsDir}${path.sep}`)) {
    return path
      .join("sessions", "legacy", path.relative(sessionsDir, resolved))
      .replace(/\\/g, "/");
  }
  if (resolved.startsWith(`${historyDir}${path.sep}`)) {
    return path
      .join("sessions", "history", path.relative(historyDir, resolved))
      .replace(/\\/g, "/");
  }
  return path.join("sessions", path.basename(resolved)).replace(/\\/g, "/");
}

export async function buildSessionEntry(
  absPath: string,
  agentId: string,
  onParseFailures: (count: number) => void,
): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const messages: SessionIndexedMessage[] = [];
    let parseFailures = 0;
    let parsedLines = 0;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      parsedLines += 1;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        parseFailures += 1;
        continue;
      }
      const message = parseSessionRecord(record);
      if (!message) {
        continue;
      }
      messages.push(message);
    }
    if (parseFailures > 0) {
      onParseFailures(parseFailures);
      const parseRate = parsedLines > 0 ? parseFailures / parsedLines : 1;
      if (parseRate >= 0.2) {
        log.warn(
          `memory sessions: parse issues in ${absPath} (${parseFailures}/${parsedLines} lines failed JSON parse)`,
        );
      }
    }
    const content = messages.map((message) => message.text).join("\n");
    const hashContent = messages
      .map((message) => `${message.messageTs ?? ""}\t${message.dateBucket ?? ""}\t${message.text}`)
      .join("\n");
    return {
      path: sessionPathForFile(absPath, agentId),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(hashContent),
      content,
      messages,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    onParseFailures(1);
    return null;
  }
}
