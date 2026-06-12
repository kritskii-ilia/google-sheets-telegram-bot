import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { TelegramApi } from "./telegram/api.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const telegram = new TelegramApi({ token: config.telegram.token, logger });
  const me = await telegram.getMe();
  console.log(JSON.stringify({
    ok: true,
    bot: {
      id: me.id,
      username: me.username,
    },
    google: {
      folderId: config.google.folderId,
      serviceAccountPath: config.google.serviceAccountPath,
      oauthClientPath: config.google.oauthClientPath,
      oauthTokensPath: config.google.oauthTokensPath,
    },
    ai: {
      defaultExecutor: config.ai.defaultExecutor,
      codexModel: config.ai.codexModel,
      codexWorkdir: config.ai.codexWorkdir,
    },
    allowlist: config.telegram.allowedChatIds,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});
