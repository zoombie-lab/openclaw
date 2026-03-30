import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("openclaw-tools: custom tools", () => {
  it("includes slack + store_analytics + store_status tools with object schemas", () => {
    const tools = createOpenClawTools({ agentChannel: "slack" });

    const byName = (name: string) => tools.find((tool) => tool.name === name);
    const slack = byName("slack");
    const storeAnalytics = byName("store_analytics");
    const storeStatus = byName("store_status");

    expect(slack).toBeDefined();
    expect(storeAnalytics).toBeDefined();
    expect(storeStatus).toBeDefined();

    for (const tool of [slack, storeAnalytics, storeStatus]) {
      if (!tool) {
        continue;
      }
      const schema = tool.parameters as {
        type?: unknown;
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      expect(schema.properties).toBeDefined();
    }
  });
});
