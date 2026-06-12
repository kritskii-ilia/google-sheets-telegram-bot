import { resolveByNameInTree } from "../google/drive.js";
import { buildColumnRange, readRange, updateRange, insertRows } from "../google/sheets.js";
import { compareRuNames, normalizePersonKey } from "../utils.js";
import { gjson } from "../google/auth.js";

function parseTableName(messageText, fallback = "") {
  const text = String(messageText || "");
  const match = text.match(/таблиц[еы]\s+(.+?)(?:[\.\n]|$)/i);
  return String(match?.[1] || fallback || "").trim().replace(/^["«]/, "").replace(/["»]$/, "");
}

export function matchesAdvanceDentalAvTask(messageText) {
  const text = String(messageText || "").toLowerCase();
  return text.includes("авансов") && text.includes("дентал ав") && text.includes("лист1");
}

function sumifFormula(sourceSheet, row) {
  return `=SUMIF('${sourceSheet}'!A:A;A${row};'${sourceSheet}'!B:B)`;
}

function sumFormula(col, startRow, endRow) {
  return `=SUM(${col}${startRow}:${col}${endRow})`;
}

function sourceTotalFormula(sourceSheet) {
  return `='${sourceSheet}'!B80`;
}

function diffFormula(leftCol, leftRow, rightCol, rightRow) {
  return `=${leftCol}${leftRow}-${rightCol}${rightRow}`;
}

function normalizeName(value) {
  return normalizePersonKey(String(value || "").trim());
}

function formatAmount(value) {
  if (typeof value === "number") {
    return value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value ?? "");
}

