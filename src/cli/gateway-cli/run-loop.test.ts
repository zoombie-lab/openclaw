import { describe, expect, it, vi } from "vitest";

const acquireGatewayLock = vi.fn(async () => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const scheduleGatewaySigusr1Restart = vi.fn((_opts?: { delayMs?: number; reason?: string }) => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR1" as const,
  delayMs: 0,
  mode: "emit" as const,
}));
const getTotalQueueSize = vi.fn(() => 0);
const markGatewayDraining = vi.fn();
const waitForActiveTasks = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const resetAllLanes = vi.fn();
const abortEmbeddedPiRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting" }) => false,
);
const getActiveEmbeddedRunCount = vi.fn(() => 0);
const waitForActiveEmbeddedRuns = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const gatewayLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: () => acquireGatewayLock(),
}));

vi.mock("../../infra/restart.js", () => ({
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
  scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
    scheduleGatewaySigusr1Restart(opts),
}));

vi.mock("../../process/command-queue.js", () => ({
  getTotalQueueSize: () => getTotalQueueSize(),
  markGatewayDraining: () => markGatewayDraining(),
  waitForActiveTasks: (timeoutMs: number) => waitForActiveTasks(timeoutMs),
  resetAllLanes: () => resetAllLanes(),
}));

vi.mock("../../agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (sessionId?: string, opts?: { mode?: "all" | "compacting" }) =>
    abortEmbeddedPiRun(sessionId, opts),
  getActiveEmbeddedRunCount: () => getActiveEmbeddedRunCount(),
  waitForActiveEmbeddedRuns: (timeoutMs: number) => waitForActiveEmbeddedRuns(timeoutMs),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => gatewayLog,
}));

const LOOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
type LoopSignal = (typeof LOOP_SIGNALS)[number];

function removeNewSignalListeners(signal: LoopSignal, existing: Set<(...args: unknown[]) => void>) {
  for (const listener of process.listeners(signal)) {
    const fn = listener as (...args: unknown[]) => void;
    if (!existing.has(fn)) {
      process.removeListener(signal, fn);
    }
  }
}

function addedSignalListener(
  signal: LoopSignal,
  existing: Set<(...args: unknown[]) => void>,
): (() => void) | null {
  const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
  for (let i = listeners.length - 1; i >= 0; i -= 1) {
    const listener = listeners[i];
    if (listener && !existing.has(listener)) {
      return listener as () => void;
    }
  }
  return null;
}

async function withIsolatedSignals(
  run: (helpers: { captureSignal: (signal: LoopSignal) => () => void }) => Promise<void>,
) {
  const existingListeners = Object.fromEntries(
    LOOP_SIGNALS.map((signal) => [
      signal,
      new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>),
    ]),
  ) as Record<LoopSignal, Set<(...args: unknown[]) => void>>;
  const captureSignal = (signal: LoopSignal) => {
    const listener = addedSignalListener(signal, existingListeners[signal]);
    if (!listener) {
      throw new Error(`expected new ${signal} listener`);
    }
    return () => listener();
  };
  try {
    await run({ captureSignal });
  } finally {
    for (const signal of LOOP_SIGNALS) {
      removeNewSignalListeners(signal, existingListeners[signal]);
    }
  }
}

function createRuntimeWithExitSignal() {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      resolveExit(code);
    }),
  };
  return { runtime, exited };
}

function createSignaledStart(close: (...args: unknown[]) => Promise<void>) {
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn(async () => {
    resolveStarted?.();
    return { close };
  });
  return { start, started };
}

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    exit: (code: number) => void;
  };
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createSignaledLoopHarness() {
  const close = vi.fn(async () => {});
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal();
  const { loopPromise } = await runLoopWithStart({ start, runtime });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

describe("runGatewayLoop", () => {
  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("drains active tasks and runs before restart, then resets lanes for the new iteration", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      getTotalQueueSize.mockReturnValueOnce(3).mockReturnValueOnce(0);
      getActiveEmbeddedRunCount.mockReturnValueOnce(1).mockReturnValueOnce(0);

      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const { runtime } = createRuntimeWithExitSignal();

      const start = vi
        .fn()
        .mockImplementationOnce(async () => ({ close: closeFirst }))
        .mockImplementationOnce(async () => ({ close: closeSecond }));

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      const sigusr1 = captureSignal("SIGUSR1");
      sigusr1();

      await vi.waitFor(() => {
        expect(start).toHaveBeenCalledTimes(2);
      });

      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
      expect(waitForActiveTasks).toHaveBeenCalledWith(90_000);
      expect(waitForActiveEmbeddedRuns).toHaveBeenCalledWith(90_000);
      expect(abortEmbeddedPiRun).toHaveBeenCalledWith(undefined, { mode: "compacting" });
      expect(closeFirst).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(resetAllLanes).toHaveBeenCalledTimes(1);
    });
  });

  it("routes external SIGUSR1 through the restart scheduler", async () => {
    vi.clearAllMocks();
    consumeGatewaySigusr1RestartAuthorization.mockReturnValueOnce(false);
    isGatewaySigusr1RestartExternallyAllowed.mockReturnValueOnce(true);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close } = await createSignaledLoopHarness();
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
        delayMs: 0,
        reason: "SIGUSR1",
      });
      expect(close).not.toHaveBeenCalled();
    });
  });
});
