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

const SLACK_TOOL_ACTIONS = ["read", "user-info", "download-file", "upload-file"] as const;

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
      "Slack utilities for on-demand context fetch (read recent messages / thread replies) and file upload/download. Prefer using this when you need more Slack context than the mention/DM event provides.",
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

      throw new Error(`Unsupported slack action: ${action}`);
    },
  };
}
