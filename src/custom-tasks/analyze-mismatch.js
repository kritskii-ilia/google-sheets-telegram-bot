import { readRange } from "../google/sheets.js";
import { normalizePersonKey } from "../utils.js";

function normalizeName(value) {
  return normalizePersonKey(String(value || "").trim());
}

function sumMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const name = String(row?.[0] || "").trim();
    const raw = row?.[1];
    const value = Number(raw || 0);
    if (!name || !Number.isFinite(value)) continue;
    const key = normalizeName(name);
    map.set(key, (map.get(key) || 0) + value);
  }
  return map;
}

function fmt(value) {
  return Number(value || 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isEmployeeFormula(value) {
  const text = String(value || "").toUpperCase();
  return text.includes("SUMIF(") || text.includes("СУММЕСЛИ(");
}

export function matchesMismatchAnalysisTask(messageText, memory = {}) {
  const text = String(messageText || "").trim().toLowerCase();
  if (text.includes("почему суммы не совпали")) return true;
  if (text.includes("проверь почему суммы не совпали")) return true;
  if (text === "делай") {
    const last = String(memory.lastDialogTask || "").toLowerCase();
    return last.includes("почему суммы не совпали");
  }
  return false;
}

export async function executeMismatchAnalysisTask(app, message) {
  const memory = app.state.getChatMemory(message.chat.id);
  const tableName = String(memory.lastTableName || "").trim();
  const sheetName = String(memory.lastSheetName || "Лист1").trim();
  const spreadsheetId = String(memory.lastSpreadsheetId || "").trim();
  if (!spreadsheetId) {
    await app.telegram.sendMessage(message.chat.id, "Не хватает контекста по таблице для проверки расхождений.", message.message_id);
    return;
  }

  await app.telegram.sendMessage(
    message.chat.id,
    `Начинаю проверку расхождений по таблице ${tableName}, лист ${sheetName}.`,
    message.message_id,
  );

  const targetRows = (await readRange(app, spreadsheetId, "A2:C120", sheetName, { valueRenderOption: "UNFORMATTED_VALUE" })).values || [];
  const targetFormulaRows = (await readRange(app, spreadsheetId, "A2:C120", sheetName, { valueRenderOption: "FORMULA" })).values || [];
  const srcAvRows = (await readRange(app, spreadsheetId, "A6:B76", "Дентал АВ", { valueRenderOption: "UNFORMATTED_VALUE" })).values || [];

  const avMap = sumMap(srcAvRows);

  let targetAvTotal = 0;
  const mismatches = [];
  const targetNames = new Set();
  const extraTargetNames = [];
  const seenTargetNames = new Set();
  const duplicateTargetNames = [];
  for (let i = 0; i < targetRows.length; i += 1) {
    const row = targetRows[i];
    const formulaRow = targetFormulaRows[i] || [];
    const name = String(row?.[0] || "").trim();
    if (!name || !isEmployeeFormula(formulaRow?.[1])) continue;
    const av = Number(row?.[1] || 0);
    if (!Number.isFinite(av)) continue;
    targetAvTotal += av;
    const key = normalizeName(name);
    if (seenTargetNames.has(key) && !duplicateTargetNames.some((item) => item.key === key)) {
      duplicateTargetNames.push({ key, name, av });
    }
    seenTargetNames.add(key);
    targetNames.add(key);
    const expectedAv = avMap.get(key) || 0;
    if (!avMap.has(key) && Math.abs(av) > 0.001) {
      extraTargetNames.push({ name, av });
    }
    if (Math.abs(av - expectedAv) > 0.001) {
      mismatches.push({ name, av, expectedAv });
    }
  }

  const sourceAvTotal = [...avMap.values()].reduce((acc, value) => acc + value, 0);
  const avDiff = targetAvTotal - sourceAvTotal;
  const missingInTarget = [];
  for (const key of avMap.keys()) {
    if (targetNames.has(key)) continue;
    missingInTarget.push(key);
  }

  let report =
    `Проверка завершена: ${tableName} / ${sheetName}\n` +
    `Итог по листу по авансу: ${fmt(targetAvTotal)}\n` +
    `Итог по источнику Дентал АВ: ${fmt(sourceAvTotal)}\n` +
    `Разница по авансу: ${fmt(avDiff)}\n`;

  if (!mismatches.length && !missingInTarget.length && !extraTargetNames.length && !duplicateTargetNames.length) {
    report += "Сейчас явных расхождений по авансовой части не найдено.";
  } else {
    if (missingInTarget.length) {
      report += `\nЕсть сотрудники из источника, которых нет в листе: ${missingInTarget.slice(0, 10).join(", ")}${missingInTarget.length > 10 ? " ..." : ""}`;
    }
    if (extraTargetNames.length) {
      const preview = extraTargetNames
        .slice(0, 8)
        .map((item) => `${item.name} (${fmt(item.av)})`)
        .join(", ");
      report += `\nЕсть сотрудники в листе с авансом, которых нет в источнике: ${preview}`;
    }
    if (duplicateTargetNames.length) {
      const preview = duplicateTargetNames
        .slice(0, 8)
        .map((item) => item.name)
        .join(", ");
      report += `\nЕсть дубли сотрудников в листе, которые искажают итог: ${preview}`;
    }
    if (mismatches.length) {
      const preview = mismatches
        .slice(0, 8)
        .map((item) => `${item.name}: аванс ${fmt(item.av)} vs ${fmt(item.expectedAv)}`)
        .join("; ");
      report += `\nНайдены расхождения по строкам: ${preview}`;
    }
  }

  app.state.updateChatMemory(message.chat.id, {
    lastTask: "mismatch_analysis",
    lastDialogTask: String(message.text || ""),
    lastDialogReply: report,
  });

  await app.telegram.sendMessage(message.chat.id, report, message.message_id);
}
