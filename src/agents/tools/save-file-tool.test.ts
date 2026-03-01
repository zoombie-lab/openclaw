import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSaveFileTool } from "./save-file-tool.js";

const tempDirs: string[] = [];

async function makeSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-save-file-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("save_file tool", () => {
  it("writes text into a sandboxed relative path and emits MEDIA when attach=true", async () => {
    const sandboxRoot = await makeSandbox();
    const tool = createSaveFileTool({ sandboxRoot });

    const result = await tool.execute("call-1", {
      path: "artifacts/report.txt",
      text: "hello world",
      attach: true,
    });

    const written = await fs.readFile(path.join(sandboxRoot, "artifacts", "report.txt"), "utf8");
    expect(written).toBe("hello world");
    expect(result.content?.[0]).toMatchObject({
      type: "text",
      text: "Saved file: ./artifacts/report.txt\nMEDIA:./artifacts/report.txt",
    });
    expect(result.details).toMatchObject({
      displayPath: "./artifacts/report.txt",
      contentType: "text/plain",
      source: "text",
    });
  });

  it("decodes base64 data URLs and preserves the inferred content type", async () => {
    const sandboxRoot = await makeSandbox();
    const tool = createSaveFileTool({ sandboxRoot });

    const result = await tool.execute("call-2", {
      path: "artifacts/hello.txt",
      buffer: "data:text/plain;base64,aGk=",
    });

    const written = await fs.readFile(path.join(sandboxRoot, "artifacts", "hello.txt"), "utf8");
    expect(written).toBe("hi");
    expect(result.details).toMatchObject({
      displayPath: "./artifacts/hello.txt",
      contentType: "text/plain",
      source: "buffer",
      bytes: 2,
    });
  });

  it("rejects paths that escape the sandbox root", async () => {
    const sandboxRoot = await makeSandbox();
    const tool = createSaveFileTool({ sandboxRoot });

    await expect(
      tool.execute("call-3", {
        path: "../escape.txt",
        text: "nope",
      }),
    ).rejects.toThrow(/escapes sandbox root/i);
  });
});
