import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { emitDiagnosticEvent } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpsManagerTelemetryService,
  createOpsManagerTelemetryUsageAccumulator,
} from "./service.js";

function createServiceContext(): OpenClawPluginServiceContext {
  return {
    config: {},
    stateDir: "/tmp",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("ops-manager telemetry service", () => {
  beforeEach(() => {
    vi.stubEnv("INSTALLATION_ID", "inst_test");
    vi.stubEnv("OPS_MANAGER_URL", "https://ops.example.com");
    vi.stubEnv("OPS_SIGNING_SECRET", "secret_test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("merges image_generate usage into the next forwarded model.usage payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const usageAccumulator = createOpsManagerTelemetryUsageAccumulator();
    usageAccumulator.recordToolResultUsage(
      {
        toolName: "image_generate",
        isSynthetic: false,
        message: {
          role: "toolResult",
          content: [],
          details: {
            metadata: {
              normalizedUsage: {
                input: 14,
                output: 1120,
                total: 1134,
              },
            },
          },
        } as never,
      },
      {
        agentId: "freddy",
        sessionKey: "agent:freddy:session-123",
        toolName: "image_generate",
        toolCallId: "call-123",
      },
    );

    const ctx = createServiceContext();
    const service = createOpsManagerTelemetryService(usageAccumulator);
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      sessionKey: "agent:freddy:session-123",
      channel: "slack",
      provider: "vercel-ai-gateway",
      model: "openai/gpt-5.4",
      usage: {
        input: 100,
        output: 50,
        total: 150,
      },
      durationMs: 500,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.stop?.(ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://ops.example.com/api/agent/v1/telemetry/usage");
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      agentId: "freddy",
      sessionKey: "agent:freddy:session-123",
      origin: "slack",
      provider: "vercel-ai-gateway",
      model: "openai/gpt-5.4",
      usage: {
        input: 114,
        output: 1170,
        promptTokens: 114,
        total: 1284,
      },
      toolCalls: ["image_generate"],
      inputMessages: 1,
      outputMessages: 1,
      steps: 1,
    });
  });
});
