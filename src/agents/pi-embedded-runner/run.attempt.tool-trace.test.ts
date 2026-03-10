import fsSync from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildToolTraceTranscriptEntry,
  flushPendingToolResultsAndAppendToolTrace,
} from "./run/attempt.js";

describe("tool trace transcript append", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes pending synthetic tool results before appending the tool trace", () => {
    const calls: string[] = [];
    const appendSpy = vi.spyOn(fsSync, "appendFileSync").mockImplementation(() => {
      calls.push("append");
    });

    const traceEntry = buildToolTraceTranscriptEntry({
      runId: "run-1",
      sessionId: "session-1",
      timestamp: new Date("2026-03-10T00:00:00.000Z"),
      toolTrace: [
        {
          tool: "read",
          toolCallId: "tool-1",
          startMs: 100,
          endMs: 175,
          durationMs: 75,
        },
      ],
    });

    flushPendingToolResultsAndAppendToolTrace({
      sessionFile: "/tmp/session.jsonl",
      traceEntry,
      sessionManager: {
        flushPendingToolResults: () => {
          calls.push("flush");
        },
      } as never,
    });

    expect(calls).toEqual(["flush", "append"]);
    expect(appendSpy).toHaveBeenCalledWith(
      "/tmp/session.jsonl",
      `${JSON.stringify(traceEntry)}\n`,
      "utf-8",
    );
  });
});
