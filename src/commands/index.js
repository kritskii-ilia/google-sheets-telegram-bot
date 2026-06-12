import { resolveByNameInTree, resolveFolderPath } from "../google/drive.js";
import { buildColumnRange, buildRectRange, normalizeSpacesInRange, syncValuesByName } from "../google/sheets.js";

function parseParts(rawArgs) {
  return String(rawArgs || "")
    .split("|")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

async function handleStart(app, message) {
  const name = app.botIdentity?.username ? `@${app.botIdentity.username}` : "бот";
  const text =
    `${name} готов.\n` +
    "Можно писать обычным текстом: например, 'сделай как в прошлый раз по зарплате'.\n" +
    "Команды:\n" +
    "/help\n" +
    "/health\n" +
    "/gfind <название таблицы>\n" +
    "/gsalarysync <таблица> [| <лист>] [| <startRow>] [| <endRow>]\n" +
    "/gsalarysync <папка > подпапка> | <таблица> | <лист> [| <startRow>] [| <endRow>]";
  await app.telegram.sendMessage(message.chat.id, text, message.message_id);
}

async function handleHelp(app, message) {
  return handleStart(app, message);
}

async function handleHealth(app, message) {
  const me = app.botIdentity || (await app.telegram.getMe());
  const mode = app.config.google.serviceAccountPath ? "service_account_with_oauth_fallback" : "oauth_only";
  const text =
    "Статус:\n" +
    `Бот: @${me.username}\n` +
    `Executor: ${app.config.ai.defaultExecutor} (${app.config.ai.codexModel})\n` +
    `Google auth: ${mode}\n` +
    `Sandbox folder: ${app.config.google.folderId}\n` +
    `Allowlist IDs: ${app.config.telegram.allowedChatIds.join(", ")}`;
  await app.telegram.sendMessage(message.chat.id, text, message.message_id);
}

async function handleFind(app, message, rawArgs) {
  const name = String(rawArgs || "").trim();
  if (!name) {
    await app.telegram.sendMessage(message.chat.id, "Использование: /gfind <название таблицы>", message.message_id);
    return;
  }
  const resolved = await resolveByNameInTree(app, {
    name,
    mimePrefix: "application/vnd.google-apps.spreadsheet",
    startParentId: app.config.google.folderId,
  });
  if (resolved.file) {
    const text =
      `Найдена таблица:\n` +
      `Название: ${resolved.file.name}\n` +
      `ID: ${resolved.file.id}\n` +
      `Ссылка: ${resolved.file.webViewLink || "(нет ссылки)"}`;
    await app.telegram.sendMessage(message.chat.id, text, message.message_id);
    app.state.updateChatMemory(message.chat.id, {
      lastTask: "gfind",
      lastTableName: resolved.file.name,
      lastSpreadsheetId: resolved.file.id,
    });
    return;
  }
  if (resolved.ambiguous) {
    const options = resolved.options
      .slice(0, 8)
      .map((item) => `- ${item.path ? `${item.path} | ` : ""}${item.name} (${item.id})`)
      .join("\n");
    await app.telegram.sendMessage(
      message.chat.id,
      `Найдено несколько таблиц, похожих на "${name}". Уточните путь.\n${options}`,
      message.message_id,
    );
    return;
  }
  await app.telegram.sendMessage(message.chat.id, `Таблица не найдена: ${name}`, message.message_id);
}

async function handleSalarySync(app, message, rawArgs) {
  const parts = parseParts(rawArgs);
  if (!parts.length) {
    const help =
      "Использование:\n" +
      "/gsalarysync <название таблицы> [| <лист>] [| <startRow>] [| <endRow>]\n" +
      "/gsalarysync <папка > подпапка> | <название таблицы> | <лист> [| <startRow>] [| <endRow>]";
    await app.telegram.sendMessage(message.chat.id, help, message.message_id);
    return;
  }

  const hasFolderPath = parts.length >= 3 && !/^\d+$/.test(String(parts[2] || "").trim());
  const folderPath = hasFolderPath ? String(parts[0] || "").trim() : "";
  const tableName = String(parts[hasFolderPath ? 1 : 0] || "").trim();
  const sheetName = String(parts[hasFolderPath ? 2 : 1] || "Лист3").trim();
  const startRow = Math.max(1, Number(parts[hasFolderPath ? 3 : 2] || 2));
  const endRow = Math.max(startRow, Number(parts[hasFolderPath ? 4 : 3] || 200));

  if (!tableName) {
    await app.telegram.sendMessage(message.chat.id, "Ошибка: нужно указать название таблицы.", message.message_id);
    return;
  }

  let searchParentId = app.config.google.folderId;
  let resolvedFolderPath = "";
  if (folderPath) {
    const folderResolved = await resolveFolderPath(app, folderPath);
    if (!folderResolved.folderId) {
      const text =
        folderResolved.error === "folder_path_ambiguous"
          ? `Путь к папке неоднозначен: ${folderPath}.`
          : `Папка не найдена: ${folderPath}${folderResolved.missingSegment ? ` (не найден сегмент "${folderResolved.missingSegment}")` : ""}`;
      await app.telegram.sendMessage(message.chat.id, text, message.message_id);
      return;
    }
    searchParentId = folderResolved.folderId;
    resolvedFolderPath = folderResolved.segments.join(" > ");
  }

  const resolved = folderPath
    ? await resolveByNameInTree(app, {
        name: tableName,
        mimePrefix: "application/vnd.google-apps.spreadsheet",
        startParentId: searchParentId,
        exactOnly: false,
      })
    : await resolveByNameInTree(app, {
        name: tableName,
        mimePrefix: "application/vnd.google-apps.spreadsheet",
        startParentId: app.config.google.folderId,
        exactOnly: false,
      });

  if (resolved.ambiguous) {
    const options = resolved.options
      .slice(0, 8)
      .map((item) => `- ${item.path ? `${item.path} | ` : ""}${item.name} (${item.id})`)
      .join("\n");
    await app.telegram.sendMessage(
      message.chat.id,
      `Найдено несколько таблиц, похожих на "${tableName}". Уточните путь.\n${options}`,
      message.message_id,
    );
    return;
  }

  if (!resolved.file) {
    await app.telegram.sendMessage(
      message.chat.id,
      `Таблица не найдена: ${tableName}\nМожно указать путь так: /gsalarysync Папка > Подпапка | Название таблицы | Лист3`,
      message.message_id,
    );
    return;
  }

  const cleaned = await normalizeSpacesInRange(
    app,
    resolved.file.id,
    buildRectRange(sheetName, "A", "I", startRow, endRow),
    sheetName,
    {
      preserveFormulas: true,
      replaceNbsp: true,
      collapseSpaces: true,
      trimSpaces: true,
    },
  );

  const result = await syncValuesByName(app, resolved.file.id, {
    targetNameRange: buildColumnRange(sheetName, "A", startRow, endRow),
    targetValueRange: buildColumnRange(sheetName, "B", startRow, endRow),
    sourceNameRange: buildColumnRange(sheetName, "H", startRow, endRow),
    sourceValueRange: buildColumnRange(sheetName, "I", startRow, endRow),
    normalize: true,
    insertUnmatched: true,
    alignInserted: true,
    insertedAlignment: "RIGHT",
  });

  const insertedPreview = result.insertedNames.length
    ? `\nНовые сотрудники: ${result.insertedNames.slice(0, 10).join(", ")}${result.insertedNames.length > 10 ? " ..." : ""}`
    : "";
  const text =
    `Готово: ${resolved.file.name} / ${sheetName}\n` +
    `${resolvedFolderPath ? `Путь: ${resolvedFolderPath}\n` : ""}` +
    `Нормализовано ячеек в A:I: ${cleaned.changedCells}\n` +
    `Сопоставлено: ${result.matched}\n` +
    `Добавлено новых: ${result.inserted}\n` +
    `Не найдено совпадений в целевом списке: ${result.unmatched}\n` +
    `Пропущено дублей в источнике: ${result.duplicateSourceNames}` +
    insertedPreview;
  await app.telegram.sendMessage(message.chat.id, text, message.message_id);
  app.state.updateChatMemory(message.chat.id, {
    lastTask: "gsalarysync",
    lastTableName: resolved.file.name,
    lastSheetName: sheetName,
    lastFolderPath: resolvedFolderPath || folderPath || "",
    lastSpreadsheetId: resolved.file.id,
  });
}

export async function runCommand(app, message, command, args) {
  if (command === "/start") return handleStart(app, message);
  if (command === "/help") return handleHelp(app, message);
  if (command === "/health") return handleHealth(app, message);
  if (command === "/gfind") {
    const result = await handleFind(app, message, args);
    const name = String(args || "").trim();
    if (name) {
      app.state.updateChatMemory(message.chat.id, {
        lastTask: "gfind",
        lastFindQuery: name,
      });
    }
    return result;
  }
  if (command === "/gsalarysync") return handleSalarySync(app, message, args);
  await app.telegram.sendMessage(message.chat.id, "Неизвестная команда. Используй /help.", message.message_id);
}

export async function dispatchCommand(app, message) {
  const text = String(message.text || "").trim();
  const [commandRaw, ...rest] = text.split(" ");
  const command = commandRaw.split("@")[0].toLowerCase();
  const args = rest.join(" ").trim();
  return runCommand(app, message, command, args);
}
