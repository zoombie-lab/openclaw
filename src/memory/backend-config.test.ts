import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSessionHistoryDir } from "../config/sessions/paths.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("resolveMemoryBackendConfig", () => {
  it("defaults to builtin backend when config missing", () => {
    const cfg = { agents: { defaults: { workspace: "/tmp/memory-test" } } } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("builtin");
    expect(resolved.citations).toBe("auto");
    expect(resolved.qmd).toBeUndefined();
  });

  it("resolves qmd backend with default collections", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {},
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.backend).toBe("qmd");
    expect(resolved.qmd?.collections.length).toBeGreaterThanOrEqual(3);
    expect(resolved.qmd?.command).toBe("qmd");
    expect(resolved.qmd?.update.intervalMs).toBeGreaterThan(0);
    expect(resolved.qmd?.update.waitForBootSync).toBe(false);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(30_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(120_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(120_000);
  });

  it("parses quoted qmd command paths", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          command: '"/Applications/QMD Tools/qmd" --flag',
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.command).toBe("/Applications/QMD Tools/qmd");
  });

  it("resolves custom paths relative to workspace", () => {
    const cfg = {
      agents: {
        defaults: { workspace: "/workspace/root" },
        list: [{ id: "main", workspace: "/workspace/root" }],
      },
      memory: {
        backend: "qmd",
        qmd: {
          paths: [
            {
              path: "notes",
              name: "custom-notes",
              pattern: "**/*.md",
            },
          ],
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    const custom = resolved.qmd?.collections.find((c) => c.name.startsWith("custom-notes"));
    expect(custom).toBeDefined();
    const workspaceRoot = resolveAgentWorkspaceDir(cfg, "main");
    expect(custom?.path).toBe(path.resolve(workspaceRoot, "notes"));
  });

  it("resolves qmd update timeout overrides", () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/memory-test" } },
      memory: {
        backend: "qmd",
        qmd: {
          update: {
            waitForBootSync: true,
            commandTimeoutMs: 12_000,
            updateTimeoutMs: 480_000,
            embedTimeoutMs: 360_000,
          },
        },
      },
    } as OpenClawConfig;
    const resolved = resolveMemoryBackendConfig({ cfg, agentId: "main" });
    expect(resolved.qmd?.update.waitForBootSync).toBe(true);
    expect(resolved.qmd?.update.commandTimeoutMs).toBe(12_000);
    expect(resolved.qmd?.update.updateTimeoutMs).toBe(480_000);
    expect(resolved.qmd?.update.embedTimeoutMs).toBe(360_000);
  });

  it("uses shared workspace history collection for every agent", () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
    try {
      const cfg = {
        agents: {
          list: [{ id: "main", default: true }, { id: "inventory" }],
        },
        memory: {
          backend: "qmd",
          qmd: {},
        },
      } as OpenClawConfig;

      const main = resolveMemoryBackendConfig({ cfg, agentId: "main" });
      const inventory = resolveMemoryBackendConfig({ cfg, agentId: "inventory" });
      const mainHistory = main.qmd?.collections.find((c) => c.name === "history-logs");
      const inventoryHistory = inventory.qmd?.collections.find((c) => c.name === "history-logs");
      const expected = resolveSessionHistoryDir();

      expect(mainHistory?.path).toBe(expected);
      expect(inventoryHistory?.path).toBe(expected);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prev;
      }
    }
  });
});
