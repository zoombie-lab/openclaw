import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  toNormalizedUsage,
  wrapStreamFnWithTransportUsage,
} from "./pi-embedded-runner/run/attempt.js";

class FakeAssistantEventStream {
  readonly events: unknown[] = [];
  endedWith: unknown;

  push(event: unknown) {
    this.events.push(event);
  }

  end(result?: unknown) {
    this.endedWith = result;
  }
}

describe("wrapStreamFnWithTransportUsage", () => {
  it("captures usage from terminal stream events", () => {
    const usageTotals = createUsageAccumulator();
    const stream = new FakeAssistantEventStream();
    const wrapped = wrapStreamFnWithTransportUsage(() => stream, usageTotals);

    const returned = wrapped();
    expect(returned).toBe(stream);

    stream.push({
      type: "done",
      reason: "stop",
      message: {
        usage: {
          input: 10,
          output: 4,
          cacheRead: 6,
          cacheWrite: 2,
          totalTokens: 22,
        },
      },
    });
    stream.end();

    expect(toNormalizedUsage(usageTotals)).toEqual({
      input: 10,
      output: 4,
      cacheRead: 6,
      cacheWrite: 2,
      total: 22,
    });
  });

  it("captures usage from end(result) when no terminal event was pushed", () => {
    const usageTotals = createUsageAccumulator();
    const stream = new FakeAssistantEventStream();
    const wrapped = wrapStreamFnWithTransportUsage(() => stream, usageTotals);

    wrapped();
    stream.end({
      usage: {
        input: 8,
        output: 3,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 16,
      },
    });

    expect(toNormalizedUsage(usageTotals)).toEqual({
      input: 8,
      output: 3,
      cacheRead: 5,
      total: 16,
    });
  });
});
