import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "./types.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";

function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(agentId, env, homedir);
}

export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: string | number,
): string {
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId !== undefined ? `${sessionId}-topic-${safeTopicId}.jsonl` : `${sessionId}.jsonl`;
  return path.join(resolveAgentSessionsDir(agentId), fileName);
}

export function resolveSessionHistoryDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const root = resolveStateDir(env, homedir);
  // ~/.openclaw/workspace/history
  return path.join(root, "workspace", "history");
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

function sanitizePathToken(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "unknown";
}

function normalizeIdToken(value?: string | number): string | null {
  if (value == null) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const providerPrefixed = /^([a-z0-9_-]+):(.*)$/i.exec(raw);
  const token = providerPrefixed?.[2]?.trim() || raw;
  return token.toLowerCase();
}

function resolvePredictableSessionId(entry: SessionEntry, type: string): string {
  if (type === "direct") {
    const from = normalizeIdToken(entry.origin?.from);
    const to = normalizeIdToken(entry.origin?.to);
    if (from && to) {
      return from === to ? from : [from, to].toSorted().join("__");
    }
    return from || to || "unknown";
  }

  const channelId =
    normalizeIdToken(entry.groupId) ||
    normalizeIdToken(entry.origin?.from) ||
    normalizeIdToken(entry.origin?.to);
  return channelId || "unknown";
}

export function resolvePredictableSessionPath(
  entry: SessionEntry,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string | null {
  const platformToken = entry.channel?.trim() || entry.origin?.provider?.trim();
  const typeToken = entry.chatType?.trim() || entry.origin?.chatType?.trim();
  if (!platformToken || !typeToken) {
    return null;
  }
  const platform = platformToken.toLowerCase();
  const type = typeToken.toLowerCase();
  const threadId = normalizeIdToken(entry.origin?.threadId ?? entry.lastThreadId);
  const baseId = resolvePredictableSessionId(entry, type);
  if (baseId === "unknown") {
    return null;
  }
  const combinedId = threadId ? `${baseId}__thread_${threadId}` : baseId;

  const safeId = sanitizePathToken(combinedId);
  const safePlatform = sanitizePathToken(platform);
  const safeType = sanitizePathToken(type);

  const date = new Date();
  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  // Structure: history/{platform}/{type}/{id}/{date}.jsonl
  const historyDir = resolveSessionHistoryDir(env, homedir);
  return path.join(historyDir, safePlatform, safeType, safeId, `${dateStr}.jsonl`);
}

export function resolveSessionFilePath(
  sessionId: string,
  entry?: SessionEntry,
  opts?: { agentId?: string; topicId?: string | number },
): string {
  const candidate = entry?.sessionFile?.trim();
  if (entry && (entry.channel || entry.origin || entry.groupId)) {
    const predictable = resolvePredictableSessionPath(entry);
    if (predictable) {
      if (!candidate) {
        return predictable;
      }
      const resolvedCandidate = path.resolve(candidate);
      const resolvedPredictable = path.resolve(predictable);
      if (resolvedCandidate === resolvedPredictable) {
        return candidate;
      }
      const resolvedLegacyDir = path.resolve(resolveAgentSessionsDir(opts?.agentId));
      if (resolvedCandidate.startsWith(`${resolvedLegacyDir}${path.sep}`)) {
        return predictable;
      }
      const resolvedHistoryDir = path.resolve(resolveSessionHistoryDir());
      if (resolvedCandidate.startsWith(`${resolvedHistoryDir}${path.sep}`)) {
        return predictable;
      }
    }
  }

  if (candidate) {
    return candidate;
  }
  return resolveSessionTranscriptPath(sessionId, opts?.agentId, opts?.topicId);
}

export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!store) {
    return resolveDefaultSessionStorePath(agentId);
  }
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    if (expanded.startsWith("~")) {
      return path.resolve(
        expandHomePrefix(expanded, {
          home: resolveRequiredHomeDir(process.env, os.homedir),
          env: process.env,
          homedir: os.homedir,
        }),
      );
    }
    return path.resolve(expanded);
  }
  if (store.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(store, {
        home: resolveRequiredHomeDir(process.env, os.homedir),
        env: process.env,
        homedir: os.homedir,
      }),
    );
  }
  return path.resolve(store);
}
