import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const uploadV2 = vi.fn();
const conversationsOpen = vi.fn();
const filesInfo = vi.fn();
const resolveSlackMedia = vi.fn();

vi.mock("../../slack/client.js", () => ({
  createSlackWebClient: vi.fn(() => ({
    conversations: { open: conversationsOpen },
    files: { uploadV2, info: filesInfo },
  })),
}));

vi.mock("../../slack/accounts.js", () => ({
  resolveSlackAccount: vi.fn(() => ({
    accountId: "default",
    botToken: "xoxb-test-token",
  })),
}));

vi.mock("../../slack/token.js", () => ({
  resolveSlackBotToken: vi.fn((token?: string) => token ?? null),
}));

vi.mock("../../slack/monitor/media.js", () => ({
  resolveSlackMedia: (...args: Parameters<typeof resolveSlackMedia>) => resolveSlackMedia(...args),
}));

import { createSlackTool } from "./slack-tool.js";

describe("custom slack tool", () => {
  beforeEach(() => {
    uploadV2.mockReset();
    conversationsOpen.mockReset();
    filesInfo.mockReset();
    resolveSlackMedia.mockReset();
    uploadV2.mockResolvedValue({ file: { id: "F123" } });
  });

  it("downloads files by fileId using fresh files.info metadata", async () => {
    const cfg = { channels: { slack: { enabled: true } } } satisfies OpenClawConfig;
    const tool = createSlackTool({ config: cfg });
    filesInfo.mockResolvedValue({
      file: {
        id: "F234",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F234/image.png",
      },
    });
    resolveSlackMedia.mockResolvedValue([
      {
        path: "/tmp/image.png",
        contentType: "image/png",
        placeholder: "[Slack file: image.png]",
      },
    ]);

    const result = await tool.execute("call-download", {
      action: "download-file",
      fileId: "F234",
      maxBytes: 2048,
    });

    expect(filesInfo).toHaveBeenCalledWith({ file: "F234" });
    expect(resolveSlackMedia).toHaveBeenCalledWith({
      files: [
        {
          id: "F234",
          name: "image.png",
          mimetype: "image/png",
          url_private: undefined,
          url_private_download: "https://files.slack.com/files-pri/T1-F234/image.png",
        },
      ],
      token: "xoxb-test-token",
      maxBytes: 2048,
    });
    expect(result.details).toMatchObject({
      ok: true,
      path: "/tmp/image.png",
      contentType: "image/png",
    });
  });

  it("stages downloaded files into workspace media/inbound when workspace context exists", async () => {
    const cfg = { channels: { slack: { enabled: true } } } satisfies OpenClawConfig;
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    const mediaRoot = path.join(stateRoot, "media");
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const sourcePath = path.join(mediaRoot, "inbound", "image.png");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "png-bytes");

    const stateDirEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    const tool = createSlackTool({ config: cfg, workspaceDir: workspaceRoot });
    filesInfo.mockResolvedValue({
      file: {
        id: "F234",
        name: "image.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.com/files-pri/T1-F234/image.png",
      },
    });
    resolveSlackMedia.mockResolvedValue([
      {
        path: sourcePath,
        contentType: "image/png",
        placeholder: "[Slack file: image.png]",
      },
    ]);

    try {
      const result = await tool.execute("call-download-stage", {
        action: "download-file",
        fileId: "F234",
        maxBytes: 2048,
      });

      expect(result.details).toMatchObject({
        ok: true,
        path: "media/inbound/image.png",
        absolutePath: path.join(workspaceRoot, "media", "inbound", "image.png"),
        contentType: "image/png",
      });
      await expect(
        fs.readFile(path.join(workspaceRoot, "media", "inbound", "image.png"), "utf8"),
      ).resolves.toBe("png-bytes");
    } finally {
      if (stateDirEnv == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = stateDirEnv;
      }
      await fs.rm(stateRoot, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("accepts fileName as an alias for filename", async () => {
    const cfg = { channels: { slack: { enabled: true } } } satisfies OpenClawConfig;
    const tool = createSlackTool({ config: cfg });
    const buffer = Buffer.from("col1,col2\n1,2\n", "utf8").toString("base64");

    const result = await tool.execute("call-1", {
      action: "upload-file",
      to: "channel:C123",
      fileName: "report.csv",
      buffer,
      contentType: "text/csv",
      uploadThreadTs: "1773894156.784359",
    });

    expect(uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123",
        filename: "report.csv",
        thread_ts: "1773894156.784359",
      }),
    );
    expect(result.details).toMatchObject({ ok: true, fileId: "F123", channelId: "C123" });
  });
});
