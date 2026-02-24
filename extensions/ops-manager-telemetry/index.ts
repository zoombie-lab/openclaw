import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createOpsManagerTelemetryService } from "./src/service.js";

const plugin = {
  id: "ops-manager-telemetry",
  name: "Ops Manager Telemetry",
  description: "Forward model usage events to ops-manager telemetry ingestion",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerService(createOpsManagerTelemetryService());
  },
};

export default plugin;
