import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createEditImageTool } from "./edit-image-tool.js";

const priorFetch = global.fetch;
const tempDirs: string[] = [];

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-image-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJpeg(filePath: string) {
  const jpeg = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .jpeg()
    .toBuffer();
  await fs.writeFile(filePath, jpeg);
}

async function makePngBase64() {
  const png = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return png.toString("base64");
}

async function makePngDataUrl() {
  return `data:image/png;base64,${await makePngBase64()}`;
}

beforeEach(() => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  // @ts-expect-error global fetch stub reset
  global.fetch = priorFetch;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  // @ts-expect-error global fetch cleanup
  global.fetch = priorFetch;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("edit_image tool", () => {
  it("converts arbitrary inputs to PNG and falls back from AI Gateway to OpenAI auth", async () => {
    const sandboxRoot = await makeSandbox();
    const inputPath = path.join(sandboxRoot, "product.jpg");
    await writeJpeg(inputPath);
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");

    const pngBase64 = await makePngBase64();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: [{ b64_json: pngBase64 }] }),
    });
    // @ts-expect-error partial fetch mock
    global.fetch = fetchMock;

    const tool = createEditImageTool({ sandboxRoot });
    const result = await tool.execute("call-1", {
      image_paths: ["product.jpg"],
      prompt: "Remove the clutter and place on a white background.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer openai-test-key");

    const body = init.body as FormData;
    const imagePart = body.get("image");
    expect(imagePart).toBeInstanceOf(Blob);
    expect((imagePart as Blob).type).toBe("image/png");
    expect(body.get("model")).toBe("gpt-image-1");

    const pngBytes = Buffer.from(await (imagePart as Blob).arrayBuffer());
    expect(pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
      true,
    );

    expect(result.details).toMatchObject({
      provider: "openai",
      fallbackFrom: "vercel-ai-gateway",
      model: "gpt-image-1",
    });
    expect(String(result.content?.[0]?.type)).toBe("text");
    expect(String((result.content?.[0] as { text?: string })?.text)).toContain("MEDIA:./");
  });

  it("uses the configured Vercel AI Gateway route and custom image model when available", async () => {
    const sandboxRoot = await makeSandbox();
    const inputPath = path.join(sandboxRoot, "product.jpg");
    await writeJpeg(inputPath);
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-test-key");

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "vercel-ai-gateway": {
            baseUrl: "https://gateway.example/v1",
            models: [],
          },
        },
      },
    };

    const pngDataUrl = await makePngDataUrl();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [
          {
            message: {
              images: [{ type: "image_url", image_url: { url: pngDataUrl } }],
            },
          },
        ],
      }),
    });
    // @ts-expect-error partial fetch mock
    global.fetch = fetchMock;

    const tool = createEditImageTool({ sandboxRoot, config: cfg });
    const result = await tool.execute("call-2", {
      image_paths: ["product.jpg"],
      prompt: "Studio product photo on pure white.",
      model: "google/gemini-3.1-flash-image-preview",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gateway-test-key");
    const payload = JSON.parse(String(init.body)) as {
      model: string;
      modalities: string[];
      messages: Array<{
        content: Array<{ type: string; text?: string; image_url?: { url?: string } }>;
      }>;
    };
    expect(payload.model).toBe("google/gemini-3.1-flash-image-preview");
    expect(payload.modalities).toEqual(["image"]);
    expect(payload.messages[0]?.content[1]?.type).toBe("image_url");
    expect(
      payload.messages[0]?.content[1]?.image_url?.url?.startsWith("data:image/png;base64,"),
    ).toBe(true);
    expect(result.details).toMatchObject({
      provider: "vercel-ai-gateway",
      model: "google/gemini-3.1-flash-image-preview",
    });
  });

  it("prefers IMAGE_MODEL_API_KEY over provider-specific env vars", async () => {
    const sandboxRoot = await makeSandbox();
    await writeJpeg(path.join(sandboxRoot, "product.jpg"));
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-ignored");
    vi.stubEnv("IMAGE_MODEL_API_KEY", "image-tool-key");

    const pngDataUrl = await makePngDataUrl();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [
          {
            message: {
              images: [{ type: "image_url", image_url: { url: pngDataUrl } }],
            },
          },
        ],
      }),
    });
    // @ts-expect-error partial fetch mock
    global.fetch = fetchMock;

    const tool = createEditImageTool({ sandboxRoot });
    await tool.execute("call-3", {
      image_paths: ["product.jpg"],
      prompt: "Bright studio product photo.",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer image-tool-key");
  });

  it("rewrites inbound absolute media paths to the staged sandbox copy when present", async () => {
    const sandboxRoot = await makeSandbox();
    const stagedDir = path.join(sandboxRoot, "media", "inbound");
    await fs.mkdir(stagedDir, { recursive: true });
    await writeJpeg(path.join(stagedDir, "product.jpg"));
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-test-key");

    const pngDataUrl = await makePngDataUrl();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [
          {
            message: {
              images: [{ type: "image_url", image_url: { url: pngDataUrl } }],
            },
          },
        ],
      }),
    });
    // @ts-expect-error partial fetch mock
    global.fetch = fetchMock;

    const tool = createEditImageTool({ sandboxRoot });
    const imagePath = "/data/media/inbound/product.jpg";
    const result = await tool.execute("call-4", {
      image_paths: [imagePath],
      prompt: "Clean background.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      provider: "vercel-ai-gateway",
      rewrittenFrom: imagePath,
      original_path: path.join(sandboxRoot, "media", "inbound", "product.jpg"),
    });
  });
});
