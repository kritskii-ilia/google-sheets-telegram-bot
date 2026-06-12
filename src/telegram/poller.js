import { sleep } from "../utils.js";
import { dispatchCommand } from "../commands/index.js";
import { handleNaturalLanguageTask } from "../router.js";

function isAllowed(app, message) {
  const chatId = String(message?.chat?.id || "");
  return app.config.telegram.allowedChatIds.includes(chatId);
}

export async function configureTelegram(app) {
  const commands = [
    { command: "help", description: "Список команд" },
    { command: "health", description: "Проверка статуса бота" },
    { command: "gfind", description: "Поиск таблицы по имени" },
    { command: "gsalarysync", description: "Синхронизация зарплат H:I -> A:B" },
  ];
  try {
    await app.telegram.setMyCommands(commands);
  } catch (err) {
    app.logger.warn("telegram setMyCommands failed", { error: String(err) });
  }
}

async function handleMessage(app, message) {
  if (!isAllowed(app, message)) {
    await app.telegram.sendMessage(message.chat.id, "Доступ запрещён.", message.message_id);
    return;
  }
  if (!String(message.text || "").trim()) {
    await app.telegram.sendMessage(message.chat.id, "Пока поддерживаются текстовые команды. Используй /help.", message.message_id);
    return;
  }
  try {
    if (!String(message.text || "").trim().startsWith("/")) {
      await handleNaturalLanguageTask(app, message);
      return;
    }
    await dispatchCommand(app, message);
  } catch (err) {
    app.logger.error("command failed", { error: String(err) });
    await app.telegram.sendMessage(
      message.chat.id,
      `Ошибка: ${err instanceof Error ? err.message : String(err)}`,
      message.message_id,
    );
  }
}

export async function runPoller(app) {
  let offset = 0;
  app.logger.info("telegram poller started");
  for (;;) {
    try {
      const updates = await app.telegram.getUpdates(offset, app.config.telegram.pollTimeoutSeconds);
      for (const update of updates) {
        offset = Number(update.update_id || 0) + 1;
        if (update.message) {
          await handleMessage(app, update.message);
        }
      }
    } catch (err) {
      app.logger.error("telegram polling error", { error: String(err) });
      await sleep(3000);
    }
  }
}
