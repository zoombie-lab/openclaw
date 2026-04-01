import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import { stringEnum } from "../../agents/schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../../agents/tools/common.js";

// ── Action groups ──────────────────────────────────────────────────────────

const DATE_RANGE_ACTIONS = [
  "sales-analytics",
  "fulfillment-velocity",
  "chatbot-metrics",
  "chatbot-escalation-metrics",
] as const;

const NON_DATE_ACTIONS = [
  "inventory-analytics",
  "search-orders",
  "product-inventory",
  "order-timeline",
  "refund-and-return-worker",
  "refund-and-return-export",
  "ops-snapshot",
] as const;

// Combined list for runtime validation.
const SHOPIFY_OPS_ACTIONS = [...DATE_RANGE_ACTIONS, ...NON_DATE_ACTIONS] as const;

// ── Schemas ────────────────────────────────────────────────────────────────

const DateRangeSchema = Type.Object(
  {
    action: stringEnum(DATE_RANGE_ACTIONS, {
      description: "The analytics action to run.",
    }),
    startDate: Type.String({
      description: "Start of the query window (YYYY-MM-DD).",
    }),
    endDate: Type.String({
      description: "End of the query window (YYYY-MM-DD).",
    }),
    compareWithPreviousPeriod: Type.Optional(
      Type.Boolean({
        description: "Compare with the previous period of equal length. Used with sales-analytics.",
      }),
    ),
  },
  { additionalProperties: true },
);

const NonDateSchema = Type.Object(
  {
    action: stringEnum(NON_DATE_ACTIONS, {
      description: "The analytics action to run.",
    }),
    query: Type.Optional(
      Type.String({
        description:
          'Shopify search query. Required for search-orders, e.g. "name:#1234" or "email:customer@example.com".',
      }),
    ),
    task: Type.Optional(
      Type.String({
        description:
          "Natural-language task or question for the combined refund and return worker/export actions.",
      }),
    ),
    topNRecurringSkus: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 500,
        description:
          "Optional cap for how many recurring-return SKUs to include in combined refund and return results.",
      }),
    ),
    windowStartUtc: Type.Optional(
      Type.String({
        description:
          "Optional ISO timestamp (UTC) for the report window start. Must be paired with windowEndUtc.",
      }),
    ),
    windowEndUtc: Type.Optional(
      Type.String({
        description:
          "Optional ISO timestamp (UTC) for the report window end. Must be paired with windowStartUtc.",
      }),
    ),
    format: Type.Optional(
      stringEnum(["json", "markdown"], {
        description: "Export format for refund-and-return-export.",
      }),
    ),
  },
  { additionalProperties: true },
);

// ── Shared helpers ─────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to call shopify ops tools`);
  }
  return value;
}

function requireExplicitDateRange(
  _action: (typeof DATE_RANGE_ACTIONS)[number],
  params: Record<string, unknown>,
): void {
  readStringParam(params, "startDate", { required: true });
  readStringParam(params, "endDate", { required: true });
}

function requirePairedUtcWindow(
  action: "refund-and-return-worker" | "refund-and-return-export",
  params: Record<string, unknown>,
): void {
  const hasStart =
    typeof params.windowStartUtc === "string" && params.windowStartUtc.trim().length > 0;
  const hasEnd = typeof params.windowEndUtc === "string" && params.windowEndUtc.trim().length > 0;
  if (hasStart !== hasEnd) {
    throw new Error(
      `${action} requires windowStartUtc and windowEndUtc together when using an explicit window`,
    );
  }
}

function validateShopifyOpsParams(
  action: (typeof SHOPIFY_OPS_ACTIONS)[number],
  params: Record<string, unknown>,
): void {
  switch (action) {
    case "sales-analytics":
    case "chatbot-metrics":
    case "chatbot-escalation-metrics":
    case "fulfillment-velocity":
      requireExplicitDateRange(action, params);
      return;
    case "refund-and-return-worker":
    case "refund-and-return-export":
      requirePairedUtcWindow(action, params);
      return;
    case "search-orders":
      readStringParam(params, "query", { required: true });
      return;
    default:
      return;
  }
}

export async function handleShopifyOpsAction(
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  validateShopifyOpsParams(action as (typeof SHOPIFY_OPS_ACTIONS)[number], params);
  const installationId = requireEnv("INSTALLATION_ID");
  const baseUrl = requireEnv("OPS_MANAGER_URL");
  const secret = requireEnv("OPS_SIGNING_SECRET");

  const { action: _ignored, ...rest } = params;
  const payload = { action, ...rest };
  const body = JSON.stringify(payload);

  const ts = Date.now().toString();
  const nonce = crypto.randomUUID();
  // Sign the exact JSON body string to match ops-manager verification.
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${nonce}.${body}`)
    .digest("hex");

  const endpoint = `${baseUrl.replace(/\/+$/g, "")}/api/agent/v1/metrics`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ops-installation-id": installationId,
      "x-ops-ts": ts,
      "x-ops-nonce": nonce,
      "x-ops-signature": signature,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ops-manager ${action} failed (${res.status}): ${err}`);
  }

  const text = await res.text();
  if (!text) {
    return jsonResult({ ok: true });
  }
  try {
    return jsonResult(JSON.parse(text) as unknown);
  } catch {
    return jsonResult(text);
  }
}

// ── Executor (shared by both tools) ────────────────────────────────────────

const execute = async (_toolCallId: string, args: unknown) => {
  const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  return await handleShopifyOpsAction(params);
};

// ── Tool factories ─────────────────────────────────────────────────────────

export function createShopifyOpsTools(): AnyAgentTool[] {
  return [
    {
      label: "Store Analytics",
      name: "store_analytics",
      description:
        "Fetch date-ranged Shopify performance metrics: sales-analytics, fulfillment-velocity, chatbot-metrics, chatbot-escalation-metrics. Requires startDate and endDate.",
      parameters: DateRangeSchema,
      execute,
    },
    {
      label: "Store Status",
      name: "store_status",
      description:
        "Fetch current Shopify store state and non-date lookups: inventory-analytics, refund-and-return-worker, refund-and-return-export, search-orders, product-inventory, order-timeline, ops-snapshot. Combined refund-and-return actions optionally accept task, topNRecurringSkus, and paired UTC window timestamps.",
      parameters: NonDateSchema,
      execute,
    },
  ];
}

/** @deprecated Use createShopifyOpsTools() which returns both tools. */
export function createShopifyOpsTool(): AnyAgentTool {
  return createShopifyOpsTools()[0];
}
