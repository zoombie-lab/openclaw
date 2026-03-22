import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanStaleLockFiles = vi.fn(async () => ({ locks: [], cleaned: [] }));
const startBrowserControlServerIfEnabled = vi.fn(async () => null);
const loadInternalHooks = vi.fn(async () => 0);
const clearInternalHooks = vi.fn();
const createInternalHookEvent = vi.fn();
const triggerInternalHook = vi.fn(async () => undefined);
const startPluginServices = vi.fn(async () => null);
const shouldWakeFromRestartSentinel = vi.fn(() => false);
const scheduleRestartSentinelWake = vi.fn(async () => undefined);

vi.mock("../agents/session-write-lock.js", () => ({
  cleanStaleLockFiles: (params: unknown) => cleanStaleLockFiles(params),
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled: () => startBrowserControlServerIfEnabled(),
}));

vi.mock("../hooks/loader.js", () => ({
  loadInternalHooks: (...args: unknown[]) => loadInternalHooks(...args),
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  clearInternalHooks: () => clearInternalHooks(),
  createInternalHookEvent: (...args: unknown[]) => createInternalHookEvent(...args),
  triggerInternalHook: (...args: unknown[]) => triggerInternalHook(...args),
}));

vi.mock("../plugins/services.js", () => ({
  startPluginServices: (...args: unknown[]) => startPluginServices(...args),
}));

vi.mock("./server-restart-sentinel.js", () => ({
  shouldWakeFromRestartSentinel: () => shouldWakeFromRestartSentinel(),
  scheduleRestartSentinelWake: (...args: unknown[]) => scheduleRestartSentinelWake(...args),
}));

describe("startGatewaySidecars", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
  const originalSkipGmail = process.env.OPENCLAW_SKIP_GMAIL_WATCHER;

  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
    process.env.OPENCLAW_SKIP_CHANNELS = originalSkipChannels;
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = originalSkipGmail;
    vi.clearAllMocks();
  });

  it("cleans stale locks in history transcript directories on startup", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-"));
    const sessionDir = path.join(stateDir, "agents", "main", "sessions");
    const historyDir = path.join(stateDir, "workspace", "history", "slack", "dm-alice");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(historyDir, { recursive: true });

    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";

    try {
      vi.resetModules();
      const { startGatewaySidecars } = await import("./server-startup.js");
      await startGatewaySidecars({
        cfg: {},
        pluginRegistry: {} as never,
        defaultWorkspaceDir: stateDir,
        deps: {} as never,
        startChannels: vi.fn(async () => undefined),
        log: { warn: vi.fn() },
        logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logChannels: { info: vi.fn(), error: vi.fn() },
        logBrowser: { error: vi.fn() },
      });

      const cleanedDirs = cleanStaleLockFiles.mock.calls.map(
        ([params]) => (params as { sessionsDir: string }).sessionsDir,
      );
      expect(cleanedDirs).toContain(sessionDir);
      expect(cleanedDirs).toContain(historyDir);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
