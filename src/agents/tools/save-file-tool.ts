import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { loadWebMediaRaw } from "../../web/media.js";
import { assertSandboxPath } from "../sandbox-paths.js";

function pickMaxBytes(cfg?: OpenClawConfig): number | undefined {
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

function normalizeBase64Payload(params: { base64: string; contentType?: string }): {
  base64: string;
  contentType?: string;
} {
  const trimmed = params.base64.trim();
  const match = /^data:([^,]*?);base64,([\s\S]*)$/i.exec(trimmed);
  if (!match) {
    return { base64: trimmed, contentType: params.contentType };
  }
  const [, mimeType, payload] = match;
  return {
    base64: payload,
    contentType: params.contentType ?? mimeType,
  };
}

function buildDisplayPath(params: { filePath: string; root: string }): string {
  const relative = path.relative(params.root, params.filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return params.filePath;
  }
  const normalized = relative.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

export function createSaveFileTool(options?: {
  config?: OpenClawConfig;
  sandboxRoot?: string;
  workspaceDir?: string;
}): AnyAgentTool {
  const root = (options?.sandboxRoot ?? options?.workspaceDir ?? process.cwd()).trim();

  return {
    label: "Save File",
    name: "save_file",
    description:
      "Canonical workspace file tool. Use it to create CSV/JSON/text files, decode base64/data URLs, copy local files, download URLs into the workspace, and stage files for message/image_generate. Use attach=true to include a MEDIA line for the saved file.",
    parameters: Type.Object({
      path: Type.String({
        description: "Output path inside the workspace or sandbox (relative paths recommended).",
      }),
      text: Type.Optional(Type.String()),
      buffer: Type.Optional(
        Type.String({
          description: "Base64 payload for the file. data: URLs are also accepted.",
        }),
      ),
      source: Type.Optional(
        Type.String({
          description: "HTTP(S), file://, or local path to copy into the output file.",
        }),
      ),
      url: Type.Optional(
        Type.String({
          description:
            "Alias for source. HTTP(S), file://, or local path to copy into the output file.",
        }),
      ),
      contentType: Type.Optional(Type.String()),
      mimeType: Type.Optional(Type.String()),
      attach: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const requestedPath =
        typeof record.path === "string" && record.path.trim() ? record.path.trim() : "";
      if (!requestedPath) {
        throw new Error("path required");
      }

      const hasText = typeof record.text === "string";
      const hasBuffer = typeof record.buffer === "string";
      const hasSource = typeof record.source === "string";
      const hasUrl = typeof record.url === "string";
      const hasCopySource = hasSource || hasUrl;
      const sourceCount = Number(hasText) + Number(hasBuffer) + Number(hasCopySource);
      if (sourceCount === 0) {
        throw new Error("Provide exactly one source: text, buffer, source, or url");
      }
      if (sourceCount > 1) {
        throw new Error("Only one source is allowed: text, buffer, source, or url");
      }

      const resolved = await assertSandboxPath({
        filePath: requestedPath,
        cwd: root,
        root,
      });
      const contentTypeRaw =
        typeof record.contentType === "string" && record.contentType.trim()
          ? record.contentType.trim()
          : typeof record.mimeType === "string" && record.mimeType.trim()
            ? record.mimeType.trim()
            : undefined;
      const attach = record.attach === true;

      let bytes = 0;
      let contentType = contentTypeRaw;
      let source: "text" | "buffer" | "url";

      if (hasBuffer) {
        const normalized = normalizeBase64Payload({
          base64: String(record.buffer),
          contentType,
        });
        const buffer = Buffer.from(normalized.base64, "base64");
        await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
        await fs.writeFile(resolved.resolved, buffer);
        bytes = buffer.length;
        contentType = normalized.contentType ?? contentType;
        source = "buffer";
      } else if (hasText) {
        const text = String(record.text);
        await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
        await fs.writeFile(resolved.resolved, text, "utf8");
        bytes = Buffer.byteLength(text, "utf8");
        contentType = contentType ?? "text/plain";
        source = "text";
      } else {
        let urlTarget = String(hasSource ? record.source : record.url).trim();
        if (!/^https?:\/\//i.test(urlTarget)) {
          let localPath = urlTarget;
          if (localPath.startsWith("file://")) {
            try {
              localPath = fileURLToPath(localPath);
            } catch {
              throw new Error(`Invalid file:// URL: ${urlTarget}`);
            }
          }
          if (localPath.startsWith("~")) {
            throw new Error("Tilde paths are not permitted.");
          }
          const safeInput = await assertSandboxPath({ filePath: localPath, cwd: root, root });
          urlTarget = safeInput.resolved;
        }

        const media = await loadWebMediaRaw(urlTarget, pickMaxBytes(options?.config));
        await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
        await fs.writeFile(resolved.resolved, media.buffer);
        bytes = media.buffer.length;
        contentType = contentType ?? media.contentType;
        source = "url";
      }

      const displayPath = buildDisplayPath({ filePath: resolved.resolved, root });
      const lines = [
        `Saved file: ${displayPath}`,
        `Reuse this local path with message(filePath/path/media) or image_generate(image/images).`,
      ];
      if (attach) {
        lines.push(`MEDIA:${displayPath}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          path: resolved.resolved,
          displayPath,
          bytes,
          contentType,
          source,
        },
      };
    },
  };
}
