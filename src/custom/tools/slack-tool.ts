import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { FilesUploadV2Arguments } from "@slack/web-api";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { assertSandboxPath } from "../../agents/sandbox-paths.js";
import { stringEnum } from "../../agents/schema/typebox.js";
import { jsonResult, readNumberParam, readStringParam } from "../../agents/tools/common.js";
import { loadConfig } from "../../config/config.js";
import { getMediaDir } from "../../media/store.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import { downloadSlackFile, readSlackMessages, getSlackMemberInfo } from "../../slack/actions.js";
import { createSlackWebClient } from "../../slack/client.js";
import { parseSlackTarget } from "../../slack/targets.js";
import { resolveSlackBotToken } from "../../slack/token.js";

type SlackToolOptions = {
  config?: OpenClawConfig;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  sandboxRoot?: string;
  workspaceDir?: string;
};

const SLACK_TOOL_ACTIONS = [
  "read",
  "user-info",
  "download-file",
  "upload-file",
  "schedule-message",
  "table",
  "canvas",
  "remote-file-share",
] as const;

const SlackToolSchema = Type.Object({
  action: stringEnum(SLACK_TOOL_ACTIONS, { description: "Slack action to perform." }),

  accountId: Type.Optional(
    Type.String({ description: "Slack account id override (multi-account)." }),
  ),

  // read
  channelId: Type.Optional(
    Type.String({
      description:
        "Slack channel id to read from. Defaults to the current Slack channel when invoked from Slack.",
    }),
  ),
  threadTs: Type.Optional(
    Type.String({
      description:
        "Slack thread timestamp (thread_ts). Defaults to the current thread only when channelId is also omitted.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        "Max messages to fetch (recommended: 10). Use pagination fields to fetch more if needed.",
    }),
  ),
  before: Type.Optional(Type.String({ description: "Fetch messages older than this ts." })),
  after: Type.Optional(Type.String({ description: "Fetch messages newer than this ts." })),

  // user-info
  userId: Type.Optional(Type.String({ description: "Slack user id (U...)." })),

  // download-file
  fileId: Type.Optional(
    Type.String({
      description: "Slack file id (F...). The tool fetches fresh metadata before downloading.",
    }),
  ),
  maxBytes: Type.Optional(
    Type.Number({ description: "Max bytes to download (defaults to Slack mediaMaxMb or 10MB)." }),
  ),

  // schedule-message
  text: Type.Optional(Type.String({ description: "Message text for schedule-message." })),
  postAt: Type.Optional(
    Type.Number({
      description:
        "Unix timestamp (seconds) for when the message should be posted. Max 120 days in the future.",
    }),
  ),

  // table — rows of data sent as a Block Kit table block via chat.postMessage
  rows: Type.Optional(
    Type.Array(Type.Array(Type.String()), {
      description: "2-D array of cell strings. First row is the header. Max 100 rows, 20 columns.",
    }),
  ),
  columnAligns: Type.Optional(
    Type.Array(Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")]), {
      description: 'Per-column alignment. Defaults to "left".',
    }),
  ),

  // canvas — creates a Slack canvas with markdown content
  title: Type.Optional(Type.String({ description: "Title for canvas or list." })),
  markdown: Type.Optional(
    Type.String({
      description:
        "Markdown content for canvas. Supports bold, italic, headings h1-h3, tables, code blocks, checklists, links, @mentions, bulleted/ordered lists, quotes.",
    }),
  ),

  // remote-file-share — register + share an external file
  externalId: Type.Optional(
    Type.String({ description: "Unique ID for the remote file (your own GUID)." }),
  ),
  externalUrl: Type.Optional(Type.String({ description: "URL of the remote file." })),
  previewImage: Type.Optional(
    Type.String({ description: "Base64 PNG/JPG preview image (min 800x400). Optional." }),
  ),

  // upload-file
  to: Type.Optional(
    Type.String({
      description:
        'Upload destination: "channel:C123" or "user:U123". (For DMs we open a DM channel.)',
    }),
  ),
  buffer: Type.Optional(
    Type.String({
      description: "Base64 payload for upload (optionally a data: URL).",
    }),
  ),
  filename: Type.Optional(Type.String({ description: "Filename for upload." })),
  caption: Type.Optional(Type.String({ description: "Optional initial comment." })),
  uploadThreadTs: Type.Optional(
    Type.String({ description: "Optional thread_ts to upload into a thread." }),
  ),
});

