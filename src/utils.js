export function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export function toStr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function parseBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function parseIntOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function listFromCsvRaw(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncateText(text, max = 1200) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
}

export function normalizeLookupName(value) {
  return String(value || "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizePersonKey(value) {
  return normalizeLookupName(value);
}

export function tokenizeLookupName(value) {
  return normalizeLookupName(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function scoreNameSimilarity(candidate, target) {
  const candidateNormalized = normalizeLookupName(candidate);
  const targetNormalized = normalizeLookupName(target);
  if (!candidateNormalized || !targetNormalized) return 0;
  if (candidateNormalized === targetNormalized) return 100;
  if (candidateNormalized.startsWith(targetNormalized) || targetNormalized.startsWith(candidateNormalized)) return 80;
  if (candidateNormalized.includes(targetNormalized) || targetNormalized.includes(candidateNormalized)) return 70;
  const candidateTokens = tokenizeLookupName(candidateNormalized);
  const targetTokens = tokenizeLookupName(targetNormalized);
  if (!candidateTokens.length || !targetTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  let common = 0;
  for (const token of targetTokens) {
    if (candidateSet.has(token)) common += 1;
  }
  const ratio = common / Math.max(candidateTokens.length, targetTokens.length);
  return Math.round(ratio * 60);
}

export function splitDrivePath(input) {
  return String(input || "")
    .split(">")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
}

export function compareRuNames(left, right) {
  return String(left || "").localeCompare(String(right || ""), "ru", { sensitivity: "base" });
}

export function normalizeWhitespaceCell(
  cell,
  { replaceNbsp = true, collapseSpaces = true, trimSpaces = true } = {},
) {
  if (typeof cell !== "string") return cell;
  let out = String(cell);
  if (replaceNbsp) out = out.replace(/[\u00A0\u202F]/g, " ");
  if (collapseSpaces) out = out.replace(/ {2,}/g, " ");
  if (trimSpaces) out = out.trim();
  return out;
}

export function parseRetryAfterMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

export function computeBackoffMs(attempt, minDelayMs, maxDelayMs, jitter) {
  const exp = Math.min(maxDelayMs, Math.round(minDelayMs * 2 ** Math.max(0, attempt - 1)));
  const j = Math.max(0, Math.min(1, Number(jitter || 0)));
  if (!j) return exp;
  const delta = Math.round(exp * j);
  const low = Math.max(0, exp - delta);
  const high = exp + delta;
  return low + Math.floor(Math.random() * Math.max(1, high - low + 1));
}

export function isRetriableStatus(status) {
  return Number(status) === 429 || (Number(status) >= 500 && Number(status) <= 599);
}

export function isRetriableError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket")
  );
}
