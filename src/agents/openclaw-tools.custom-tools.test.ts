import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("openclaw-tools: custom tools", () => {
  it("includes slack + shopify_ops tools with object schemas", () => {
    const tools = createOpenClawTools();

    const byName = (name: string) => tools.find((tool) => tool.name === name);
    const slack = byName("slack");
    const shopifyOps = byName("shopify_ops");

    expect(slack).toBeDefined();
    expect(shopifyOps).toBeDefined();

    for (const tool of [slack, shopifyOps]) {
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
