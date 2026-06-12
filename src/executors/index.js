import { CodexExecutor } from "./providers/codex.js";

class UnconfiguredExecutor {
  constructor(name) {
    this.name = name;
  }

  async executeTask(_app, _context) {
    return {
      action: "reply",
      userMessage: `Исполнитель ${this.name} пока не подключён.`,
      reasoning: `${this.name}_not_implemented`,
    };
  }
}

export function createExecutorRegistry(config) {
  return {
    codex: new CodexExecutor(config),
    gemini: new UnconfiguredExecutor("gemini"),
    openai: new UnconfiguredExecutor("openai"),
  };
}

export function getExecutor(app, name = "") {
  const normalized = String(name || app.config.ai.defaultExecutor || "codex").trim().toLowerCase();
  const executor = app.executors?.[normalized];
  if (!executor) {
    throw new Error(`executor_not_found: ${normalized}`);
  }
  return { name: normalized, executor };
}