function normalizeBase64Payload(raw?: string | null): { base64: string } {
  const value = (raw ?? "").trim();
  if (!value) {
    return { base64: "" };
  }
  // data:<mime>;base64,<payload>
  const m = value.match(/^data:([^;]+);base64,(.+)$/i);
  if (m) {
    return { base64: m[2] ?? "" };
  }
  return { base64: value };
}

function resolveSlackTokenAndAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { token: string; accountId: string } {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = resolveSlackBotToken(account.botToken ?? undefined);
  if (!token) {
    throw new Error("Slack bot token missing (set SLACK_BOT_TOKEN or channels.slack.botToken).");
  }
  return { token, accountId: account.accountId };
}

async function resolveSlackUploadChannelId(params: {
  client: ReturnType<typeof createSlackWebClient>;
  to: string;
}): Promise<string> {
  const parsed = parseSlackTarget(params.to, { defaultKind: "channel" });
  if (!parsed) {
    throw new Error('Missing/invalid "to" (expected channel:C... or user:U...)');
  }
  if (parsed.kind === "channel") {
    return parsed.id;
  }
  const opened = await params.client.conversations.open({ users: parsed.id });
  const channelId = opened.channel?.id;
  if (!channelId) {
    throw new Error("Failed to open DM channel for upload");
  }
  return channelId;
}

