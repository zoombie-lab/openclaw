import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { runOpenClawPreflight } from "./src/preflight.js";
import {
  createOpsManagerTelemetryService,
  createOpsManagerTelemetryUsageAccumulator,
} from "./src/service.js";

const plugin = {
  id: "ops-manager-telemetry",
  name: "Ops Manager Telemetry",
  description: "Forward model usage events to ops-manager telemetry ingestion",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const usageAccumulator = createOpsManagerTelemetryUsageAccumulator();
    api.on("before_agent_start", async () => {
      return await runOpenClawPreflight({
        logger: api.logger,
      });
    });
    api.on("tool_result_persist", (event, ctx) => {
      usageAccumulator.recordToolResultUsage(event, ctx);
    });
    api.registerService(createOpsManagerTelemetryService(usageAccumulator));
  },
};

export default plugin;
