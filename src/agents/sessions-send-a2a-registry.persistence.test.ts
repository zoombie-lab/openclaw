import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

describe("sessions_send a2a registry persistence", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    callGatewayMock.mockReset();
    vi.resetModules();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("retries callback delivery after restart when previous attempt failed", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-a2a-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const registryPath = path.join(tempStateDir, "a2a", "runs.json");
    const persisted = {
      version: 1,
      runs: {
        "run-1": {
          runId: "run-1",
          targetSessionKey: "agent:revenue:worker",
          displayKey: "agent:revenue:worker",
          callbackSessionKey: "agent:main:main",
          requesterSessionKey: "agent:main:main",
          requesterChannel: "webchat",
          createdAt: 1,
          completion: { status: "error", error: "boom" },
        },
      },
    };
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");

    let sendAttempts = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { message?: string } };
      if (request.method === "agent") {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("temporary failure");
        }
        return { runId: "callback-run", status: "accepted" };
      }
      return { status: "ok" };
    });

    vi.resetModules();
    const mod1 = await import("./sessions-send-a2a-registry.js");
    mod1.initSessionsSendA2ARegistry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterFirst = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { callbackCompletedAt?: number; synthesisCompletedAt?: number }>;
    };
    expect(afterFirst.runs["run-1"].callbackCompletedAt).toBeUndefined();
    expect(afterFirst.runs["run-1"].synthesisCompletedAt).toBeUndefined();

    vi.resetModules();
    const mod2 = await import("./sessions-send-a2a-registry.js");
    mod2.initSessionsSendA2ARegistry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterSecond = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      runs: Record<string, { callbackCompletedAt?: number; synthesisCompletedAt?: number }>;
    };
    expect(afterSecond.runs["run-1"].callbackCompletedAt).toBeDefined();
    expect(afterSecond.runs["run-1"].synthesisCompletedAt).toBeDefined();
    expect(
      callGatewayMock.mock.calls.some((call) => {
        const req = call[0] as { method?: string; params?: { message?: string } };
        return req.method === "agent" && (req.params?.message ?? "").includes("TASK_COMPLETE");
      }),
    ).toBe(true);
  });
});
