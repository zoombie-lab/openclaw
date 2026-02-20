import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createOpenClawReadTool, normalizeToolParams } from "./pi-tools.read.js";

describe("pi-tools.read helpers", () => {
  it("normalizes nested params and common alias keys", () => {
    const normalized = normalizeToolParams({
      input: {
        filePath: "notes.md",
        old_text: "before",
        new_text: "after",
      },
    });

    expect(normalized).toEqual({
      path: "notes.md",
      oldText: "before",
      newText: "after",
    });
  });

  it("normalizes a raw string into a read path", () => {
    expect(normalizeToolParams("README.md")).toEqual({ path: "README.md" });
  });

  it("returns directory listing results for directory reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-dir-"));
    const nestedDir = path.join(root, "nested");
    const filePath = path.join(root, "ticket.md");
    const baseExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "should-not-be-called" }],
    }));
    const baseTool: AnyAgentTool = {
      name: "read",
      description: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      execute: baseExecute,
    };

    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(filePath, "ok", "utf8");

    try {
      const tool = createOpenClawReadTool(baseTool, root);
      const result = await tool.execute("read-1", { path: "." });
      const text =
        Array.isArray(result.content) && result.content[0] && "text" in result.content[0]
          ? String(result.content[0].text)
          : "";

      expect(baseExecute).not.toHaveBeenCalled();
      expect(text).toContain("Directory listing for .");
      expect(text).toContain("- nested/");
      expect(text).toContain("- ticket.md");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
