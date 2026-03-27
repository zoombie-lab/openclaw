import { describe, expect, it } from "vitest";
import { isOpenClawPreflightError } from "../openclaw-preflight-error.js";
import { applyBeforeAgentStartResult } from "./before-agent-start.js";

describe("applyBeforeAgentStartResult", () => {
  it("prepends context when provided by hooks", () => {
    const result = applyBeforeAgentStartResult({
      prompt: "Run the task",
      hookResult: {
        prependContext: "Context from plugin",
      },
    });

    expect(result.promptError).toBeNull();
    expect(result.effectivePrompt).toBe("Context from plugin\n\nRun the task");
  });

  it("returns a preflight error when hooks cancel the run", () => {
    const result = applyBeforeAgentStartResult({
      prompt: "Run the task",
      hookResult: {
        cancel: true,
        error: "Freddy token limit reached for the current billing period.",
      },
    });

    expect(result.effectivePrompt).toBe("Run the task");
    expect(isOpenClawPreflightError(result.promptError)).toBe(true);
    expect((result.promptError as Error).message).toBe(
      "Freddy token limit reached for the current billing period.",
    );
  });
});
