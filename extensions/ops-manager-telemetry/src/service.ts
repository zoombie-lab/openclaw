import type {
  DiagnosticUsageEvent,
  OpenClawPluginService,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
} from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";

const DEFAULT_ENDPOINT_PATH = "/api/agent/v1/telemetry/usage";
const AGENT_SESSION_KEY_RE = /^agent:([^:]+):/i;

function normalizeBaseUrl(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function normalizeOrigin(value?: string): "slack" | "cron" | "web" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "slack") {
    return "slack";
  }
  if (normalized === "cron") {
    return "cron";
  }
  if (normalized === "web") {
    return "web";
  }
  return "unknown";
}

function asNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

type PendingToolUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  promptTokens: number;
  total: number;
  toolCalls: string[];
};

type OpsManagerTelemetryUsageAccumulator = {
  recordToolResultUsage: (
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ) => void;
  consumePendingUsage: (sessionKey?: string) => PendingToolUsage | null;
  clearPendingUsage: (sessionKey?: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePendingToolUsage(raw: unknown): Omit<PendingToolUsage, "toolCalls"> | null {
  if (!isRecord(raw)) {
    return null;
  }

  const input = asNonNegativeNumber(
    raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens,
  );
  const output = asNonNegativeNumber(
    raw.output ??
      raw.outputTokens ??
      raw.output_tokens ??
      raw.completionTokens ??
      raw.completion_tokens,
  );
  const cacheRead = asNonNegativeNumber(
    raw.cacheRead ?? raw.cache_read ?? raw.cache_read_input_tokens,
  );
  const cacheWrite = asNonNegativeNumber(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens,
  );
  const explicitPromptTokens = asNonNegativeNumber(raw.promptTokens ?? raw.prompt_tokens);
  const promptTokens =
    explicitPromptTokens > 0 ? explicitPromptTokens : input + cacheRead + cacheWrite;
  const explicitTotal = asNonNegativeNumber(raw.total ?? raw.totalTokens ?? raw.total_tokens);
  const total =
    explicitTotal > 0 ? Math.max(explicitTotal, promptTokens + output) : promptTokens + output;

  if (promptTokens === 0 && output === 0 && total === 0) {
    return null;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    promptTokens,
    total,
  };
}

function extractPendingToolUsage(
  event: PluginHookToolResultPersistEvent,
  ctx: PluginHookToolResultPersistContext,
): PendingToolUsage | null {
  const toolName = event.toolName?.trim() || ctx.toolName?.trim();
  if (toolName !== "image_generate" || event.isSynthetic) {
    return null;
  }

  const message = isRecord(event.message) ? event.message : null;
  const details = message && isRecord(message.details) ? message.details : null;
  const metadata = details && isRecord(details.metadata) ? details.metadata : null;
  const usage =
    normalizePendingToolUsage(metadata?.normalizedUsage) ??
    normalizePendingToolUsage(metadata?.usage);

  if (!usage) {
    return null;
  }

  return {
    ...usage,
    toolCalls: [toolName],
  };
}

export function createOpsManagerTelemetryUsageAccumulator(): OpsManagerTelemetryUsageAccumulator {
  const pendingUsageBySession = new Map<string, PendingToolUsage>();

  return {
    recordToolResultUsage(event, ctx) {
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) {
        return;
      }

      const usage = extractPendingToolUsage(event, ctx);
      if (!usage) {
        return;
      }

      const existing = pendingUsageBySession.get(sessionKey);
      pendingUsageBySession.set(sessionKey, {
        input: (existing?.input ?? 0) + usage.input,
        output: (existing?.output ?? 0) + usage.output,
        cacheRead: (existing?.cacheRead ?? 0) + usage.cacheRead,
        cacheWrite: (existing?.cacheWrite ?? 0) + usage.cacheWrite,
        promptTokens: (existing?.promptTokens ?? 0) + usage.promptTokens,
        total: (existing?.total ?? 0) + usage.total,
        toolCalls: [...(existing?.toolCalls ?? []), ...usage.toolCalls],
      });
    },
    consumePendingUsage(sessionKey) {
      const key = sessionKey?.trim();
      if (!key) {
        return null;
      }
      const usage = pendingUsageBySession.get(key) ?? null;
      pendingUsageBySession.delete(key);
      return usage;
    },
    clearPendingUsage(sessionKey) {
      const key = sessionKey?.trim();
      if (!key) {
        return;
      }
      pendingUsageBySession.delete(key);
    },
  };
}

function extractAgentId(sessionKey?: string): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const match = AGENT_SESSION_KEY_RE.exec(raw);
  const agentId = match?.[1]?.trim();
  return agentId || undefined;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildUsagePayload(evt: DiagnosticUsageEvent, pendingToolUsage: PendingToolUsage | null) {
  const input = asNonNegativeNumber(evt.usage.input);
  const output = asNonNegativeNumber(evt.usage.output);
  const cacheRead = asNonNegativeNumber(evt.usage.cacheRead);
  const cacheWrite = asNonNegativeNumber(evt.usage.cacheWrite);
  const promptTokens =
    asNonNegativeNumber(evt.usage.promptTokens) || input + cacheRead + cacheWrite;
  const total = asNonNegativeNumber(evt.usage.total) || promptTokens + output;
  const combinedInput = input + (pendingToolUsage?.input ?? 0);
  const combinedOutput = output + (pendingToolUsage?.output ?? 0);
  const combinedCacheRead = cacheRead + (pendingToolUsage?.cacheRead ?? 0);
  const combinedCacheWrite = cacheWrite + (pendingToolUsage?.cacheWrite ?? 0);
  const combinedPromptTokens = promptTokens + (pendingToolUsage?.promptTokens ?? 0);
  const combinedTotal = total + (pendingToolUsage?.total ?? 0);

  const durationMs = asNonNegativeNumber(evt.durationMs);
  const finishedAtMs = asNonNegativeNumber(evt.ts);
  const startedAtMs = finishedAtMs > 0 && durationMs > 0 ? finishedAtMs - durationMs : finishedAtMs;

  const agentId = extractAgentId(evt.sessionKey);
  const model = evt.model?.trim() || "unknown";
  const provider = evt.provider?.trim() || undefined;

  return {
    agentId,
    sessionKey: evt.sessionKey?.trim() || undefined,
    origin: normalizeOrigin(evt.channel),
    provider,
    model,
    usage: {
      input: combinedInput,
      output: combinedOutput,
      cacheRead: combinedCacheRead,
      cacheWrite: combinedCacheWrite,
      promptTokens: combinedPromptTokens,
      total: combinedTotal,
    },
    startedAt: startedAtMs > 0 ? toIso(startedAtMs) : undefined,
    finishedAt: finishedAtMs > 0 ? toIso(finishedAtMs) : undefined,
    inputMessages: 1,
    outputMessages: 1,
    steps: 1,
    toolCalls: [...(pendingToolUsage?.toolCalls ?? [])],
  };
}

function signRequest(secret: string, body: string) {
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${nonce}.${body}`)
    .digest("hex");

  return { ts, nonce, signature };
}

export function createOpsManagerTelemetryService(
  usageAccumulator: OpsManagerTelemetryUsageAccumulator = createOpsManagerTelemetryUsageAccumulator(),
): OpenClawPluginService {
  let unsubscribe: (() => void) | null = null;
  let pending = Promise.resolve();
  let stopped = false;

  return {
    id: "ops-manager-telemetry",
    async start(ctx) {
      const installationId = process.env.INSTALLATION_ID?.trim() || "";
      const baseUrl = normalizeBaseUrl(process.env.OPS_MANAGER_URL);
      const signingSecret = process.env.OPS_SIGNING_SECRET?.trim() || "";

      if (!installationId || !baseUrl || !signingSecret) {
        ctx.logger.warn(
          "ops-manager-telemetry: missing INSTALLATION_ID, OPS_MANAGER_URL, or OPS_SIGNING_SECRET; telemetry disabled",
        );
        return;
      }

      const endpoint = `${baseUrl}${DEFAULT_ENDPOINT_PATH}`;

      const enqueue = (task: () => Promise<void>) => {
        pending = pending
          .then(async () => {
            if (stopped) {
              return;
            }
            await task();
          })
          .catch((error: unknown) => {
            ctx.logger.warn(`ops-manager-telemetry: failed to deliver event: ${String(error)}`);
          });
      };

      const postUsageEvent = async (evt: DiagnosticUsageEvent) => {
        const payload = buildUsagePayload(
          evt,
          usageAccumulator.consumePendingUsage(evt.sessionKey),
        );
        const body = JSON.stringify(payload);
        const signed = signRequest(signingSecret, body);

        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-ops-installation-id": installationId,
          "x-ops-ts": signed.ts,
          "x-ops-nonce": signed.nonce,
          "x-ops-signature": signed.signature,
        };
        if (payload.agentId) {
          headers["x-ops-agent-id"] = payload.agentId;
        }

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`status=${response.status} body=${detail.slice(0, 300)}`);
        }
      };

      unsubscribe = onDiagnosticEvent((evt) => {
        if (evt.type !== "model.usage") {
          return;
        }
        enqueue(() => postUsageEvent(evt));
      });

      ctx.logger.info("ops-manager-telemetry: forwarding model.usage events");
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      await pending.catch(() => undefined);
    },
  } satisfies OpenClawPluginService;
}