async function stageDownloadedMediaIntoWorkspace(params: {
  sourcePath: string;
  sandboxRoot?: string;
  workspaceDir?: string;
}): Promise<{ absolutePath: string; displayPath: string } | null> {
  // Canonical rule for manipulated Slack media: once we have agent workspace context,
  // stage into workspace-local media/inbound/... and return that path shape to the model.
  const root = params.sandboxRoot?.trim() || params.workspaceDir?.trim();
  if (!root) {
    return null;
  }

  const mediaDir = path.resolve(getMediaDir());
  const source = await assertSandboxPath({
    filePath: params.sourcePath,
    cwd: mediaDir,
    root: mediaDir,
  });
  const fileName = path.basename(source.resolved);
  if (!fileName) {
    return null;
  }

  const inboundDir = path.join(root, "media", "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  let finalName = fileName;
  let dest = path.join(inboundDir, finalName);
  const parsed = path.parse(fileName);
  let suffix = 1;
  while (true) {
    try {
      await fs.access(dest);
      finalName = `${parsed.name}-${suffix}${parsed.ext}`;
      dest = path.join(inboundDir, finalName);
      suffix += 1;
    } catch {
      break;
    }
  }
  await fs.copyFile(source.resolved, dest);

  return {
    absolutePath: dest,
    displayPath: path.posix.join("media", "inbound", finalName),
  };
}

export function createSlackTool(options?: SlackToolOptions): AnyAgentTool {
  return {
    label: "Slack",
    name: "slack",
    description:
      "Slack utilities: read messages, file upload/download, schedule messages, and rich presentation.\n" +
      "Presentation actions — pick the right format for the content:\n" +
      "- table: Inline tabular data for quick viewing (max 100 rows, 20 cols). Best for small result sets, snapshots, comparisons.\n" +
      "- canvas: Rich documents with markdown — reports, summaries, supplier sheets with notes/links/images. Best default for anything longer than a table.\n" +
      "- list: Operational items the merchant tracks and acts on (tasks, orders to review, restock queue). Rows are interactive — assignable, filterable, checkable.\n" +
      "- remote-file-share: Share externally hosted docs with a custom preview image when native Slack rendering is weak.\n" +
      "Scheduling:\n" +
      "- schedule-message: For reminders, follow-ups, timed notifications — 'say X at time Y'.\n" +
      "- Use cron instead when the task requires performing an action (fetching data, generating a report) — 'do X then report at time Y'.",
    parameters: SlackToolSchema,
    execute: async (_toolCallId, args): Promise<AgentToolResult<unknown>> => {
      const cfg = options?.config ?? loadConfig();
      const params = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const action = readStringParam(params, "action", { required: true });
      const accountId =
        readStringParam(params, "accountId") ?? options?.agentAccountId ?? undefined;

      if (action === "read") {
        const explicitChannelId = readStringParam(params, "channelId");
        const channelId = explicitChannelId ?? options?.currentChannelId ?? undefined;
        if (!channelId) {
          throw new Error(
            'Missing "channelId" (this tool defaults it only when invoked from Slack).',
          );
        }
        const explicitThreadTs = readStringParam(params, "threadTs");
        const threadTs =
          explicitThreadTs ??
          (explicitChannelId ? undefined : (options?.currentThreadTs ?? undefined));
        const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;
        const before = readStringParam(params, "before") ?? undefined;
        const after = readStringParam(params, "after") ?? undefined;

        const result = await readSlackMessages(channelId, {
          accountId,
          limit,
          before,
          after,
          threadId: threadTs,
        });
        return jsonResult({
          ok: true,
          messages: result.messages,
          hasMore: result.hasMore,
          note: "If you need more context, call slack.read again with before=<oldest ts you have> or after=<newest ts> and a new limit (e.g. 10).",
        });
      }

      if (action === "user-info") {
        const userId = readStringParam(params, "userId", { required: true });
        const info = await getSlackMemberInfo(userId, { accountId });
        return jsonResult({ ok: true, info });
      }

      if (action === "download-file") {
        const fileId = readStringParam(params, "fileId", { required: true });
        const maxBytes =
          readNumberParam(params, "maxBytes", { integer: true }) ??
          (() => {
            const account = resolveSlackAccount({ cfg, accountId });
            const maxMb = typeof account.mediaMaxMb === "number" ? account.mediaMaxMb : undefined;
            return maxMb ? maxMb * 1024 * 1024 : 10 * 1024 * 1024;
          })();

        const resolved = await downloadSlackFile(fileId, {
          accountId,
          maxBytes,
        });
        if (!resolved) {
          throw new Error("Failed to download Slack file (or file was too large).");
        }
        const staged = await stageDownloadedMediaIntoWorkspace({
          sourcePath: resolved.path,
          sandboxRoot: options?.sandboxRoot,
          workspaceDir: options?.workspaceDir,
        });
        return jsonResult({
          ok: true,
          ...resolved,
          path: staged?.displayPath ?? resolved.path,
          ...(staged ? { absolutePath: staged.absolutePath } : {}),
        });
      }

      if (action === "upload-file") {
        const to = readStringParam(params, "to", { required: true });
        const { token } = resolveSlackTokenAndAccountId({ cfg, accountId });
        const client = createSlackWebClient(token);
        const channelId = await resolveSlackUploadChannelId({ client, to });
        const caption =
          readStringParam(params, "caption", { allowEmpty: true })?.trim() || undefined;
        const threadTs =
          readStringParam(params, "uploadThreadTs") ?? options?.currentThreadTs ?? undefined;

        const normalized = normalizeBase64Payload(
          readStringParam(params, "buffer", { trim: false }),
        );
        const base64 = normalized.base64;
        if (!base64) {
          throw new Error('Missing "buffer" for upload-file (base64 or data: URL).');
        }

        const buffer = Buffer.from(base64, "base64");
        const filename =
          readStringParam(params, "filename") ??
          readStringParam(params, "fileName") ??
          "upload.bin";
        const basePayload = {
          channel_id: channelId,
          file: buffer,
          filename,
          ...(caption ? { initial_comment: caption } : {}),
        };

        const payload: FilesUploadV2Arguments = threadTs
          ? { ...basePayload, thread_ts: threadTs }
          : basePayload;

        const res = await client.files.uploadV2(payload);
        const parsed = res as {
          files?: Array<{ id?: string; name?: string }>;
          file?: { id?: string; name?: string };
        };
        const fileId =
          parsed.files?.[0]?.id ?? parsed.file?.id ?? parsed.files?.[0]?.name ?? parsed.file?.name;

        return jsonResult({ ok: true, fileId, channelId });
      }

      if (action === "schedule-message") {
        const text = readStringParam(params, "text", { required: true });
        const postAt = readNumberParam(params, "postAt", { required: true });
        if (postAt == null) {
          throw new Error('"postAt" is required for schedule-message.');
        }
        const explicitChannelId = readStringParam(params, "channelId");
        const channelId = explicitChannelId ?? options?.currentChannelId ?? undefined;
        if (!channelId) {
          throw new Error(
            'Missing "channelId" for schedule-message (defaults only when invoked from Slack).',
          );
        }
        const threadTs =
          readStringParam(params, "threadTs") ??
          (explicitChannelId ? undefined : (options?.currentThreadTs ?? undefined));

        const { token } = resolveSlackTokenAndAccountId({ cfg, accountId });
        const client = createSlackWebClient(token);
        const res = await client.chat.scheduleMessage({
          channel: channelId,
          text,
          post_at: postAt,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        return jsonResult({
          ok: true,
          scheduledMessageId: res.scheduled_message_id,
          channel: res.channel,
          postAt: res.post_at,
        });
      }

      // ── table ─────────────────────────────────────────────────────────
      if (action === "table") {
        const rows = params.rows as string[][] | undefined;
        if (!rows || !Array.isArray(rows) || rows.length < 2) {
          throw new Error(
            '"rows" must be a 2-D array with at least a header row and one data row.',
          );
        }
        if (rows.length > 100) {
          throw new Error("Table block supports a maximum of 100 rows.");
        }
        const columnCount = rows[0]!.length;
        if (columnCount > 20) {
          throw new Error("Table block supports a maximum of 20 columns.");
        }
        const aligns = (params.columnAligns as string[] | undefined) ?? [];
        const columnSettings = Array.from({ length: columnCount }, (_, i) => ({
          align: (aligns[i] as "left" | "center" | "right") ?? "left",
          is_wrapped: true,
        }));
        const tableRows = rows.map((row) => ({
          cells: row.slice(0, 20).map((cell) => ({
            type: "raw_text" as const,
            text: String(cell ?? ""),
          })),
        }));
        const explicitChannelId = readStringParam(params, "channelId");
        const channelId = explicitChannelId ?? options?.currentChannelId ?? undefined;
        if (!channelId) {
          throw new Error('Missing "channelId" for table (defaults only when invoked from Slack).');
        }
        const threadTs =
          readStringParam(params, "threadTs") ??
          (explicitChannelId ? undefined : (options?.currentThreadTs ?? undefined));
        const caption = readStringParam(params, "caption")?.trim() || undefined;

        const { token } = resolveSlackTokenAndAccountId({ cfg, accountId });
        const client = createSlackWebClient(token);
        const res = await client.chat.postMessage({
          channel: channelId,
          text: caption ?? "Table",
          blocks: [
            {
              type: "table",
              rows: tableRows,
              column_settings: columnSettings,
            } as any,
          ],
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
        return jsonResult({ ok: true, ts: res.ts, channel: res.channel });
      }

      // ── canvas ────────��────────────────────────────────────────���──────
      if (action === "canvas") {
        const markdownContent = readStringParam(params, "markdown", { required: true });
        const title = readStringParam(params, "title") ?? undefined;
        const explicitChannelId = readStringParam(params, "channelId");
        const channelId = explicitChannelId ?? options?.currentChannelId ?? undefined;

        const { token } = resolveSlackTokenAndAccountId({ cfg, accountId });
        const client = createSlackWebClient(token);

        // If a channel is provided, create the canvas as a channel tab.
        // Otherwise create a standalone canvas.
        if (channelId) {
          const res = await client.conversations.canvases.create({
            channel_id: channelId,
            title,
            document_content: { type: "markdown", markdown: markdownContent },
          });
          return jsonResult({ ok: true, canvasId: (res as any).canvas_id });
        }
        const res = await client.canvases.create({
          title,
          document_content: { type: "markdown", markdown: markdownContent },
        });
        return jsonResult({ ok: true, canvasId: (res as any).canvas_id });
      }

      // ── remote-file-share ────────────────────────────��────────────────
      if (action === "remote-file-share") {
        const externalId = readStringParam(params, "externalId", { required: true });
        const externalUrl = readStringParam(params, "externalUrl", { required: true });
        const title =
          readStringParam(params, "title") ?? readStringParam(params, "filename") ?? "Shared file";
        const explicitChannelId = readStringParam(params, "channelId");
        const channelId = explicitChannelId ?? options?.currentChannelId ?? undefined;
        if (!channelId) {
          throw new Error(
            'Missing "channelId" for remote-file-share (defaults only when invoked from Slack).',
          );
        }

        const { token } = resolveSlackTokenAndAccountId({ cfg, accountId });
        const client = createSlackWebClient(token);

        // Register the remote file (upsert by external_id)
        const addArgs: Record<string, unknown> = {
          external_id: externalId,
          external_url: externalUrl,
          title,
        };
        const previewB64 = readStringParam(params, "previewImage", { trim: false });
        if (previewB64) {
          const { base64 } = normalizeBase64Payload(previewB64);
          if (base64) {
            addArgs.preview_image = Buffer.from(base64, "base64");
          }
        }
        const addRes = await client.files.remote.add(addArgs as any);
        const fileId = (addRes as any).file?.id;

        // Share into channel
        await client.files.remote.share({
          channels: channelId,
          ...(fileId ? { file: fileId } : { external_id: externalId }),
        });

        return jsonResult({ ok: true, fileId, externalId, channelId });
      }

      throw new Error(`Unsupported slack action: ${action}`);
    },
  };
}
