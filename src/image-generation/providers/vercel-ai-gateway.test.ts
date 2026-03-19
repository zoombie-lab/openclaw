import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVercelAiGatewayImageGenerationProvider } from "./vercel-ai-gateway.js";

describe("buildVercelAiGatewayImageGenerationProvider", () => {
  beforeEach(() => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-test-key");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("requests image generation through Vercel AI Gateway and normalizes usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "google/gemini-3.1-flash-image-preview",
          choices: [
            {
              message: {
                images: [
                  {
                    type: "image_url",
                    image_url: {
                      url: "data:image/png;base64,aGVsbG8=",
                    },
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: "data:image/png;base64,d29ybGQ=",
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 123,
            completion_tokens: 45,
            total_tokens: 168,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVercelAiGatewayImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "vercel-ai-gateway",
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "Turn this product shot into a lifestyle scene",
      cfg: {},
      inputImages: [
        {
          buffer: Buffer.from("input-image"),
          mimeType: "image/png",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer gateway-test-key",
        "Content-Type": "application/json",
      }),
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "google/gemini-3.1-flash-image-preview",
      modalities: ["image"],
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Turn this product shot into a lifestyle scene" },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,aW5wdXQtaW1hZ2U=",
              },
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("hello"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "google/gemini-3.1-flash-image-preview",
      metadata: {
        normalizedUsage: {
          input: 123,
          output: 45,
          total: 168,
        },
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
        },
      },
    });
  });
});
