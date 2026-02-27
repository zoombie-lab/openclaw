import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: () => ({
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "test",
    config: {},
  }),
}));

vi.mock("./token.js", () => ({
  resolveSlackBotToken: (raw?: string) => raw,
}));

const loadSendMessageSlack = async () => {
  const mod = await import("./send.js");
  return mod.sendMessageSlack;
};

function createClient() {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D1" } })),
      create: vi.fn(async () => ({ channel: { id: "C_NEW", name: "freddy-reports" } })),
      list: vi.fn(async () => ({
        channels: [],
        response_metadata: { next_cursor: "" },
      })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as WebClient & {
    conversations: {
      open: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      list: ReturnType<typeof vi.fn>;
    };
    chat: {
      postMessage: ReturnType<typeof vi.fn>;
    };
  };
}

describe("sendMessageSlack channel name delivery", () => {
  it("auto-creates public channel by name and sends to the created channel id", async () => {
    const client = createClient();
    const sendMessageSlack = await loadSendMessageSlack();
    const result = await sendMessageSlack("channel:Freddy-Reports", "Heartbeat update", {
      client,
      token: "xoxb-test",
    });

    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "freddy-reports",
      is_private: false,
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C_NEW",
      text: "Heartbeat update",
      thread_ts: undefined,
    });
    expect(result.channelId).toBe("C_NEW");
  });

  it("reuses existing channel when name is already taken", async () => {
    const client = createClient();
    const sendMessageSlack = await loadSendMessageSlack();
    client.conversations.create.mockRejectedValueOnce({ data: { error: "name_taken" } });
    client.conversations.list.mockResolvedValueOnce({
      channels: [{ id: "C_EXISTING", name: "freddy-reports", is_archived: false }],
      response_metadata: { next_cursor: "" },
    });

    const result = await sendMessageSlack("channel:freddy-reports", "Hello", {
      client,
      token: "xoxb-test",
    });

    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "freddy-reports",
      is_private: false,
    });
    expect(client.conversations.list).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C_EXISTING",
      text: "Hello",
      thread_ts: undefined,
    });
    expect(result.channelId).toBe("C_EXISTING");
  });
});
