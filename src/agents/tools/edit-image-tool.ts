import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { resolveFetch } from "../../infra/fetch.js";
import { resolveApiKeyForProvider } from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";
import { assertSandboxPath } from "../sandbox-paths.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_GATEWAY_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";

function buildDisplayPath(params: { filePath: string; root: string }): string {
  const relative = path.relative(params.root, params.filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return params.filePath;
  }
  const normalized = relative.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function resolveProviderConfig(cfg: OpenClawConfig | undefined, provider: string) {
  return cfg?.models?.providers?.[provider];
}

async function resolveImageProviderRoute(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  requestedProvider: string;
  fallbackProvider: string;
}): Promise<{
  provider: string;
  apiKey: string;
  baseUrl: string;
  fallbackFrom?: string;
}> {
  const choose = async (provider: string) => {
    const normalized = normalizeProviderId(provider);
    // IMAGE_MODEL_API_KEY is an explicit override for this tool only. It must
    // match the selected provider/base URL; otherwise the upstream API will reject it.
    const directOverride = process.env.IMAGE_MODEL_API_KEY?.trim();
    let apiKey: string | undefined;

    if (directOverride) {
      apiKey = directOverride;
    } else {
      try {
        const auth = await resolveApiKeyForProvider({
          provider: normalized,
          cfg: params.config,
          agentDir: params.agentDir,
        });
        apiKey = auth.apiKey;
      } catch {
        apiKey = undefined;
      }
    }

    if (!apiKey) {
      return null;
    }

    const configProvider = resolveProviderConfig(params.config, normalized);
    const configuredBaseUrl = configProvider?.baseUrl?.trim();
    const defaultBaseUrl =
      normalized === "vercel-ai-gateway"
        ? DEFAULT_VERCEL_AI_GATEWAY_BASE_URL
        : DEFAULT_OPENAI_IMAGE_BASE_URL;

    return {
      provider: normalized,
      apiKey,
      baseUrl: configuredBaseUrl || defaultBaseUrl,
    };
  };

  const primary = await choose(params.requestedProvider);
  if (primary) {
    return primary;
  }

  const fallback = await choose(params.fallbackProvider);
  if (fallback) {
    return {
      ...fallback,
      fallbackFrom: normalizeProviderId(params.requestedProvider),
    };
  }

  throw new Error(
    `No API key configured for ${normalizeProviderId(params.requestedProvider)} or fallback ${normalizeProviderId(params.fallbackProvider)}.`,
  );
}

