import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { registerSessionsSendA2ARun } from "../sessions-send-a2a-registry.js";

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  callbackSessionKey?: string;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  waitRunId?: string;
  sourceMessage?: string;
  callbackMode?: "each" | "all-complete";
}) {
  registerSessionsSendA2ARun({
    targetSessionKey: params.targetSessionKey,
    displayKey: params.displayKey,
    callbackSessionKey: params.callbackSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    runId: params.waitRunId,
    sourceMessage: params.sourceMessage,
    callbackMode: params.callbackMode,
  });
}
