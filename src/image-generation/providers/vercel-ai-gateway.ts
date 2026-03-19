import type { ImageGenerationProvider } from "../types.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { decodeDataUrl } from "../../agents/tools/image-tool.helpers.js";
import { normalizeUsage } from "../../agents/usage.js";

const DEFAULT_VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const DEFAULT_VERCEL_AI_GATEWAY_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";

type GatewayImageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type GatewayImageResponse = {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | null;
      images?: Array<{
        type?: string;
        image_url?: {
          url?: string;
        };
      }>;
    };
  }>;
};

function resolveVercelAiGatewayBaseUrl(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): string {
  const direct = (
    cfg?.models?.providers?.["vercel-ai-gateway"] as
      | {
          baseUrl?: string;
        }
      | undefined
  )?.baseUrl?.trim();
  return direct || DEFAULT_VERCEL_AI_GATEWAY_BASE_URL;
}

export function buildVercelAiGatewayImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    defaultModel: DEFAULT_VERCEL_AI_GATEWAY_IMAGE_MODEL,
    models: [DEFAULT_VERCEL_AI_GATEWAY_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: 5,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "vercel-ai-gateway",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Vercel AI Gateway API key missing");
      }

      const content: GatewayImageContentPart[] = [{ type: "text", text: req.prompt }];
      for (const image of req.inputImages ?? []) {
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`,
          },
        });
      }

      const response = await fetch(`${resolveVercelAiGatewayBaseUrl(req.cfg)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model || DEFAULT_VERCEL_AI_GATEWAY_IMAGE_MODEL,
          messages: [{ role: "user", content }],
          modalities: ["image"],
          stream: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `Vercel AI Gateway image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const payload = (await response.json()) as GatewayImageResponse;
      const images = (payload.choices?.[0]?.message?.images ?? [])
        .map((entry, index) => {
          if (entry.type !== "image_url" || !entry.image_url?.url) {
            return null;
          }
          const decoded = decodeDataUrl(entry.image_url.url);
          const extension = decoded.mimeType.includes("jpeg")
            ? "jpg"
            : (decoded.mimeType.split("/")[1] ?? "png");
          return {
            buffer: decoded.buffer,
            mimeType: decoded.mimeType,
            fileName: `image-${index + 1}.${extension}`,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      if (images.length === 0) {
        throw new Error("Vercel AI Gateway image generation response missing image data");
      }

      return {
        images: images.slice(0, 1),
        model: payload.model ?? req.model ?? DEFAULT_VERCEL_AI_GATEWAY_IMAGE_MODEL,
        metadata: payload.usage
          ? {
              normalizedUsage: normalizeUsage(payload.usage),
              usage: payload.usage,
            }
          : undefined,
      };
    },
  };
}
