import type { PluginHookBeforeAgentStartResult } from "../../plugins/hooks.js";
import { OpenClawPreflightError } from "../openclaw-preflight-error.js";

export function applyBeforeAgentStartResult(params: {
  prompt: string;
  hookResult?: PluginHookBeforeAgentStartResult;
}): {
  effectivePrompt: string;
  promptError: unknown | null;
} {
  const hookResult = params.hookResult;
  if (!hookResult) {
    return { effectivePrompt: params.prompt, promptError: null };
  }

  if (hookResult.cancel) {
    return {
      effectivePrompt: params.prompt,
      promptError: new OpenClawPreflightError(
        hookResult.error?.trim() || "Freddy run denied before execution.",
      ),
    };
  }

  if (hookResult.prependContext) {
    return {
      effectivePrompt: `${hookResult.prependContext}\n\n${params.prompt}`,
      promptError: null,
    };
  }

  return {
    effectivePrompt: params.prompt,
    promptError: null,
  };
}
