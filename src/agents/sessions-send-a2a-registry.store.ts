import path from "node:path";
import type { SessionsSendA2ARunRecord } from "./sessions-send-a2a-registry.js";
import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

type PersistedRegistry = {
  version: 1;
  runs: Record<string, SessionsSendA2ARunRecord>;
};

const REGISTRY_VERSION = 1 as const;

export function resolveSessionsSendA2ARegistryPath() {
  return path.join(STATE_DIR, "a2a", "runs.json");
}

export function loadSessionsSendA2ARegistryFromDisk(): Map<string, SessionsSendA2ARunRecord> {
  const pathname = resolveSessionsSendA2ARegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedRegistry>;
  if (record.version !== 1 || !record.runs || typeof record.runs !== "object") {
    return new Map();
  }
  const out = new Map<string, SessionsSendA2ARunRecord>();
  for (const [runId, entry] of Object.entries(record.runs)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as SessionsSendA2ARunRecord;
    if (!typed.runId || typeof typed.runId !== "string") {
      continue;
    }
    out.set(runId, typed);
  }
  return out;
}

export function saveSessionsSendA2ARegistryToDisk(runs: Map<string, SessionsSendA2ARunRecord>) {
  const pathname = resolveSessionsSendA2ARegistryPath();
  const serialized: Record<string, SessionsSendA2ARunRecord> = {};
  for (const [runId, entry] of runs.entries()) {
    serialized[runId] = entry;
  }
  const out: PersistedRegistry = {
    version: REGISTRY_VERSION,
    runs: serialized,
  };
  saveJsonFile(pathname, out);
}
