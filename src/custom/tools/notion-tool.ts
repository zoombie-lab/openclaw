import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../agents/schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "../../agents/tools/common.js";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const NOTION_ACTIONS = [
  "search",
  "get-page",
  "get-page-content",
  "get-database",
  "query-database",
  "create-page",
  "update-page",
  "append-blocks",
] as const;

const NotionToolSchema = Type.Object(
  {
    action: stringEnum(NOTION_ACTIONS),
  },
  { additionalProperties: true },
);

function requireNotionToken(): string {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) {
    throw new Error("NOTION_TOKEN env var is required to call the notion tool");
  }
  return token;
}

function notionHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function notionFetch(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${NOTION_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: notionHeaders(token, !!body),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) {
        detail = parsed.message;
      }
    } catch {
      // use raw text
    }
    throw new Error(`Notion API ${method} ${path} failed (${res.status}): ${detail}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function handleNotionAction(params: Record<string, unknown>): Promise<unknown> {
  const action = readStringParam(params, "action", { required: true });
  const token = requireNotionToken();

  switch (action) {
    case "search": {
      const body: Record<string, unknown> = {};
      if (params.query) {
        body.query = params.query;
      }
      if (params.filter) {
        body.filter = params.filter;
      }
      if (params.sort) {
        body.sort = params.sort;
      }
      if (params.start_cursor) {
        body.start_cursor = params.start_cursor;
      }
      if (params.page_size) {
        body.page_size = params.page_size;
      }
      return notionFetch("POST", "/search", token, body);
    }

    case "get-page": {
      const pageId = readStringParam(params, "page_id", { required: true });
      return notionFetch("GET", `/pages/${pageId}`, token);
    }

    case "get-page-content": {
      const blockId = readStringParam(params, "block_id", { required: true });
      let path = `/blocks/${blockId}/children`;
      const queryParts: string[] = [];
      const startCursor = readStringParam(params, "start_cursor");
      if (startCursor) {
        queryParts.push(`start_cursor=${encodeURIComponent(startCursor)}`);
      }
      const pageSize = readNumberParam(params, "page_size", { integer: true });
      if (pageSize !== undefined) {
        queryParts.push(`page_size=${pageSize}`);
      }
      if (queryParts.length > 0) {
        path += `?${queryParts.join("&")}`;
      }
      return notionFetch("GET", path, token);
    }

    case "get-database": {
      const dbId = readStringParam(params, "database_id", { required: true });
      return notionFetch("GET", `/databases/${dbId}`, token);
    }

    case "query-database": {
      const dbId = readStringParam(params, "database_id", { required: true });
      const body: Record<string, unknown> = {};
      if (params.filter) {
        body.filter = params.filter;
      }
      if (params.sorts) {
        body.sorts = params.sorts;
      }
      if (params.start_cursor) {
        body.start_cursor = params.start_cursor;
      }
      if (params.page_size) {
        body.page_size = params.page_size;
      }
      return notionFetch("POST", `/databases/${dbId}/query`, token, body);
    }

    case "create-page": {
      if (!params.parent) {
        throw new Error("create-page requires a parent object");
      }
      if (!params.properties) {
        throw new Error("create-page requires a properties object");
      }
      const body: Record<string, unknown> = {
        parent: params.parent,
        properties: params.properties,
      };
      if (params.children) {
        body.children = params.children;
      }
      if (params.icon) {
        body.icon = params.icon;
      }
      if (params.cover) {
        body.cover = params.cover;
      }
      return notionFetch("POST", "/pages", token, body);
    }

    case "update-page": {
      const pageId = readStringParam(params, "page_id", { required: true });
      const body: Record<string, unknown> = {};
      if (params.properties) {
        body.properties = params.properties;
      }
      if (params.icon) {
        body.icon = params.icon;
      }
      if (params.cover) {
        body.cover = params.cover;
      }
      if (typeof params.in_trash === "boolean") {
        body.in_trash = params.in_trash;
      }
      if (typeof params.is_archived === "boolean") {
        body.is_archived = params.is_archived;
      }
      return notionFetch("PATCH", `/pages/${pageId}`, token, body);
    }

    case "append-blocks": {
      const blockId = readStringParam(params, "block_id", { required: true });
      if (!params.children) {
        throw new Error("append-blocks requires a children array");
      }
      const body: Record<string, unknown> = { children: params.children };
      if (params.position) {
        body.position = params.position;
      }
      return notionFetch("PATCH", `/blocks/${blockId}/children`, token, body);
    }

    default:
      throw new Error(`Unknown notion action: ${action}`);
  }
}

export function createNotionTool(): AnyAgentTool {
  return {
    label: "Notion",
    name: "notion",
    description: [
      "Read and write Notion pages and databases via the Notion API.",
      "Actions:",
      "  search — search pages/databases by title (params: query, filter, sort, start_cursor, page_size)",
      "  get-page — retrieve a page's properties (params: page_id)",
      "  get-page-content — retrieve a page's block content (params: block_id, start_cursor, page_size). Use the page ID as block_id.",
      "  get-database — retrieve a database schema (params: database_id)",
      "  query-database — query database rows with optional filters and sorts (params: database_id, filter, sorts, start_cursor, page_size)",
      "  create-page — create a new page in a database or under a page (params: parent, properties, children, icon, cover)",
      "  update-page — update a page's properties (params: page_id, properties, icon, cover, in_trash, is_archived)",
      "  append-blocks — append content blocks to a page or block (params: block_id, children, position)",
      "The integration can only access pages that have been explicitly shared with it in Notion.",
    ].join("\n"),
    parameters: NotionToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      return jsonResult(await handleNotionAction(params));
    },
  };
}
