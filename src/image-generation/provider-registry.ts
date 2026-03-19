import type { ImageGenerationProvider } from "./types.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { buildFalImageGenerationProvider } from "./providers/fal.js";
import { buildGoogleImageGenerationProvider } from "./providers/google.js";
import { buildOpenAIImageGenerationProvider } from "./providers/openai.js";
import { buildVercelAiGatewayImageGenerationProvider } from "./providers/vercel-ai-gateway.js";

const BUILTIN_IMAGE_GENERATION_PROVIDERS: readonly ImageGenerationProvider[] = [
  buildVercelAiGatewayImageGenerationProvider(),
  buildGoogleImageGenerationProvider(),
  buildFalImageGenerationProvider(),
  buildOpenAIImageGenerationProvider(),
] as const;

function normalizeImageGenerationProviderId(id: string | undefined): string | undefined {
  const normalized = normalizeProviderId(id ?? "");
  return normalized || undefined;
}

function buildProviderMaps(): {
  canonical: Map<string, ImageGenerationProvider>;
  aliases: Map<string, ImageGenerationProvider>;
} {
  const canonical = new Map<string, ImageGenerationProvider>();
  const aliases = new Map<string, ImageGenerationProvider>();
  const register = (provider: ImageGenerationProvider) => {
    const id = normalizeImageGenerationProviderId(provider.id);
    if (!id) {
      return;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeImageGenerationProviderId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  };

  for (const provider of BUILTIN_IMAGE_GENERATION_PROVIDERS) {
    register(provider);
  }

  return { canonical, aliases };
}

export function listImageGenerationProviders(): ImageGenerationProvider[] {
  return [...buildProviderMaps().canonical.values()];
}

export function getImageGenerationProvider(
  providerId: string | undefined,
): ImageGenerationProvider | undefined {
  const normalized = normalizeImageGenerationProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps().aliases.get(normalized);
}
