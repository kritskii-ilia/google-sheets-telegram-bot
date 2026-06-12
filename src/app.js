import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { TelegramApi } from "./telegram/api.js";
import { configureTelegram, runPoller } from "./telegram/poller.js";
import { createExecutorRegistry } from "./executors/index.js";
import { StateStore } from "./state/store.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const telegram = new TelegramApi({ token: config.telegram.token, logger });
  const botIdentity = await telegram.getMe();
  const state = new StateStore(config.projectRoot);
  const executors = createExecutorRegistry(config);

  const app = {
    config,
    logger,
    telegram,
    botIdentity,
    state,
    executors,
  };

  logger.info("bot startup", {
    username: botIdentity.username,
    allowedChatIds: config.telegram.allowedChatIds,
    googleFolderId: config.google.folderId,
    defaultExecutor: config.ai.defaultExecutor,
  });

  await configureTelegram(app);
  await runPoller(app);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
