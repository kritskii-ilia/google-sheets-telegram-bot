import { getExecutor } from "./executors/index.js";
import { executeAdvanceDentalAvTask, matchesAdvanceDentalAvTask } from "./custom-tasks/advance-dental-av.js";
import { executeMismatchAnalysisTask, matchesMismatchAnalysisTask } from "./custom-tasks/analyze-mismatch.js";

async function maybeSendProgress(app, message, promise) {
  let progressSent = false;
  const timer = setTimeout(async () => {
    try {
      progressSent = true;
      await app.telegram.sendMessage(message.chat.id, "Принял. Обрабатываю запрос.", message.message_id);
    } catch (err) {
      app.logger.warn("progress message failed", { error: String(err) });
    }
  }, 1500);

  try {
    const result = await promise;
    clearTimeout(timer);
    return { result, progressSent };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export async function handleNaturalLanguageTask(app, message) {
  const memory = app.state.getChatMemory(message.chat.id);
  const messageText = String(message.text || "").trim();
  const { name, executor } = getExecutor(app, "codex");

  let replyText = "";
  try {
    const { result } = await maybeSendProgress(
      app,
      message,
      executor.generateReply(app, {
        chatId: String(message.chat.id),
        userId: String(message.from?.id || ""),
        messageText,
        memory,
      }),
    );
    replyText = String(result || "").trim();
  } catch (err) {
    app.logger.error("codex direct reply failed", { error: String(err) });
    await app.telegram.sendMessage(
      message.chat.id,
      "Не получилось быстро обработать запрос в Codex. Попробуй повторить сообщение ещё раз.",
      message.message_id,
    );
    return;
  }

  app.logger.info("codex direct reply completed", {
    executor: name,
    chatId: String(message.chat.id),
  });

  app.state.updateChatMemory(message.chat.id, {
    lastTask: "dialog",
    lastDialogTask: messageText,
    lastDialogReply: replyText,
  });

  if (replyText) {
    await app.telegram.sendMessage(message.chat.id, replyText, message.message_id);
  }

  try {
    if (matchesMismatchAnalysisTask(messageText, memory)) {
      await executeMismatchAnalysisTask(app, message);
      return;
    }
    if (matchesAdvanceDentalAvTask(messageText)) {
      await executeAdvanceDentalAvTask(app, message, {
        tableName: String(memory.lastTableName || "").trim(),
        sheetName: String(memory.lastSheetName || "Лист1").trim(),
      });
      return;
    }
  } catch (err) {
    app.logger.error("post-reply task failed", { error: String(err) });
    await app.telegram.sendMessage(
      message.chat.id,
      `Не получилось выполнить действие после ответа: ${err instanceof Error ? err.message : String(err)}`,
      message.message_id,
    );
  }
}
