import fs from "node:fs";
import crypto from "node:crypto";
import {
  computeBackoffMs,
  isRetriableError,
  isRetriableStatus,
  parseRetryAfterMs,
  sleep,
  toStr,
} from "../utils.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
];

const tokenCache = new Map();

function canReadFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(filePath, missingCode, invalidCode) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`${missingCode}: ${filePath}`);
    }
    throw new Error(`${invalidCode}: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeClientConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("oauth_client_invalid_json: expected object");
  const normalized = raw.installed || raw.web || raw;
  const clientId = toStr(normalized.client_id).trim();
  const clientSecret = toStr(normalized.client_secret).trim();
  if (!clientId || !clientSecret) {
    throw new Error("oauth_client_invalid_json: missing client_id/client_secret");
  }
  return { clientId, clientSecret };
}

function normalizeServiceAccountConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("service_account_invalid_json: expected object");
  const clientEmail = toStr(raw.client_email).trim();
  const privateKey = toStr(raw.private_key).trim();
  if (toStr(raw.type).trim() !== "service_account" || !clientEmail || !privateKey) {
    throw new Error("service_account_invalid_json: missing type=service_account/client_email/private_key");
  }
  return { clientEmail, privateKey };
}

function getTokenCacheKey(cfg, scopes) {
  return `${cfg.serviceAccountPath}::${cfg.oauthClientPath}::${cfg.oauthTokensPath}::${scopes.join(" ")}`;
}

function base64Url(input) {
  return Buffer.from(typeof input === "string" ? input : JSON.stringify(input))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function getServiceAccountAccessToken(cfg, scopes = DEFAULT_SCOPES) {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `${getTokenCacheKey(cfg, scopes)}::service_account`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.accessToken && cached.exp > now + 60) {
    return String(cached.accessToken);
  }

  const saRaw = readJsonFile(cfg.serviceAccountPath, "service_account_missing", "service_account_invalid_json");
  const { clientEmail, privateKey } = normalizeServiceAccountConfig(saRaw);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: scopes.join(" "),
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(header)}.${base64Url(claim)}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, "base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", `${unsigned}.${signature}`);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`service_account_token_error ${res.status}: ${JSON.stringify(json)}`);
  }

  tokenCache.set(cacheKey, {
    accessToken: String(json.access_token),
    exp: now + Number(json.expires_in || 3600),
  });
  return String(json.access_token);
}

async function getOauthAccessToken(cfg, scopes = DEFAULT_SCOPES) {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `${getTokenCacheKey(cfg, scopes)}::oauth`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.accessToken && cached.exp > now + 60) {
    return String(cached.accessToken);
  }

  const clientRaw = readJsonFile(cfg.oauthClientPath, "oauth_client_missing", "oauth_client_invalid_json");
  const tokensRaw = readJsonFile(cfg.oauthTokensPath, "oauth_tokens_missing", "oauth_tokens_invalid_json");
  const { clientId, clientSecret } = normalizeClientConfig(clientRaw);
  const refreshToken = toStr(tokensRaw.refresh_token).trim();
  if (!refreshToken) {
    throw new Error(`oauth_tokens_missing_refresh_token: ${cfg.oauthTokensPath}`);
  }

  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("refresh_token", refreshToken);
  body.set("grant_type", "refresh_token");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`oauth_refresh_error ${res.status}: ${JSON.stringify(json)}`);
  }

  tokenCache.set(cacheKey, {
    accessToken: String(json.access_token),
    exp: now + Number(json.expires_in || 3600),
  });
  return String(json.access_token);
}

export async function getAccessToken(cfg, scopes = DEFAULT_SCOPES, authMode = "auto") {
  if (authMode === "oauth_only") return getOauthAccessToken(cfg, scopes);
  if (authMode === "service_account_only") return getServiceAccountAccessToken(cfg, scopes);
  if (cfg.serviceAccountPath && canReadFile(cfg.serviceAccountPath)) {
    try {
      return await getServiceAccountAccessToken(cfg, scopes);
    } catch {
      return getOauthAccessToken(cfg, scopes);
    }
  }
  return getOauthAccessToken(cfg, scopes);
}

function isStorageQuotaExceededError(err) {
  const status = Number(err?.meta?.status || 0);
  const reason = JSON.stringify(err?.meta?.response || {});
  return status === 403 && /storagequotaexceeded/i.test(reason);
}

export async function gjson(app, url, opts = {}) {
  const method = opts.method || "GET";
  const scopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : DEFAULT_SCOPES;
  const authMode = String(opts.authMode || "auto");
  const cfg = app.config.google;
  let lastErr = null;

  for (let attempt = 1; attempt <= cfg.apiRetryAttempts; attempt += 1) {
    try {
      const token = await getAccessToken(cfg, scopes, authMode);
      const headers = {
        authorization: `Bearer ${token}`,
        ...(opts.headers || {}),
      };
      const response = await fetch(url, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      });
      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        const err = new Error(`google_api_error ${response.status}: ${JSON.stringify(data)}`);
        err.meta = { status: response.status, method, url, response: data, scopes };
        if (isRetriableStatus(response.status) && attempt < cfg.apiRetryAttempts) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const baseDelay = computeBackoffMs(attempt, cfg.apiRetryMinDelayMs, cfg.apiRetryMaxDelayMs, cfg.apiRetryJitter);
          const delay = Math.max(baseDelay, retryAfterMs || 0);
          app.logger.warn("google retryable status", { status: response.status, attempt, delay });
          await sleep(delay);
          continue;
        }
        throw err;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (!isRetriableError(err) || attempt >= cfg.apiRetryAttempts) break;
      const delay = computeBackoffMs(attempt, cfg.apiRetryMinDelayMs, cfg.apiRetryMaxDelayMs, cfg.apiRetryJitter);
      app.logger.warn("google retryable network error", { attempt, delay, error: String(err) });
      await sleep(delay);
    }
  }
  throw lastErr || new Error("google_api_error: unknown");
}

export async function createGoogleFile(app, { name, mimeType, parentId }) {
  const targetParent = parentId || app.config.google.folderId;
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "id,name,mimeType,parents,trashed,webViewLink");
  const req = {
    method: "POST",
    scopes: ["https://www.googleapis.com/auth/drive"],
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType,
      parents: [targetParent],
    }),
  };
  try {
    return await gjson(app, url.toString(), req);
  } catch (err) {
    if (isStorageQuotaExceededError(err)) {
      app.logger.warn("google create fallback to oauth", { name });
      return gjson(app, url.toString(), { ...req, authMode: "oauth_only" });
    }
    throw err;
  }
}
