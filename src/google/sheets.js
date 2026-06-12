import { gjson } from "./auth.js";
import { assertInSandbox } from "./drive.js";
import {
  compareRuNames,
  normalizePersonKey,
  normalizeWhitespaceCell,
  parseBool,
  toArray,
} from "../utils.js";

const SHEETS_V4 = "https://sheets.googleapis.com/v4";

export function quoteSheetName(name) {
  return `'${String(name || "").replace(/'/g, "''")}'`;
}

function colIndexToA1(idx) {
  let n = Number(idx || 0);
  let out = "";
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out || "A";
}

function a1ToColIndex(col) {
  let result = 0;
  for (const ch of String(col || "").toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
}

function parseSingleColumnRange(range, expectedSheet) {
  const input = String(range || "").trim();
  const match = input.match(/^'?([^'!]+)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`invalid_single_column_range: ${input}`);
  const [, sheet, colStart, rowStart, colEnd, rowEnd] = match;
  if (colStart.toUpperCase() !== colEnd.toUpperCase()) {
    throw new Error(`range_must_be_single_column: ${input}`);
  }
  const normalizedSheet = sheet || expectedSheet;
  if (!normalizedSheet) throw new Error(`sheet_required_in_range: ${input}`);
  return {
    sheet: normalizedSheet,
    col: colStart.toUpperCase(),
    startRow: Number(rowStart),
    endRow: Number(rowEnd),
  };
}

function parseA1RangeToGrid(rangeA1) {
  const match = String(rangeA1 || "").trim().match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`invalid_a1_range: ${rangeA1}`);
  const [, colStart, rowStart, colEnd, rowEnd] = match;
  return {
    startRowIndex: Number(rowStart) - 1,
    endRowIndex: Number(rowEnd),
    startColumnIndex: a1ToColIndex(colStart),
    endColumnIndex: a1ToColIndex(colEnd) + 1,
  };
}

export function buildColumnRange(sheet, col, startRow, endRow) {
  return `${quoteSheetName(sheet)}!${String(col).toUpperCase()}${startRow}:${String(col).toUpperCase()}${endRow}`;
}

export function buildRectRange(sheet, startCol, endCol, startRow, endRow) {
  return `${quoteSheetName(sheet)}!${String(startCol).toUpperCase()}${startRow}:${String(endCol).toUpperCase()}${endRow}`;
}

async function batchUpdateSpreadsheet(app, spreadsheetId, requests) {
  return gjson(app, `${SHEETS_V4}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: "POST",
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests: Array.isArray(requests) ? requests : [] }),
  });
}

export async function insertRows(app, spreadsheetId, sheetNameOrId, startRow, howMany = 1) {
  await assertInSandbox(app, spreadsheetId, "application/vnd.google-apps.spreadsheet");
  const props = await resolveSheetProperties(app, spreadsheetId, sheetNameOrId);
  return batchUpdateSpreadsheet(app, spreadsheetId, [
    {
      insertDimension: {
        range: {
          sheetId: Number(props.sheetId),
          dimension: "ROWS",
          startIndex: Math.max(0, Number(startRow) - 1),
          endIndex: Math.max(0, Number(startRow) - 1) + Math.max(1, Number(howMany)),
        },
        inheritFromBefore: true,
      },
    },
  ]);
}

export async function getSpreadsheetInfo(app, spreadsheetId) {
  await assertInSandbox(app, spreadsheetId, "application/vnd.google-apps.spreadsheet");
  return gjson(
    app,
    `${SHEETS_V4}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties))`,
    { scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"] },
  );
}

async function resolveSheetProperties(app, spreadsheetId, sheetNameOrId) {
  const info = await getSpreadsheetInfo(app, spreadsheetId);
  const sheets = toArray(info?.sheets);
  if (!sheets.length) throw new Error("sheet_not_found: spreadsheet has no sheets");
  const requested = String(sheetNameOrId || "").trim();
  if (!requested) return sheets[0]?.properties || null;
  if (/^[0-9]+$/.test(requested)) {
    const sid = Number(requested);
    const hit = sheets.find((sheet) => Number(sheet?.properties?.sheetId) === sid);
    if (hit?.properties) return hit.properties;
    throw new Error(`sheet_not_found_by_id: ${requested}`);
  }
  const hit = sheets.find((sheet) => String(sheet?.properties?.title || "") === requested);
  if (hit?.properties) return hit.properties;
  throw new Error(`sheet_not_found_by_title: ${requested}`);
}

export async function readRange(app, spreadsheetId, range, sheetNameOrId = "", options = {}) {
  await assertInSandbox(app, spreadsheetId, "application/vnd.google-apps.spreadsheet");
  const effectiveRange = String(sheetNameOrId || "").trim() && !String(range).includes("!")
    ? `${quoteSheetName(sheetNameOrId)}!${range}`
    : range;
  const url = new URL(`${SHEETS_V4}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(effectiveRange)}`);
  if (options.valueRenderOption) url.searchParams.set("valueRenderOption", String(options.valueRenderOption));
  if (options.dateTimeRenderOption) url.searchParams.set("dateTimeRenderOption", String(options.dateTimeRenderOption));
  if (options.majorDimension) url.searchParams.set("majorDimension", String(options.majorDimension));
  return gjson(app, url.toString(), {
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  });
}

export async function updateRange(app, spreadsheetId, range, values, sheetNameOrId = "") {
  await assertInSandbox(app, spreadsheetId, "application/vnd.google-apps.spreadsheet");
  const effectiveRange = String(sheetNameOrId || "").trim() && !String(range).includes("!")
    ? `${quoteSheetName(sheetNameOrId)}!${range}`
    : range;
  return gjson(
    app,
    `${SHEETS_V4}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(effectiveRange)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        range: effectiveRange,
        majorDimension: "ROWS",
        values: Array.isArray(values) ? values : [],
      }),
    },
  );
}

