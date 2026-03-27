import { describe, expect, it } from "vitest";
import type { PluginRegistry } from "./registry.js";
import { createHookRunner } from "./hooks.js";

function createEmptyRegistry(): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("createHookRunner", () => {
  it("preserves cancellation metadata from before_agent_start hooks", async () => {
    const registry = createEmptyRegistry();
    registry.typedHooks.push(
      {
        pluginId: "preflight",
        hookName: "before_agent_start",
        priority: 10,
        source: "test",
        handler: async () => ({
          cancel: true,
          error: "Freddy is unavailable on the current plan.",
        }),
      },
      {
        pluginId: "context",
        hookName: "before_agent_start",
        priority: 1,
        source: "test",
        handler: async () => ({
          prependContext: "Injected context",
        }),
      },
    );

    const runner = createHookRunner(registry, { catchErrors: false });
    const result = await runner.runBeforeAgentStart(
      {
        prompt: "Run it",
      },
      {},
    );

    expect(result).toEqual({
      cancel: true,
      error: "Freddy is unavailable on the current plan.",
      prependContext: "Injected context",
      systemPrompt: undefined,
    });
  });
});