async function readNameRowsWithColor(app, spreadsheetId, sheetName, startRow = 2, endRow = 120) {
  const range = `'${sheetName}'!A${startRow}:A${endRow}`;
  const fields = "sheets(data(rowData(values(formattedValue,effectiveFormat(textFormat(foregroundColor))))))";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${encodeURIComponent(fields)}`;
  const data = await gjson(app, url, {
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  });
  const rows = data.sheets?.[0]?.data?.[0]?.rowData || [];
  return rows.map((row, index) => {
    const cell = row?.values?.[0] || {};
    const text = String(cell.formattedValue || "").trim();
    const fg = cell.effectiveFormat?.textFormat?.foregroundColor || {};
    const isRed = (fg.red || 0) > 0.7 && (fg.green || 0) < 0.35 && (fg.blue || 0) < 0.35;
    return { row: startRow + index, text, isRed };
  });
}

export async function executeAdvanceDentalAvTask(app, message, intent = {}) {
  const messageText = String(message.text || "");
  const tableName = String(intent.tableName || parseTableName(messageText, app.state.getChatMemory(message.chat.id)?.lastTableName || "")).trim();
  const targetSheet = String(intent.sheetName || "Лист1").trim();
  const sourceSheet = "Дентал АВ";
  const secondHalfSheet = "Дентал ЗП";

  if (!tableName) {
    await app.telegram.sendMessage(message.chat.id, "Не смог определить название таблицы для выполнения задачи.", message.message_id);
    return;
  }

  const resolved = await resolveByNameInTree(app, {
    name: tableName,
    mimePrefix: "application/vnd.google-apps.spreadsheet",
    startParentId: app.config.google.folderId,
    exactOnly: false,
  });
  if (!resolved.file) {
    await app.telegram.sendMessage(message.chat.id, `Не нашёл таблицу: ${tableName}`, message.message_id);
    return;
  }

  await app.telegram.sendMessage(
    message.chat.id,
    `Начинаю выполнение задачи в таблице ${resolved.file.name}, лист ${targetSheet}. После завершения пришлю отчёт.`,
    message.message_id,
  );

  const spreadsheetId = resolved.file.id;
  const coloredRows = await readNameRowsWithColor(app, spreadsheetId, targetSheet, 2, 120);
  const redBlockRows = coloredRows.filter((item) => item.text && item.isRed);
  if (!redBlockRows.length) {
    throw new Error("Не удалось определить красный блок на листе Лист1.");
  }
  const currentRedStart = redBlockRows[0].row;
  const currentRedEnd = redBlockRows[redBlockRows.length - 1].row;
  const mainNameRows = coloredRows
    .filter((item) => item.row < currentRedStart && item.text)
    .map((item) => item.text);
  const redNames = redBlockRows.map((item) => item.text);
  const sourceRows = (await readRange(app, spreadsheetId, "A6:B76", sourceSheet, { valueRenderOption: "UNFORMATTED_VALUE" })).values || [];
  const mainNames = mainNameRows;

  const sourceMap = new Map();
  for (const row of sourceRows) {
    const name = String(row?.[0] || "").trim();
    const amount = row?.[1];
    if (!name || amount === undefined || amount === null || amount === "") continue;
    const key = normalizeName(name);
    if (!key) continue;
    sourceMap.set(key, (sourceMap.get(key) || 0) + Number(amount || 0));
  }

  const mainSet = new Set(mainNames.map((item) => normalizeName(item)));
  const missingMain = [];
  for (const [key, amount] of sourceMap.entries()) {
    if (mainSet.has(key)) continue;
    const fromRed = redNames.find((name) => normalizeName(name) === key);
    if (fromRed) {
      missingMain.push({ name: fromRed, amount });
    }
  }

  const insertionCount = missingMain.length;
  if (insertionCount > 0) {
    await insertRows(app, spreadsheetId, targetSheet, currentRedStart, insertionCount);
  }

  const mainCombined = [...mainNames, ...missingMain.map((item) => item.name)].sort((left, right) => compareRuNames(left, right));
  const mainEndRow = 1 + mainCombined.length;
  const mainNamesOut = mainCombined.map((name) => [name]);
  const mainAvOut = mainCombined.map((_name, index) => [sumifFormula(sourceSheet, index + 2)]);
  const mainZpOut = mainCombined.map((_name, index) => [sumifFormula(secondHalfSheet, index + 2)]);

  await updateRange(app, spreadsheetId, buildColumnRange(targetSheet, "A", 2, mainEndRow), mainNamesOut);
  await updateRange(app, spreadsheetId, buildColumnRange(targetSheet, "B", 2, mainEndRow), mainAvOut);
  await updateRange(app, spreadsheetId, buildColumnRange(targetSheet, "C", 2, mainEndRow), mainZpOut);

  const totalsMainRangeRows = [];
  for (let row = 2; row <= mainEndRow; row += 1) {
    totalsMainRangeRows.push([
      row === mainEndRow ? sumFormula("B", 2, mainEndRow) : "",
      row === mainEndRow ? sumFormula("C", 2, mainEndRow) : "",
    ]);
  }
  await updateRange(app, spreadsheetId, `${targetSheet}!D2:E${mainEndRow}`, totalsMainRangeRows);

  const redStartRow = currentRedStart + insertionCount;
  const redEndRow = redStartRow + redNames.length - 1;
  const redSorted = [...redNames].sort((left, right) => compareRuNames(left, right));
  const redNamesOut = redSorted.map((name) => [name]);
  const redAvOut = redSorted.map((_name, index) => [sumifFormula(sourceSheet, redStartRow + index)]);
  const redZpOut = redSorted.map((_name, index) => [sumifFormula(secondHalfSheet, redStartRow + index)]);
  await updateRange(app, spreadsheetId, buildColumnRange(targetSheet, "A", redStartRow, redEndRow), redNamesOut);
  await updateRange(app, spreadsheetId, buildColumnRange(targetSheet, "B", redStartRow, redEndRow), redAvOut);
  await updateRange(app, spreadsheetId, buildColumnRange(targetSheet, "C", redStartRow, redEndRow), redZpOut);

  const redSubtotalRow = redEndRow + 1;
  await updateRange(app, spreadsheetId, `${targetSheet}!D${redSubtotalRow}:E${redSubtotalRow}`, [[sumFormula("B", redStartRow, redEndRow), sumFormula("C", redStartRow, redEndRow)]]);

  const overallRow = redEndRow + 4;
  const sourceTotalRow = redEndRow + 6;
  const diffRow = redEndRow + 7;
  await updateRange(app, spreadsheetId, `${targetSheet}!B${overallRow}:C${overallRow}`, [[sumFormula("B", 2, redEndRow), sumFormula("C", 2, redEndRow)]]);
  await updateRange(app, spreadsheetId, `${targetSheet}!B${sourceTotalRow}:C${sourceTotalRow}`, [[sourceTotalFormula(sourceSheet), sourceTotalFormula(secondHalfSheet)]]);
  await updateRange(app, spreadsheetId, `${targetSheet}!B${diffRow}:C${diffRow}`, [[diffFormula("B", overallRow, "B", sourceTotalRow), diffFormula("C", overallRow, "C", sourceTotalRow)]]);

  const reportValues = await readRange(app, spreadsheetId, `B${overallRow}:C${diffRow}`, targetSheet, { valueRenderOption: "UNFORMATTED_VALUE" });
  const rows = reportValues.values || [];
  const overallAv = rows[0]?.[0] ?? "";
  const overallZp = rows[0]?.[1] ?? "";
  const sourceAv = rows[2]?.[0] ?? "";
  const sourceZp = rows[2]?.[1] ?? "";
  const diffAv = rows[3]?.[0] ?? "";
  const diffZp = rows[3]?.[1] ?? "";
  const secondHalfMatches = Number(diffZp || 0) === 0;

  app.state.updateChatMemory(message.chat.id, {
    lastTask: "advance_dental_av",
    lastTableName: resolved.file.name,
    lastSheetName: targetSheet,
    lastSpreadsheetId: spreadsheetId,
  });

  const changedBlocks = [
    `A2:C${mainEndRow}`,
    `D2:E${mainEndRow}`,
    `A${redStartRow}:C${redEndRow}`,
    `D${redSubtotalRow}:E${redSubtotalRow}`,
    `B${overallRow}:C${overallRow}`,
    `B${sourceTotalRow}:C${sourceTotalRow}`,
    `B${diffRow}:C${diffRow}`,
  ];

  const reportText =
    `Готово: ${resolved.file.name} / ${targetSheet}\n` +
    `Добавил в основной список: ${missingMain.length ? missingMain.map((item) => item.name).join(", ") : "никого"}\n` +
    `Изменённые строки и блоки: ${changedBlocks.join("; ")}\n` +
    `Итоговая строка по листу: ${overallRow} (аванс ${formatAmount(overallAv)}, 2-я часть ${formatAmount(overallZp)})\n` +
    `Строка итога источника: ${sourceTotalRow} (аванс ${formatAmount(sourceAv)}, 2-я часть ${formatAmount(sourceZp)})\n` +
    `Разница: строка ${diffRow} (аванс ${formatAmount(diffAv)}, 2-я часть ${formatAmount(diffZp)})\n` +
    `Итог второй части ЗП с источником ${secondHalfMatches ? "совпадает" : "не совпадает"}.`;

  await app.telegram.sendMessage(message.chat.id, reportText, message.message_id);
}
