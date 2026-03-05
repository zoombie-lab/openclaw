import type { DiagnosticUsageEvent, OpenClawPluginService } from "openclaw/plugin-sdk";
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

function buildUsagePayload(evt: DiagnosticUsageEvent) {
  const input = asNonNegativeNumber(evt.usage.input);
  const output = asNonNegativeNumber(evt.usage.output);
  const cacheRead = asNonNegativeNumber(evt.usage.cacheRead);
  const cacheWrite = asNonNegativeNumber(evt.usage.cacheWrite);
  const promptTokens =
    asNonNegativeNumber(evt.usage.promptTokens) || input + cacheRead + cacheWrite;
  const total = asNonNegativeNumber(evt.usage.total) || promptTokens + output;

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
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      total,
    },
    startedAt: startedAtMs > 0 ? toIso(startedAtMs) : undefined,
    finishedAt: finishedAtMs > 0 ? toIso(finishedAtMs) : undefined,
    inputMessages: 1,
    outputMessages: 1,
    steps: 1,
    toolCalls: [] as string[],
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

export function createOpsManagerTelemetryService(): OpenClawPluginService {
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
        const payload = buildUsagePayload(evt);
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
