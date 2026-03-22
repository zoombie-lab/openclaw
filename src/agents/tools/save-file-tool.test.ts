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

describe("files tool", () => {
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
      text: "Saved file: ./artifacts/report.txt\nReuse this local path with message(filePath/path/media) or image_generate(image/images).\nMEDIA:./artifacts/report.txt",
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

  it("accepts source as an alias for url/local copy inputs", async () => {
    const sandboxRoot = await makeSandbox();
    const sourcePath = path.join(sandboxRoot, "input.csv");
    await fs.writeFile(sourcePath, "a,b\n1,2\n", "utf8");
    const tool = createSaveFileTool({ sandboxRoot });

    const result = await tool.execute("call-3", {
      path: "artifacts/report.csv",
      source: "./input.csv",
    });

    const written = await fs.readFile(path.join(sandboxRoot, "artifacts", "report.csv"), "utf8");
    expect(written).toBe("a,b\n1,2\n");
    expect(result.details).toMatchObject({
      displayPath: "./artifacts/report.csv",
      source: "url",
    });
  });

  it("finds previously saved local files for later reuse", async () => {
    const sandboxRoot = await makeSandbox();
    await fs.mkdir(path.join(sandboxRoot, "media"), { recursive: true });
    const olderPath = path.join(sandboxRoot, "media", "product-photo-studio.jpg");
    const newerPath = path.join(sandboxRoot, "media", "product-photo-lifestyle.jpg");
    await fs.writeFile(olderPath, "older");
    await fs.writeFile(newerPath, "newer");
    await fs.utimes(
      olderPath,
      new Date("2026-03-20T22:09:46.000Z"),
      new Date("2026-03-20T22:09:46.000Z"),
    );
    await fs.utimes(
      newerPath,
      new Date("2026-03-20T22:10:13.000Z"),
      new Date("2026-03-20T22:10:13.000Z"),
    );
    const tool = createSaveFileTool({ sandboxRoot });

    const result = await tool.execute("call-find", {
      action: "find",
      query: "product-photo",
    });

    expect(result.content?.[0]).toMatchObject({
      type: "text",
    });
    expect(result.content?.[0]?.text).toContain("./media/product-photo-lifestyle.jpg");
    expect(result.content?.[0]?.text).toContain("./media/product-photo-studio.jpg");
    expect(result.details).toMatchObject({
      action: "find",
      query: "product-photo",
      count: 2,
    });
    expect(
      (result.details as { matches: Array<{ displayPath: string }> }).matches.map(
        (match) => match.displayPath,
      ),
    ).toEqual(["./media/product-photo-lifestyle.jpg", "./media/product-photo-studio.jpg"]);
  });

  it("emits MEDIA for a single found file when attach=true", async () => {
    const sandboxRoot = await makeSandbox();
    await fs.mkdir(path.join(sandboxRoot, "media"), { recursive: true });
    await fs.writeFile(path.join(sandboxRoot, "media", "hero.jpg"), "hero");
    const tool = createSaveFileTool({ sandboxRoot });

    const result = await tool.execute("call-find-attach", {
      action: "find",
      query: "hero.jpg",
      attach: true,
    });

    expect(result.content?.[0]?.text).toContain("MEDIA:./media/hero.jpg");
    expect(result.details).toMatchObject({
      action: "find",
      count: 1,
    });
  });

  it("rejects paths that escape the sandbox root", async () => {
    const sandboxRoot = await makeSandbox();
    const tool = createSaveFileTool({ sandboxRoot });

    await expect(
      tool.execute("call-4", {
        path: "../escape.txt",
        text: "nope",
      }),
    ).rejects.toThrow(/escapes sandbox root/i);
  });
});