export async function normalizeSpacesInRange(
  app,
  spreadsheetId,
  range,
  sheetNameOrId = "",
  options = {},
) {
  const current = await readRange(app, spreadsheetId, range, sheetNameOrId, {
    valueRenderOption: "FORMULA",
  });
  const rows = toArray(current.values);
  const nextRows = [];
  let changedCells = 0;

  for (const row of rows) {
    const nextRow = [];
    for (const cell of toArray(row)) {
      if (options.preserveFormulas && typeof cell === "string" && cell.trim().startsWith("=")) {
        nextRow.push(cell);
        continue;
      }
      const normalized = normalizeWhitespaceCell(cell, options);
      if (normalized !== cell) changedCells += 1;
      nextRow.push(normalized);
    }
    nextRows.push(nextRow);
  }

  if (changedCells > 0) {
    await updateRange(app, spreadsheetId, range, nextRows, sheetNameOrId);
  }
  return { changedCells, rows: nextRows.length };
}

export async function setHorizontalAlignment(app, spreadsheetId, sheetNameOrId, rangeA1, alignment = "LEFT") {
  await assertInSandbox(app, spreadsheetId, "application/vnd.google-apps.spreadsheet");
  const props = await resolveSheetProperties(app, spreadsheetId, sheetNameOrId);
  const grid = parseA1RangeToGrid(String(rangeA1 || "A1:A1"));
  return batchUpdateSpreadsheet(app, spreadsheetId, [
    {
      repeatCell: {
        range: { sheetId: Number(props.sheetId), ...grid },
        cell: { userEnteredFormat: { horizontalAlignment: String(alignment || "LEFT").toUpperCase() } },
        fields: "userEnteredFormat.horizontalAlignment",
      },
    },
  ]);
}

export async function alignNamesInColumn(
  app,
  spreadsheetId,
  { sheetNameOrId, nameRange, names = [], normalize = true, alignment = "RIGHT" } = {},
) {
  const meta = parseSingleColumnRange(nameRange);
  const targetNames = toArray(names).map((item) => String(item || "").trim()).filter(Boolean);
  if (!targetNames.length) return { alignedRows: 0, ranges: [] };
  const keyOf = (value) => (parseBool(normalize, true) ? normalizePersonKey(value) : String(value || "").trim());
  const wanted = new Set(targetNames.map((item) => keyOf(item)).filter(Boolean));
  const data = await readRange(
    app,
    spreadsheetId,
    `${quoteSheetName(meta.sheet)}!${meta.col}${meta.startRow}:${meta.col}${meta.endRow}`,
    sheetNameOrId || meta.sheet,
  );
  const values = toArray(data?.values).map((row) => (Array.isArray(row) ? String(row[0] ?? "") : ""));
  const rowRanges = [];
  for (let i = 0; i < values.length; i += 1) {
    const key = keyOf(values[i]);
    if (!key || !wanted.has(key)) continue;
    const row = meta.startRow + i;
    rowRanges.push(`${meta.col}${row}:${meta.col}${row}`);
  }
  for (const rowRange of rowRanges) {
    await setHorizontalAlignment(app, spreadsheetId, meta.sheet, rowRange, alignment);
  }
  return { alignedRows: rowRanges.length, ranges: rowRanges };
}

