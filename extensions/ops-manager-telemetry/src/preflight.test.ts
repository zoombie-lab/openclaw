import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenClawPreflight } from "./preflight.js";

describe("runOpenClawPreflight", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns undefined when the preflight allows the run", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runOpenClawPreflight({
      fetchFn: fetchMock as typeof fetch,
      chatbotBackendUrl: "https://chatbot.example.com",
      shopDomain: "quota-shop.myshopify.com",
      internalSecret: "secret_test",
    });

    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatbot.example.com/api/internal/openclaw/preflight",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-internal-api-secret": "secret_test",
        }),
        body: JSON.stringify({ shopDomain: "quota-shop.myshopify.com" }),
      }),
    );
  });

  it("cancels the run when the preflight denies Freddy usage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          allowed: false,
          denialReason: "token_limit_reached",
          reason: "Freddy quota exhausted.",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await runOpenClawPreflight({
      fetchFn: fetchMock as typeof fetch,
      chatbotBackendUrl: "https://chatbot.example.com",
      shopDomain: "quota-shop.myshopify.com",
      internalSecret: "secret_test",
    });

    expect(result).toEqual({
      cancel: true,
      error: "Freddy token limit reached for the current billing period.",
    });
  });

  it("cancels the run when the preflight endpoint errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Unauthorized", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const result = await runOpenClawPreflight({
      fetchFn: fetchMock as typeof fetch,
      chatbotBackendUrl: "https://chatbot.example.com",
      shopDomain: "quota-shop.myshopify.com",
      internalSecret: "secret_test",
    });

    expect(result).toEqual({
      cancel: true,
      error:
        "Freddy is temporarily unavailable because quota preflight could not be completed. Please try again shortly.",
    });
  });
});
