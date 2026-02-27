import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createSlackActions } from "./slack.actions.js";

const handleSlackAction = vi.fn(async () => ({ details: { ok: true } }));

vi.mock("../../agents/tools/slack-actions.js", () => ({
  handleSlackAction: (...args: unknown[]) => handleSlackAction(...args),
}));

describe("slack actions adapter", () => {
  it("lists channel-create when message actions are enabled", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "tok",
          actions: { messages: true },
        },
      },
    } as OpenClawConfig;
    const actions = createSlackActions("slack");
    const listed = actions.listActions({ cfg });
    expect(listed).toContain("channel-create");
  });

  it("forwards threadId for read", async () => {
    handleSlackAction.mockClear();
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "read",
      cfg,
      params: {
        channelId: "C1",
        threadId: "171234.567",
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "readMessages",
      channelId: "C1",
      threadId: "171234.567",
    });
  });

  it("forwards create channel params including DM fallback", async () => {
    handleSlackAction.mockClear();
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "channel-create",
      cfg,
      params: {
        name: "Freddy-Reports",
        isPrivate: "false",
        fallbackTo: "user:U123456",
        fallbackMessage: "Channel creation failed; posting here.",
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "createChannel",
      name: "Freddy-Reports",
      isPrivate: false,
      fallbackTo: "user:U123456",
      fallbackMessage: "Channel creation failed; posting here.",
    });
  });

  it("passes tool context for channel-create", async () => {
    handleSlackAction.mockClear();
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");
    const toolContext = {
      currentChannelId: "D_APP",
      currentThreadTs: "171234.567",
      replyToMode: "all" as const,
      hasRepliedRef: { value: false },
    };

    await actions.handleAction?.({
      channel: "slack",
      action: "channel-create",
      cfg,
      toolContext,
      params: {
        name: "Freddy-Reports",
      },
    });

    const [, , passedContext] = handleSlackAction.mock.calls[0] ?? [];
    expect(passedContext).toEqual(toolContext);
  });
});