export async function syncValuesByName(
  app,
  spreadsheetId,
  {
    targetNameRange,
    targetValueRange,
    sourceNameRange,
    sourceValueRange,
    normalize = true,
    insertUnmatched = false,
    alignInserted = false,
    insertedAlignment = "RIGHT",
  } = {},
) {
  const tNames = parseSingleColumnRange(targetNameRange);
  const tVals = parseSingleColumnRange(targetValueRange, tNames.sheet);
  const sNames = parseSingleColumnRange(sourceNameRange, tNames.sheet);
  const sVals = parseSingleColumnRange(sourceValueRange, tNames.sheet);
  if (tNames.sheet !== tVals.sheet || sNames.sheet !== sVals.sheet) {
    throw new Error("name_and_value_ranges_must_be_on_same_sheet");
  }
  if (tNames.endRow - tNames.startRow !== tVals.endRow - tVals.startRow) {
    throw new Error("target_ranges_must_have_same_height");
  }
  if (sNames.endRow - sNames.startRow !== sVals.endRow - sVals.startRow) {
    throw new Error("source_ranges_must_have_same_height");
  }

  const targetNamesResp = await readRange(
    app,
    spreadsheetId,
    `${quoteSheetName(tNames.sheet)}!${tNames.col}${tNames.startRow}:${tNames.col}${tNames.endRow}`,
  );
  const sourceNamesResp = await readRange(
    app,
    spreadsheetId,
    `${quoteSheetName(sNames.sheet)}!${sNames.col}${sNames.startRow}:${sNames.col}${sNames.endRow}`,
  );
  const sourceValsResp = await readRange(
    app,
    spreadsheetId,
    `${quoteSheetName(sVals.sheet)}!${sVals.col}${sVals.startRow}:${sVals.col}${sVals.endRow}`,
  );

  const targetNames = toArray(targetNamesResp?.values).map((row) => (Array.isArray(row) ? row[0] : ""));
  const sourceNames = toArray(sourceNamesResp?.values).map((row) => (Array.isArray(row) ? row[0] : ""));
  const sourceVals = toArray(sourceValsResp?.values).map((row) => (Array.isArray(row) ? row[0] : ""));

  const keyOf = (value) => (parseBool(normalize, true) ? normalizePersonKey(value) : String(value || "").trim());
  const sourceMap = new Map();
  let duplicateSourceNames = 0;
  for (let i = 0; i < sourceNames.length; i += 1) {
    const key = keyOf(sourceNames[i]);
    if (!key) continue;
    if (sourceMap.has(key)) {
      duplicateSourceNames += 1;
      continue;
    }
    sourceMap.set(key, sourceVals[i] ?? "");
  }

  let matched = 0;
  let unmatched = 0;
  const outValues = targetNames.map((name) => {
    const key = keyOf(name);
    if (!key) return [""];
    if (!sourceMap.has(key)) {
      unmatched += 1;
      return [""];
    }
    matched += 1;
    return [sourceMap.get(key)];
  });

  let inserted = 0;
  const insertedNames = [];

  if (parseBool(insertUnmatched, false)) {
    const rows = [];
    const seen = new Set();
    for (let i = 0; i < targetNames.length; i += 1) {
      const name = String(targetNames[i] ?? "").trim();
      const key = keyOf(name);
      if (!name) continue;
      const salary = sourceMap.has(key) ? sourceMap.get(key) : outValues[i]?.[0] ?? "";
      rows.push({ name, salary });
      if (key) seen.add(key);
    }
    for (let i = 0; i < sourceNames.length; i += 1) {
      const srcName = String(sourceNames[i] ?? "").trim();
      const key = keyOf(srcName);
      if (!srcName || !key || seen.has(key)) continue;
      rows.push({ name: srcName, salary: sourceVals[i] ?? "" });
      seen.add(key);
      inserted += 1;
      insertedNames.push(srcName);
    }

    rows.sort((left, right) => compareRuNames(left.name, right.name));
    const maxRows = tNames.endRow - tNames.startRow + 1;
    if (rows.length > maxRows) {
      throw new Error(`range_capacity_exceeded: need ${rows.length} rows, have ${maxRows}`);
    }

    const namesOut = [];
    const valsOut = [];
    for (let i = 0; i < maxRows; i += 1) {
      const row = rows[i];
      namesOut.push([row ? row.name : ""]);
      valsOut.push([row ? row.salary : ""]);
    }

    await updateRange(
      app,
      spreadsheetId,
      `${quoteSheetName(tNames.sheet)}!${tNames.col}${tNames.startRow}:${tNames.col}${tNames.endRow}`,
      namesOut,
    );
    await updateRange(
      app,
      spreadsheetId,
      `${quoteSheetName(tVals.sheet)}!${tVals.col}${tVals.startRow}:${tVals.col}${tVals.endRow}`,
      valsOut,
    );
  } else {
    await updateRange(
      app,
      spreadsheetId,
      `${quoteSheetName(tVals.sheet)}!${tVals.col}${tVals.startRow}:${tVals.col}${tVals.endRow}`,
      outValues,
    );
  }

  let insertedAlignmentResult = null;
  if (parseBool(alignInserted, false) && insertedNames.length) {
    insertedAlignmentResult = await alignNamesInColumn(app, spreadsheetId, {
      sheetNameOrId: tNames.sheet,
      nameRange: `${quoteSheetName(tNames.sheet)}!${tNames.col}${tNames.startRow}:${tNames.col}${tNames.endRow}`,
      names: insertedNames,
      normalize: true,
      alignment: insertedAlignment,
    });
  }

  return {
    matched,
    unmatched,
    duplicateSourceNames,
    inserted,
    insertedNames,
    insertedAlignmentResult,
    targetRows: outValues.length,
    sourceRows: sourceNames.length,
  };
}
