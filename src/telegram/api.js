const API_ROOT = "https://api.telegram.org";

function buildUrl(token, method) {
  return `${API_ROOT}/bot${token}/${method}`;
}

export class TelegramApi {
  constructor({ token, logger }) {
    this.token = token;
    this.logger = logger;
  }

  async call(method, payload = {}) {
    const response = await fetch(buildUrl(this.token, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.ok) {
      const description = json?.description || `${response.status} ${response.statusText}`;
      throw new Error(`Telegram API ${method} failed: ${description}`);
    }
    return json.result;
  }

  async getMe() {
    return this.call("getMe");
  }

  async setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
  }

  async getUpdates(offset, timeoutSeconds) {
    return this.call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId, text, replyToMessageId) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      disable_web_page_preview: true,
    });
  }
}
