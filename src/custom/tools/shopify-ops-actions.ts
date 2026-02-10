import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import { stringEnum } from "../../agents/schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../../agents/tools/common.js";

const SHOPIFY_OPS_ACTIONS = [
  "sales-analytics",
  "search-orders",
  "inventory-analytics",
  "product-inventory",
  "fulfillment-velocity",
  "order-timeline",
  "refunds-metrics",
  "returns-metrics",
  "ops-snapshot",
] as const;

const ShopifyOpsToolSchema = Type.Object(
  {
    action: stringEnum(SHOPIFY_OPS_ACTIONS),
  },
  { additionalProperties: true },
);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to call shopify_ops`);
  }
  return value;
}

export async function handleShopifyOpsAction(
  params: Record<string, unknown>,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
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
  if (!text) return jsonResult({ ok: true });
  try {
    return jsonResult(JSON.parse(text) as unknown);
  } catch {
    return jsonResult(text);
  }
}

export function createShopifyOpsTool(): AnyAgentTool {
  return {
    label: "Shopify Ops",
    name: "shopify_ops",
    description:
      "Fetch Shopify metrics from ops-manager via signed requests. Pass an action plus its parameters (sales-analytics, inventory-analytics, fulfillment-velocity, refunds-metrics, returns-metrics, search-orders, product-inventory, order-timeline, ops-snapshot).",
    parameters: ShopifyOpsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      return await handleShopifyOpsAction(params);
    },
  };
}
