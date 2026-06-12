import fs from "node:fs";
import path from "node:path";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export class StateStore {
  constructor(projectRoot) {
    this.dir = path.join(projectRoot, "data");
    this.filePath = path.join(this.dir, "state.json");
    ensureDir(this.dir);
    this.state = this.readState();
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return { chats: {} };
    }
  }

  flush() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getChatMemory(chatId) {
    return this.state.chats[String(chatId)] || {};
  }

  updateChatMemory(chatId, patch) {
    const key = String(chatId);
    const current = this.getChatMemory(key);
    this.state.chats[key] = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.flush();
    return this.state.chats[key];
  }
}
