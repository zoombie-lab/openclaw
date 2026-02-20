import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { detectMime } from "../media/mime.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

async function sniffMimeFromBase64(base64: string): Promise<string | undefined> {
  const trimmed = base64.trim();
  if (!trimmed) {
    return undefined;
  }

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) {
    return undefined;
  }

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return await detectMime({ buffer: head });
  } catch {
    return undefined;
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) {
    return result;
  }

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) {
    return result;
  }

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) {
    return result;
  }

  const nextContent = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

function resolveReadPath(filePath: string, rootDir?: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(rootDir ?? process.cwd(), filePath);
}

async function maybeDirectoryListingResult(params: {
  filePath: string;
  rootDir?: string;
}): Promise<AgentToolResult<unknown> | undefined> {
  const resolvedPath = resolveReadPath(params.filePath, params.rootDir);
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(resolvedPath);
  } catch {
    return undefined;
  }
  if (!stats.isDirectory()) {
    return undefined;
  }

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.map((entry) => {
    if (entry.isDirectory()) {
      return `- ${entry.name}/`;
    }
    if (entry.isSymbolicLink()) {
      return `- ${entry.name}@`;
    }
    return `- ${entry.name}`;
  });
  const body = lines.length > 0 ? lines.join("\n") : "(empty directory)";
  return {
    content: [
      {
        type: "text",
        text: `Directory listing for ${params.filePath}\n${body}`,
      },
    ],
    details: {
      path: params.filePath,
      resolvedPath,
      entries: entries.map((entry) => entry.name),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasDirectToolKeys(record: Record<string, unknown>): boolean {
  const keys = [
    "path",
    "file_path",
    "filePath",
    "filepath",
    "file",
    "filename",
    "directory",
    "dir",
    "target_path",
    "targetPath",
    "content",
    "oldText",
    "old_string",
    "newText",
    "new_string",
  ];
  return keys.some((key) => key in record);
}

function unwrapToolParams(params: unknown): Record<string, unknown> | undefined {
  if (typeof params === "string") {
    return { path: params };
  }
  const initial = asRecord(params);
  if (!initial) {
    return undefined;
  }
  let record: Record<string, unknown> = initial;
  for (let depth = 0; depth < 3; depth += 1) {
    if (hasDirectToolKeys(record)) {
      break;
    }
    const nestedCandidates: unknown[] = [
      record.input,
      record.arguments,
      record.args,
      record.params,
      record.payload,
      record.toolInput,
    ];
    const nested = nestedCandidates
      .map((candidate) => asRecord(candidate))
      .find((candidate): candidate is Record<string, unknown> => candidate !== undefined);
    if (!nested) {
      break;
    }
    record = nested;
  }
  return { ...record };
}

function applyFirstAlias(params: Record<string, unknown>, target: string, aliases: string[]) {
  if (typeof params[target] === "string" && params[target].trim()) {
    for (const alias of aliases) {
      if (alias !== target) {
        delete params[alias];
      }
    }
    return;
  }
  for (const alias of aliases) {
    const value = params[alias];
    if (typeof value === "string" && value.trim()) {
      params[target] = value;
      for (const cleanupKey of aliases) {
        if (cleanupKey !== target) {
          delete params[cleanupKey];
        }
      }
      return;
    }
  }
}

type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
};

export const CLAUDE_PARAM_GROUPS = {
  read: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  write: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  edit: [
    { keys: ["path", "file_path"], label: "path (path or file_path)" },
    {
      keys: ["oldText", "old_string"],
      label: "oldText (oldText or old_string)",
    },
    {
      keys: ["newText", "new_string"],
      label: "newText (newText or new_string)",
    },
  ],
} as const;

// Normalize tool parameters from Claude Code conventions to pi-coding-agent conventions.
// Claude Code uses file_path/old_string/new_string while pi-coding-agent uses path/oldText/newText.
// This prevents models trained on Claude Code from getting stuck in tool-call loops.
export function normalizeToolParams(params: unknown): Record<string, unknown> | undefined {
  const normalized = unwrapToolParams(params);
  if (!normalized) {
    return undefined;
  }
  applyFirstAlias(normalized, "path", [
    "file_path",
    "filePath",
    "filepath",
    "file",
    "filename",
    "directory",
    "dir",
    "target_path",
    "targetPath",
    "target_file",
    "targetFile",
  ]);
  applyFirstAlias(normalized, "oldText", [
    "old_string",
    "oldString",
    "old_text",
    "old",
    "from",
    "find",
    "search",
    "searchText",
  ]);
  applyFirstAlias(normalized, "newText", [
    "new_string",
    "newString",
    "new_text",
    "new",
    "to",
    "replace",
    "replacement",
    "replacementText",
    "replaceWith",
  ]);
  return normalized;
}

export function patchToolSchemaForClaudeCompatibility(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;

  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    return tool;
  }

  const properties = { ...(schema.properties as Record<string, unknown>) };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  let changed = false;

  const aliasPairs: Array<{ original: string; alias: string }> = [
    { original: "path", alias: "file_path" },
    { original: "oldText", alias: "old_string" },
    { original: "newText", alias: "new_string" },
  ];

  for (const { original, alias } of aliasPairs) {
    if (!(original in properties)) {
      continue;
    }
    if (!(alias in properties)) {
      properties[alias] = properties[original];
      changed = true;
    }
    const idx = required.indexOf(original);
    if (idx !== -1) {
      required.splice(idx, 1);
      changed = true;
    }
  }

  if (!changed) {
    return tool;
  }

  return {
    ...tool,
    parameters: {
      ...schema,
      properties,
      required,
    },
  };
}

export function assertRequiredParams(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
  toolName: string,
): void {
  if (!record || typeof record !== "object") {
    throw new Error(`Missing parameters for ${toolName}`);
  }

  for (const group of groups) {
    const satisfied = group.keys.some((key) => {
      if (!(key in record)) {
        return false;
      }
      const value = record[key];
      if (typeof value !== "string") {
        return false;
      }
      if (group.allowEmpty) {
        return true;
      }
      return value.trim().length > 0;
    });

    if (!satisfied) {
      const label = group.label ?? group.keys.join(" or ");
      throw new Error(`Missing required parameter: ${label}`);
    }
  }
}

// Generic wrapper to normalize parameters for any tool
export function wrapToolParamNormalization(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(tool);
  return {
    ...patched,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      if (requiredParamGroups?.length) {
        assertRequiredParams(record, requiredParamGroups, tool.name);
      }
      return tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
    },
  };
}

function wrapSandboxPathGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        await assertSandboxPath({ filePath, cwd: root, root });
      }
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

export function createSandboxedReadTool(root: string) {
  const base = createReadTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(createOpenClawReadTool(base, root), root);
}

export function createSandboxedWriteTool(root: string) {
  const base = createWriteTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write), root);
}

export function createSandboxedEditTool(root: string) {
  const base = createEditTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit), root);
}

export function createOpenClawReadTool(base: AnyAgentTool, rootDir?: string): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(base);
  return {
    ...patched,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
      const filePath = typeof record?.path === "string" ? record.path.trim() : "";
      const dirListing = filePath
        ? await maybeDirectoryListingResult({ filePath, rootDir })
        : undefined;
      if (dirListing) {
        return dirListing;
      }
      const result = await base.execute(toolCallId, normalized ?? params, signal);
      const resultPath = filePath || "<unknown>";
      const normalizedResult = await normalizeReadImageResult(result, filePath);
      return sanitizeToolResultImages(normalizedResult, `read:${resultPath}`);
    },
  };
}
