import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const uploadV2 = vi.fn();
const conversationsOpen = vi.fn();

vi.mock("../../slack/client.js", () => ({
  createSlackWebClient: vi.fn(() => ({
    conversations: { open: conversationsOpen },
    files: { uploadV2 },
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

import { createSlackTool } from "./slack-tool.js";

describe("custom slack tool upload-file", () => {
  beforeEach(() => {
    uploadV2.mockReset();
    conversationsOpen.mockReset();
    uploadV2.mockResolvedValue({ file: { id: "F123" } });
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
