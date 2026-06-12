import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFromCsvRaw, parseBool, parseIntOr } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!key || Object.hasOwn(process.env, key)) continue;
    process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export function loadConfig() {
  loadEnvFile(path.join(PROJECT_ROOT, ".env"));

  const cfg = {
    projectRoot: PROJECT_ROOT,
    telegram: {
      token: requireEnv("TELEGRAM_BOT_TOKEN"),
      allowedChatIds: listFromCsvRaw(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.GOOGLE_ADMIN_TG_ID || ""),
      adminChatId: String(process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.GOOGLE_ADMIN_TG_ID || "").trim(),
      pollTimeoutSeconds: Math.max(1, Math.min(60, parseIntOr(process.env.BOT_POLL_TIMEOUT_SECONDS, 30))),
    },
    ai: {
      defaultExecutor: String(process.env.AI_DEFAULT_EXECUTOR || "codex").trim().toLowerCase(),
      codexModel: String(process.env.CODEX_MODEL || "gpt-5.4").trim(),
      codexTimeoutMs: Math.max(10000, Math.min(600000, parseIntOr(process.env.CODEX_TIMEOUT_MS, 45000))),
      codexWorkdir: String(process.env.CODEX_WORKDIR || PROJECT_ROOT).trim(),
    },
    google: {
      folderId: requireEnv("GOOGLE_DRIVE_FOLDER_ID"),
      serviceAccountPath: requireEnv("GOOGLE_APPLICATION_CREDENTIALS"),
      oauthClientPath: requireEnv("GOOGLE_OAUTH_CLIENT_PATH"),
      oauthTokensPath: requireEnv("GOOGLE_OAUTH_TOKENS_PATH"),
      allowPermanentDelete: parseBool(process.env.GOOGLE_ALLOW_PERMANENT_DELETE, false),
      shareEnabled: parseBool(process.env.GOOGLE_SHARE_ENABLED, false),
      shareAllowlist: listFromCsvRaw(process.env.GOOGLE_SHARE_ALLOWLIST || "").map((item) => item.toLowerCase()),
      formulaLocale: String(process.env.GOOGLE_FORMULA_LOCALE || "ru").trim().toLowerCase(),
      apiRetryAttempts: Math.max(1, Math.min(8, parseIntOr(process.env.GOOGLE_API_RETRY_ATTEMPTS, 4))),
      apiRetryMinDelayMs: Math.max(100, Math.min(30000, parseIntOr(process.env.GOOGLE_API_RETRY_MIN_DELAY_MS, 700))),
      apiRetryMaxDelayMs: Math.max(700, Math.min(90000, parseIntOr(process.env.GOOGLE_API_RETRY_MAX_DELAY_MS, 8000))),
      apiRetryJitter: Math.max(0, Math.min(1, Number(process.env.GOOGLE_API_RETRY_JITTER || 0.2))),
    },
    logLevel: String(process.env.BOT_LOG_LEVEL || "info").trim().toLowerCase(),
  };

  if (!cfg.telegram.allowedChatIds.length) {
    throw new Error("At least one Telegram allowed chat id is required");
  }
  return cfg;
}