async function toPngBuffer(input: Buffer): Promise<Buffer> {
  try {
    return await sharp(input).png().toBuffer();
  } catch (err) {
    throw new Error(
      `Unable to read image input: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function decodeImageDataUrl(dataUrl: string): Buffer {
  const trimmed = dataUrl.trim();
  const match = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Expected image result as a base64 image data URL.");
  }
  return Buffer.from(match[1], "base64");
}

export function createEditImageTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  sandboxRoot?: string;
  workspaceDir?: string;
}): AnyAgentTool {
  const root = (options?.sandboxRoot ?? options?.workspaceDir ?? process.cwd()).trim();

  return {
    label: "Edit Image",
    name: "edit_image",
    description:
      "Edit an image using AI by providing an original image and a prompt. Arbitrary input formats are normalized to PNG before upload.",
    parameters: Type.Object({
      image_paths: Type.Array(
        Type.String({
          description: "Path(s) to the local image file(s) to edit. The first image will be used.",
        }),
      ),
      prompt: Type.String({
        description: "Detailed description of the desired edits or transformations.",
      }),
      provider: Type.Optional(
        Type.String({
          description: "Optional transport provider. 'vercel-ai-gateway', 'openai', or 'fly'.",
        }),
      ),
      fallbackProvider: Type.Optional(
        Type.String({
          description:
            "Fallback provider if the requested provider is not configured. Defaults to 'openai'.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Optional image model id. Defaults to Gemini image preview on Vercel AI Gateway and gpt-image-1 on direct OpenAI.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const imagePaths = Array.isArray(record.image_paths) ? record.image_paths : [];
      const prompt = String(record.prompt || "").trim();
      const requestedProvider = String(record.provider || "vercel-ai-gateway").trim();
      const fallbackProvider = String(record.fallbackProvider || "openai").trim();
      const requestedModel =
        typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;

      if (imagePaths.length === 0) {
        throw new Error("image_paths array must contain at least one path");
      }
      if (!prompt) {
        throw new Error("prompt is required");
      }

      const inputPath = String(imagePaths[0]).trim();
      const safeInput = await assertSandboxPath({ filePath: inputPath, cwd: root, root });

      const ext = path.extname(safeInput.resolved);
      const base = path.basename(safeInput.resolved, ext);
      const dir = path.dirname(safeInput.resolved);
      const outputPath = path.join(dir, `${base}_edited_${Date.now()}.png`);
      const safeOutput = await assertSandboxPath({ filePath: outputPath, cwd: root, root });

      const imageBuffer = await fs.readFile(safeInput.resolved);
      const pngBuffer = await toPngBuffer(imageBuffer);
      await fs.mkdir(path.dirname(safeOutput.resolved), { recursive: true });

      let providerUsed = normalizeProviderId(requestedProvider);
      let fallbackFrom: string | undefined;
      let modelUsed = requestedModel;

      if (providerUsed === "fly") {
        modelUsed = modelUsed ?? DEFAULT_GATEWAY_IMAGE_MODEL;
        const flyUrl = process.env.FLY_IMAGE_API_URL || "https://your-fly-app.fly.dev/edit";
        const formData = new FormData();
        formData.append("image", new Blob([pngBuffer], { type: "image/png" }), "image.png");
        formData.append("prompt", prompt);
        formData.append("model", modelUsed);

        const fetchFn = resolveFetch();
        if (!fetchFn) {
          throw new Error("fetch is not available in this runtime.");
        }

        const res = await fetchFn(flyUrl, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Fly API Error: ${res.status} ${res.statusText} - ${errText}`);
        }

        const outBuffer = await res.arrayBuffer();
        await fs.writeFile(safeOutput.resolved, Buffer.from(outBuffer));
      } else {
        const route = await resolveImageProviderRoute({
          config: options?.config,
          agentDir: options?.agentDir,
          requestedProvider: providerUsed,
          fallbackProvider,
        });
        providerUsed = route.provider;
        fallbackFrom = route.fallbackFrom;

        const fetchFn = resolveFetch();
        if (!fetchFn) {
          throw new Error("fetch is not available in this runtime.");
        }

        if (providerUsed === "vercel-ai-gateway") {
          modelUsed = modelUsed ?? DEFAULT_GATEWAY_IMAGE_MODEL;
          const endpoint = `${route.baseUrl.replace(/\/$/, "")}/chat/completions`;
          const imageDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;

          const res = await fetchFn(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${route.apiKey}`,
            },
            body: JSON.stringify({
              model: modelUsed,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: prompt },
                    {
                      type: "image_url",
                      image_url: {
                        url: imageDataUrl,
                        detail: "auto",
                      },
                    },
                  ],
                },
              ],
              modalities: ["image"],
              stream: false,
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`AI Gateway Error: ${res.status} ${res.statusText} - ${errText}`);
          }

          const data = (await res.json()) as {
            choices?: Array<{
              message?: {
                images?: Array<{
                  type?: string;
                  image_url?: { url?: string };
                }>;
              };
            }>;
          };

          const imageUrl = data.choices?.[0]?.message?.images?.find(
            (img) => img.type === "image_url",
          )?.image_url?.url;
          if (!imageUrl) {
            throw new Error("AI Gateway response did not include an image.");
          }

          const outBuffer = decodeImageDataUrl(imageUrl);
          await fs.writeFile(safeOutput.resolved, outBuffer);
        } else {
          modelUsed = modelUsed ?? DEFAULT_OPENAI_IMAGE_MODEL;
          const endpoint = `${route.baseUrl.replace(/\/$/, "")}/images/edits`;
          const formData = new FormData();
          formData.append("image", new Blob([pngBuffer], { type: "image/png" }), "image.png");
          formData.append("prompt", prompt);
          formData.append("model", modelUsed);
          formData.append("response_format", "b64_json");

          const res = await fetchFn(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${route.apiKey}`,
            },
            body: formData,
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`OpenAI API Error: ${res.status} ${res.statusText} - ${errText}`);
          }

          const data = (await res.json()) as {
            data?: Array<{ b64_json?: string }>;
          };
          const b64 = data.data?.[0]?.b64_json;
          if (!b64) {
            throw new Error("Unexpected response format from OpenAI API");
          }

          await fs.writeFile(safeOutput.resolved, Buffer.from(b64, "base64"));
        }
      }

      const displayPath = buildDisplayPath({ filePath: safeOutput.resolved, root });
      return {
        content: [
          { type: "text", text: `Edited image saved: ${displayPath}\nMEDIA:${displayPath}` },
        ],
        details: {
          original_path: safeInput.resolved,
          output_path: safeOutput.resolved,
          displayPath,
          model: modelUsed,
          provider: providerUsed,
          ...(fallbackFrom ? { fallbackFrom } : {}),
        },
      };
    },
  };
}
