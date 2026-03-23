import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../agents/schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "../../agents/tools/common.js";

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";

const META_ADS_ACTIONS = [
  // Read
  "get-ad-accounts",
  "get-campaigns",
  "get-adsets",
  "get-ads",
  "get-creatives",
  "get-insights",
  "get-custom-audiences",
  // Write
  "create-campaign",
  "create-adset",
  "create-creative",
  "create-ad",
  "update-status",
  "update-budget",
  "upload-image",
  "upload-video",
] as const;

const MetaAdsToolSchema = Type.Object(
  {
    action: stringEnum(META_ADS_ACTIONS),
  },
  { additionalProperties: true },
);

function requireMetaAdsToken(): string {
  const token = process.env.META_ADS_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error("META_ADS_ACCESS_TOKEN env var is required to call the meta_ads tool");
  }
  return token;
}

function parseGraphResponse(text: string, method: string, path: string, status: number): unknown {
  if (status < 200 || status >= 300) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) {
        detail = parsed.error.message;
      }
    } catch {
      // use raw text
    }
    throw new Error(`Meta Graph API ${method} ${path} failed (${status}): ${detail}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function graphGet(
  path: string,
  token: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  url.searchParams.set("access_token", token);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) {
        url.searchParams.set(k, v);
      }
    }
  }
  const res = await fetch(url.toString(), { method: "GET" });
  const text = await res.text();
  return parseGraphResponse(text, "GET", path, res.status);
}

async function graphPost(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(`${GRAPH_API_BASE}${path}`);
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return parseGraphResponse(text, "POST", path, res.status);
}

function readJsonParam(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const val = params[key];
  if (val === undefined || val === null) {
    return undefined;
  }
  if (typeof val === "object") {
    return val as Record<string, unknown>;
  }
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not valid JSON
    }
  }
  return undefined;
}

async function handleMetaAdsAction(params: Record<string, unknown>): Promise<unknown> {
  const action = readStringParam(params, "action", { required: true });
  const token = requireMetaAdsToken();

  switch (action) {
    // ── Read actions ──────────────────────────────────────────────

    case "get-ad-accounts": {
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");
      const qp: Record<string, string> = {
        fields: "id,name,account_status,currency,timezone_name,amount_spent",
      };
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      return graphGet("/me/adaccounts", token, qp);
    }

    case "get-campaigns": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");
      const statusFilter = readStringParam(params, "status_filter");
      const qp: Record<string, string> = {
        fields:
          "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,buying_type",
      };
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      if (statusFilter) {
        qp.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: [statusFilter] },
        ]);
      }
      return graphGet(`/${accountId}/campaigns`, token, qp);
    }

    case "get-adsets": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const campaignId = readStringParam(params, "campaign_id");
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");
      const qp: Record<string, string> = {
        fields:
          "id,name,status,daily_budget,lifetime_budget,targeting,optimization_goal,bid_strategy,start_time,end_time",
      };
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      if (campaignId) {
        qp.filtering = JSON.stringify([
          { field: "campaign_id", operator: "EQUAL", value: campaignId },
        ]);
      }
      const parent = campaignId || accountId;
      return graphGet(`/${parent}/adsets`, token, qp);
    }

    case "get-ads": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");
      const qp: Record<string, string> = {
        fields: "id,name,status,creative,adset_id,campaign_id",
      };
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      const adsResult = (await graphGet(`/${accountId}/ads`, token, qp)) as {
        data?: Array<Record<string, unknown>>;
        paging?: unknown;
      };
      const ads = Array.isArray(adsResult?.data) ? adsResult.data : [];
      const creativeIds = Array.from(
        new Set(
          ads
            .map((ad) => {
              const creative = ad.creative;
              if (!creative || typeof creative !== "object") {
                return null;
              }
              const creativeId = (creative as { id?: unknown }).id;
              return typeof creativeId === "string" ? creativeId : null;
            })
            .filter((id): id is string => Boolean(id)),
        ),
      );

      if (creativeIds.length === 0) {
        return adsResult;
      }

      const creativeEntries = await Promise.all(
        creativeIds.map(async (creativeId) => {
          const creative = await graphGet(`/${creativeId}`, token, {
            fields:
              "id,name,title,body,image_url,thumbnail_url,object_story_spec,call_to_action_type",
          });
          return [creativeId, creative] as const;
        }),
      );
      const creativesById = new Map(creativeEntries);

      return {
        ...adsResult,
        data: ads.map((ad) => {
          const creative = ad.creative;
          if (!creative || typeof creative !== "object") {
            return ad;
          }
          const rawCreativeId = (creative as { id?: unknown }).id;
          const creativeId = typeof rawCreativeId === "string" ? rawCreativeId : "";
          if (!creativeId) {
            return ad;
          }
          return {
            ...ad,
            creative: creativesById.get(creativeId) ?? creative,
          };
        }),
      };
    }

    case "get-creatives": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");
      const qp: Record<string, string> = {
        fields: "id,name,title,body,image_url,thumbnail_url,object_story_spec,call_to_action_type",
      };
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      return graphGet(`/${accountId}/adcreatives`, token, qp);
    }

    case "get-insights": {
      const objectId = readStringParam(params, "object_id", { required: true });
      const datePreset = readStringParam(params, "date_preset");
      const timeRangeStart = readStringParam(params, "time_range_start");
      const timeRangeEnd = readStringParam(params, "time_range_end");
      const level = readStringParam(params, "level");
      const breakdowns = readStringParam(params, "breakdowns");
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");

      const qp: Record<string, string> = {
        fields:
          "spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,conversions,cost_per_conversion",
      };
      if (datePreset) {
        qp.date_preset = datePreset;
      } else if (timeRangeStart && timeRangeEnd) {
        qp.time_range = JSON.stringify({ since: timeRangeStart, until: timeRangeEnd });
      } else {
        qp.date_preset = "last_30d";
      }
      if (level) {
        qp.level = level;
      }
      if (breakdowns) {
        qp.breakdowns = breakdowns;
      }
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      return graphGet(`/${objectId}/insights`, token, qp);
    }

    case "get-custom-audiences": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const after = readStringParam(params, "after");
      const qp: Record<string, string> = {
        fields: "id,name,approximate_count,subtype,delivery_status,description",
      };
      if (limit) {
        qp.limit = String(limit);
      }
      if (after) {
        qp.after = after;
      }
      return graphGet(`/${accountId}/customaudiences`, token, qp);
    }

    // ── Write actions ─────────────────────────────────────────────

    case "create-campaign": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const objective = readStringParam(params, "objective", { required: true });
      const status = readStringParam(params, "status") || "PAUSED";
      const dailyBudget = readNumberParam(params, "daily_budget", { integer: true });
      const lifetimeBudget = readNumberParam(params, "lifetime_budget", { integer: true });
      const specialAdCategories = params.special_ad_categories;
      const buyingType = readStringParam(params, "buying_type");

      const body: Record<string, unknown> = {
        name,
        objective,
        status,
        special_ad_categories: Array.isArray(specialAdCategories) ? specialAdCategories : [],
      };
      if (dailyBudget) {
        body.daily_budget = dailyBudget;
      }
      if (lifetimeBudget) {
        body.lifetime_budget = lifetimeBudget;
      }
      if (buyingType) {
        body.buying_type = buyingType;
      }
      return graphPost(`/${accountId}/campaigns`, token, body);
    }

    case "create-adset": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const campaignId = readStringParam(params, "campaign_id", { required: true });
      const status = readStringParam(params, "status") || "PAUSED";
      const dailyBudget = readNumberParam(params, "daily_budget", { integer: true });
      const lifetimeBudget = readNumberParam(params, "lifetime_budget", { integer: true });
      const optimizationGoal = readStringParam(params, "optimization_goal", { required: true });
      const billingEvent = readStringParam(params, "billing_event") || "IMPRESSIONS";
      const bidStrategy = readStringParam(params, "bid_strategy");
      const targeting = readJsonParam(params, "targeting");
      const startTime = readStringParam(params, "start_time");
      const endTime = readStringParam(params, "end_time");
      const promotedObject = readJsonParam(params, "promoted_object");

      const body: Record<string, unknown> = {
        name,
        campaign_id: campaignId,
        status,
        optimization_goal: optimizationGoal,
        billing_event: billingEvent,
      };
      if (dailyBudget) {
        body.daily_budget = dailyBudget;
      }
      if (lifetimeBudget) {
        body.lifetime_budget = lifetimeBudget;
      }
      if (bidStrategy) {
        body.bid_strategy = bidStrategy;
      }
      if (targeting) {
        body.targeting = targeting;
      }
      if (startTime) {
        body.start_time = startTime;
      }
      if (endTime) {
        body.end_time = endTime;
      }
      if (promotedObject) {
        body.promoted_object = promotedObject;
      }
      return graphPost(`/${accountId}/adsets`, token, body);
    }

    case "create-creative": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const objectStorySpec = readJsonParam(params, "object_story_spec");
      const assetFeedSpec = readJsonParam(params, "asset_feed_spec");

      if (!objectStorySpec && !assetFeedSpec) {
        throw new Error("create-creative requires object_story_spec or asset_feed_spec");
      }
      const body: Record<string, unknown> = { name };
      if (objectStorySpec) {
        body.object_story_spec = objectStorySpec;
      }
      if (assetFeedSpec) {
        body.asset_feed_spec = assetFeedSpec;
      }
      return graphPost(`/${accountId}/adcreatives`, token, body);
    }

    case "create-ad": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const adsetId = readStringParam(params, "adset_id", { required: true });
      const creativeId = readStringParam(params, "creative_id", { required: true });
      const status = readStringParam(params, "status") || "PAUSED";

      return graphPost(`/${accountId}/ads`, token, {
        name,
        adset_id: adsetId,
        creative: { creative_id: creativeId },
        status,
      });
    }

    case "update-status": {
      const objectId = readStringParam(params, "object_id", { required: true });
      const status = readStringParam(params, "status", { required: true });
      return graphPost(`/${objectId}`, token, { status });
    }

    case "update-budget": {
      const objectId = readStringParam(params, "object_id", { required: true });
      const dailyBudget = readNumberParam(params, "daily_budget", { integer: true });
      const lifetimeBudget = readNumberParam(params, "lifetime_budget", { integer: true });
      if (!dailyBudget && !lifetimeBudget) {
        throw new Error("update-budget requires daily_budget or lifetime_budget (in cents)");
      }
      const body: Record<string, unknown> = {};
      if (dailyBudget) {
        body.daily_budget = dailyBudget;
      }
      if (lifetimeBudget) {
        body.lifetime_budget = lifetimeBudget;
      }
      return graphPost(`/${objectId}`, token, body);
    }

    case "upload-image": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const imageUrl = readStringParam(params, "url", { required: true });
      return graphPost(`/${accountId}/adimages`, token, { url: imageUrl });
    }

    case "upload-video": {
      const accountId = readStringParam(params, "account_id", { required: true });
      const fileUrl = readStringParam(params, "file_url", { required: true });
      return graphPost(`/${accountId}/advideos`, token, { file_url: fileUrl });
    }

    default:
      throw new Error(`Unknown meta_ads action: ${action}`);
  }
}

export function createMetaAdsTool(): AnyAgentTool {
  return {
    label: "Meta Ads",
    name: "meta_ads",
    description: [
      "Manage Meta (Facebook/Instagram) Ads via the Graph API. Supports both read and write operations.",
      "",
      "Read actions:",
      "  get-ad-accounts — list ad accounts accessible by the token (params: limit, after)",
      "  get-campaigns — list campaigns (params: account_id, status_filter, limit, after). status_filter: ACTIVE, PAUSED, etc.",
      "  get-adsets — list ad sets (params: account_id, campaign_id, limit, after)",
      "  get-ads — list ads with creative details (params: account_id, limit, after)",
      "  get-creatives — list ad creatives (params: account_id, limit, after)",
      "  get-insights — performance metrics (params: object_id, date_preset, time_range_start, time_range_end, level, breakdowns, limit, after)",
      "    object_id: ad account, campaign, adset, or ad ID.",
      "    date_preset: today, yesterday, last_7d, last_14d, last_30d, last_90d, this_month, last_month.",
      "    Or pass time_range_start/time_range_end as YYYY-MM-DD.",
      "    level: account, campaign, adset, ad. breakdowns: age, gender, country, placement, device_platform.",
      "  get-custom-audiences — list custom audiences (params: account_id, limit, after)",
      "",
      "Write actions:",
      "  create-campaign — create a campaign (params: account_id, name, objective, status, daily_budget, lifetime_budget, special_ad_categories, buying_type).",
      "    objective: OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_TRAFFIC, OUTCOME_APP_PROMOTION.",
      "    status defaults to PAUSED. Budgets are in cents (e.g. 5000 = $50.00).",
      "  create-adset — create an ad set (params: account_id, name, campaign_id, optimization_goal, billing_event, status, daily_budget, lifetime_budget, bid_strategy, targeting, start_time, end_time, promoted_object).",
      '    targeting is a JSON object, e.g. {"geo_locations":{"countries":["US"]},"age_min":25,"age_max":55}.',
      "  create-creative — create an ad creative (params: account_id, name, object_story_spec or asset_feed_spec).",
      '    object_story_spec example: {"page_id":"PAGE_ID","link_data":{"link":"https://...","message":"Ad copy","image_hash":"HASH"}}.',
      "  create-ad — create an ad (params: account_id, name, adset_id, creative_id, status). Status defaults to PAUSED.",
      "  update-status — pause or activate any object (params: object_id, status). status: ACTIVE or PAUSED.",
      "  update-budget — change budget on a campaign or adset (params: object_id, daily_budget, lifetime_budget). Budgets in cents.",
      "  upload-image — upload an ad image by URL, returns image_hash (params: account_id, url)",
      "  upload-video — upload an ad video by URL, returns video_id (params: account_id, file_url)",
      "",
      "Ad account IDs use the format act_123456789. New campaigns/ads default to PAUSED for safety.",
    ].join("\n"),
    parameters: MetaAdsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      return jsonResult(await handleMetaAdsAction(params));
    },
  };
}
