import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createOpenCodeAdapter } from "./opencode.js";
import { OpenCodeEventSupervisor } from "./supervisor.js";

const config = loadConfig();
const adapter = createOpenCodeAdapter(config);
const app = await buildApp({ config, adapter });
const supervisor = new OpenCodeEventSupervisor(app.cadirService, adapter, config);
supervisor.start();

const shutdown = async (): Promise<void> => {
  await supervisor.stop();
  await app.close();
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
