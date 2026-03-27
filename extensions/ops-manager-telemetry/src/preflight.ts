import type { PluginHookBeforeAgentStartResult } from "openclaw/plugin-sdk";

const DEFAULT_PREFLIGHT_PATH = "/api/internal/openclaw/preflight";
const GENERIC_PREFLIGHT_FAILURE_MESSAGE =
  "Freddy is temporarily unavailable because quota preflight could not be completed. Please try again shortly.";

type LoggerLike = {
  warn?: (message: string) => void;
};

type PreflightAllowResponse = {
  allowed: true;
};

type PreflightDenyResponse = {
  allowed: false;
  reason?: string;
  denialReason?: string;
};

type PreflightResponse = PreflightAllowResponse | PreflightDenyResponse;

let warnedAboutMissingConfig = false;

function normalizeBaseUrl(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function warnOnceMissingConfig(logger?: LoggerLike): void {
  if (warnedAboutMissingConfig) {
    return;
  }
  warnedAboutMissingConfig = true;
  logger?.warn?.(
    "ops-manager-telemetry: missing CHATBOT_BACKEND_URL, SHOP_DOMAIN, or OPS_SIGNING_SECRET; OpenClaw preflight disabled",
  );
}

function buildDenyMessage(payload: PreflightDenyResponse): string {
  switch (payload.denialReason) {
    case "subscription_inactive":
      return "Freddy is unavailable because this shop does not have an active subscription.";
    case "freddy_not_available":
      return "Freddy is unavailable on the current plan.";
    case "token_limit_reached":
      return "Freddy token limit reached for the current billing period.";
    default:
      return payload.reason?.trim() || "Freddy run denied before execution.";
  }
}

export async function runOpenClawPreflight(params: {
  fetchFn?: typeof fetch;
  chatbotBackendUrl?: string;
  shopDomain?: string;
  internalSecret?: string;
  logger?: LoggerLike;
}): Promise<PluginHookBeforeAgentStartResult | undefined> {
  const baseUrl = normalizeBaseUrl(params.chatbotBackendUrl ?? process.env.CHATBOT_BACKEND_URL);
  const shopDomain = params.shopDomain?.trim() || process.env.SHOP_DOMAIN?.trim() || "";
  const internalSecret =
    params.internalSecret?.trim() || process.env.OPS_SIGNING_SECRET?.trim() || "";

  if (!baseUrl || !shopDomain || !internalSecret) {
    warnOnceMissingConfig(params.logger);
    return undefined;
  }

  let response: Response;
  try {
    response = await (params.fetchFn ?? fetch)(`${baseUrl}${DEFAULT_PREFLIGHT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-api-secret": internalSecret,
      },
      body: JSON.stringify({ shopDomain }),
    });
  } catch {
    return {
      cancel: true,
      error: GENERIC_PREFLIGHT_FAILURE_MESSAGE,
    };
  }

  if (!response.ok) {
    return {
      cancel: true,
      error: GENERIC_PREFLIGHT_FAILURE_MESSAGE,
    };
  }

  const payload = (await response.json().catch(() => null)) as PreflightResponse | null;
  if (!payload || typeof payload !== "object") {
    return {
      cancel: true,
      error: GENERIC_PREFLIGHT_FAILURE_MESSAGE,
    };
  }

  if (payload.allowed) {
    return undefined;
  }

  return {
    cancel: true,
    error: buildDenyMessage(payload),
  };
}
