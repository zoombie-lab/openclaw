import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as imageGenerationRuntime from "../../image-generation/runtime.js";
import * as imageOps from "../../media/image-ops.js";
import * as mediaStore from "../../media/store.js";
import * as webMedia from "../../web/media.js";
import {
  createImageGenerateTool,
  resolveImageGenerationModelConfigForTool,
} from "./image-generate-tool.js";

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "google",
      defaultModel: "gemini-3.1-flash-image-preview",
      models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
      capabilities: {
        generate: {
          maxCount: 4,
          supportsAspectRatio: true,
          supportsResolution: true,
        },
        edit: {
          enabled: true,
          maxInputImages: 5,
          supportsAspectRatio: true,
          supportsResolution: true,
        },
        geometry: {
          resolutions: ["1K", "2K", "4K"],
          aspectRatios: ["1:1", "16:9"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    {
      id: "openai",
      defaultModel: "gpt-image-1",
      models: ["gpt-image-1"],
      capabilities: {
        generate: {
          maxCount: 4,
          supportsSize: true,
        },
        edit: {
          enabled: false,
          maxInputImages: 0,
        },
        geometry: {
          sizes: ["1024x1024", "1024x1536", "1536x1024"],
        },
      },
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

describe("createImageGenerateTool", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when no image-generation model can be inferred", () => {
    stubImageGenerationProviders();
    expect(createImageGenerateTool({ config: {} })).toBeNull();
  });

  it("infers an OpenAI image-generation model from env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    expect(resolveImageGenerationModelConfigForTool({ cfg: {} })).toEqual({
      primary: "openai/gpt-image-1",
    });
    expect(createImageGenerateTool({ config: {} })).not.toBeNull();
  });

  it("prefers the primary model provider when multiple image providers have auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test");

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "google/gemini-3.1-pro-preview",
              },
            },
          },
        },
      }),
    ).toEqual({
      primary: "google/gemini-3.1-flash-image-preview",
      fallbacks: ["openai/gpt-image-1"],
    });
  });

  it("generates images and returns MEDIA paths", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-1"),
          mimeType: "image/png",
          fileName: "cat-one.png",
        },
        {
          buffer: Buffer.from("png-2"),
          mimeType: "image/png",
          fileName: "cat-two.png",
          revisedPrompt: "A more cinematic cat",
        },
      ],
    });
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/generated-1.png",
      id: "generated-1.png",
      size: 5,
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/generated-2.png",
      id: "generated-2.png",
      size: 5,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      },
      agentDir: "/tmp/agent",
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "A cat wearing sunglasses",
      model: "openai/gpt-image-1",
      filename: "cats/output.png",
      count: 2,
      size: "1024x1024",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
        prompt: "A cat wearing sunglasses",
        agentDir: "/tmp/agent",
        modelOverride: "openai/gpt-image-1",
        size: "1024x1024",
        count: 2,
        inputImages: [],
      }),
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("png-1"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cats/output.png",
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("png-2"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cats/output.png",
    );
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Generated 2 images with openai/gpt-image-1."),
        },
      ],
      details: {
        provider: "openai",
        model: "gpt-image-1",
        count: 2,
        paths: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        filename: "cats/output.png",
        revisedPrompts: ["A more cinematic cat"],
      },
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("MEDIA:/tmp/generated-1.png");
    expect(text).toContain("MEDIA:/tmp/generated-2.png");
  });

  it("rejects counts outside the supported range", async () => {
    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(tool.execute("call-2", { prompt: "too many cats", count: 5 })).rejects.toThrow(
      "count must be between 1 and 4",
    );
  });

  it("forwards reference images and inferred resolution for edit mode", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      width: 3200,
      height: 1800,
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3-pro-image-preview",
            },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await tool.execute("call-edit", {
      prompt: "Add a dramatic stormy sky but keep everything else identical.",
      image: "./fixtures/reference.png",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: undefined,
        resolution: "4K",
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/png",
          }),
        ],
      }),
    );
  });

  it("does not infer resolution for edit providers that do not support resolution overrides", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "vercel-ai-gateway",
        defaultModel: "google/gemini-3.1-flash-image-preview",
        models: ["google/gemini-3.1-flash-image-preview"],
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
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "vercel-ai-gateway",
      model: "google/gemini-3.1-flash-image-preview",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });
    const getImageMetadata = vi.spyOn(imageOps, "getImageMetadata");
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "vercel-ai-gateway/google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await tool.execute("call-edit-no-resolution", {
      prompt: "Keep the product the same, just clean up the background.",
      image: "./fixtures/reference.png",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: undefined,
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/png",
          }),
        ],
      }),
    );
    expect(getImageMetadata).not.toHaveBeenCalled();
  });

  it("forwards explicit aspect ratio and supports up to 5 reference images", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3-pro-image-preview",
            },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const images = Array.from({ length: 5 }, (_, index) => `./fixtures/ref-${index + 1}.png`);
    await tool.execute("call-compose", {
      prompt: "Combine these into one scene",
      images,
      aspectRatio: "16:9",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: "16:9",
        inputImages: expect.arrayContaining([
          expect.objectContaining({ buffer: Buffer.from("input-image"), mimeType: "image/png" }),
        ]),
      }),
    );
    expect(generateImage.mock.calls[0]?.[0].inputImages).toHaveLength(5);
  });

  it("rejects unsupported aspect ratios", async () => {
    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3-pro-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(
      tool.execute("call-bad-aspect", { prompt: "portrait", aspectRatio: "7:5" }),
    ).rejects.toThrow(
      "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
    );
  });

  it("lists registered provider and model options", async () => {
    stubImageGenerationProviders();

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-list", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("google (default gemini-3.1-flash-image-preview)");
    expect(text).toContain("gemini-3.1-flash-image-preview");
    expect(text).toContain("gemini-3-pro-image-preview");
    expect(text).toContain("editing up to 5 refs");
    expect(text).toContain("aspect ratios 1:1, 16:9");
    expect(result).toMatchObject({
      details: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "google",
            defaultModel: "gemini-3.1-flash-image-preview",
            models: expect.arrayContaining([
              "gemini-3.1-flash-image-preview",
              "gemini-3-pro-image-preview",
            ]),
            capabilities: expect.objectContaining({
              edit: expect.objectContaining({
                enabled: true,
                maxInputImages: 5,
              }),
            }),
          }),
        ]),
      },
    });
  });

  it("rejects provider-specific edit limits before runtime", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "fal",
        defaultModel: "fal-ai/flux/dev",
        models: ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 1,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: true,
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage");
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "fal/fal-ai/flux/dev",
            },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(
      tool.execute("call-fal-edit", {
        prompt: "combine",
        images: ["./fixtures/a.png", "./fixtures/b.png"],
      }),
    ).rejects.toThrow("fal edit supports at most 1 reference image");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("rejects unsupported provider-specific edit aspect ratio overrides before runtime", async () => {
    vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
      {
        id: "fal",
        defaultModel: "fal-ai/flux/dev",
        models: ["fal-ai/flux/dev", "fal-ai/flux/dev/image-to-image"],
        capabilities: {
          generate: {
            maxCount: 4,
            supportsSize: true,
            supportsAspectRatio: true,
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 1,
            supportsSize: true,
            supportsAspectRatio: false,
            supportsResolution: true,
          },
          geometry: {
            aspectRatios: ["1:1", "16:9"],
          },
        },
        generateImage: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    ]);
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage");
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "fal/fal-ai/flux/dev",
            },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(
      tool.execute("call-fal-aspect", {
        prompt: "edit",
        image: "./fixtures/a.png",
        aspectRatio: "16:9",
      }),
    ).rejects.toThrow("fal edit does not support aspectRatio overrides");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("resolves relative reference images from workspaceDir", async () => {
    vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    const loadWebMedia = vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      width: 1024,
      height: 1024,
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const workspaceDir = "/tmp/openclaw-workspace";
    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
      workspaceDir,
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await tool.execute("call-workspace-relative", {
      prompt: "edit this image",
      image: "./artifacts/reference.png",
    });

    expect(loadWebMedia).toHaveBeenCalledWith(
      path.resolve(workspaceDir, "./artifacts/reference.png"),
      undefined,
    );
  });

  it("rejects absolute local paths outside workspace and media roots", async () => {
    const loadWebMedia = vi.spyOn(webMedia, "loadWebMedia");
    vi.spyOn(mediaStore, "getMediaDir").mockReturnValue("/tmp/openclaw-media");

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(
      tool.execute("call-outside-root", {
        prompt: "edit this image",
        image: "/etc/passwd",
      }),
    ).rejects.toThrow("Path escapes sandbox root");
    expect(loadWebMedia).not.toHaveBeenCalled();
  });
});
