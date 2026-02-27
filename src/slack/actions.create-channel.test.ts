import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { createSlackChannel } from "./actions.js";

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

function createClient() {
  return {
    conversations: {
      create: vi.fn(async () => ({ channel: { id: "C_NEW", name: "freddy-reports" } })),
      list: vi.fn(async () => ({
        channels: [],
        response_metadata: { next_cursor: "" },
      })),
    },
  } as unknown as WebClient & {
    conversations: {
      create: ReturnType<typeof vi.fn>;
      list: ReturnType<typeof vi.fn>;
    };
  };
}

describe("createSlackChannel", () => {
  it("creates a new channel when the name is available", async () => {
    const client = createClient();

    const result = await createSlackChannel("Freddy Reports", {
      client,
      token: "xoxb-test",
    });

    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "freddy-reports",
      is_private: false,
    });
    expect(client.conversations.list).not.toHaveBeenCalled();
    expect(result).toEqual({
      channelId: "C_NEW",
      name: "freddy-reports",
      isPrivate: false,
      created: true,
    });
  });

  it("reuses an existing unarchived channel when name is taken", async () => {
    const client = createClient();
    client.conversations.create.mockRejectedValueOnce({ data: { error: "name_taken" } });
    client.conversations.list.mockResolvedValueOnce({
      channels: [{ id: "C_EXISTING", name: "freddy-reports", is_archived: false }],
      response_metadata: { next_cursor: "" },
    });

    const result = await createSlackChannel("freddy-reports", {
      client,
      token: "xoxb-test",
    });

    expect(client.conversations.list).toHaveBeenCalledWith({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor: undefined,
    });
    expect(result).toEqual({
      channelId: "C_EXISTING",
      name: "freddy-reports",
      isPrivate: false,
      created: false,
    });
  });

  it("throws when name is taken only by an archived channel", async () => {
    const client = createClient();
    const err = { data: { error: "name_taken" } };
    client.conversations.create.mockRejectedValueOnce(err);
    client.conversations.list.mockResolvedValueOnce({
      channels: [{ id: "C_ARCHIVED", name: "freddy-reports", is_archived: true }],
      response_metadata: { next_cursor: "" },
    });

    await expect(
      createSlackChannel("freddy-reports", {
        client,
        token: "xoxb-test",
      }),
    ).rejects.toBe(err);
  });
});
