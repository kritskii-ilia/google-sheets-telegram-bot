import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function buildPrompt(context) {
  const message = String(context?.messageText || "").trim();
  const lastTable = String(context?.memory?.lastTableName || "").trim();
  const lastSheet = String(context?.memory?.lastSheetName || "").trim();
  const lastDialogTask = String(context?.memory?.lastDialogTask || "").trim();

  return [
    "You are the routing brain for a Telegram bot that works with Google Sheets.",
    "Return valid JSON only.",
    "Choose exactly one action from: reply, gfind, gsalarysync, help.",
    "Use action=gsalarysync only for the simple supported workflow: normalize A:I, then sync salaries from H:I into A:B by employee name, insert new employees alphabetically, align inserted names right.",
    "Use action=gfind when the user asks to find or locate a table.",
    "Use action=help when the user asks what the bot can do.",
    "Use action=reply when clarification is required, when the user describes a more complex custom task, or when the request is outside supported workflows.",
    "If the user refers to the previous table or says 'как в прошлый раз', reuse the saved lastTableName and lastSheetName when available.",
    "Keep userMessage short, in Russian, natural language.",
    "Do not invent unsupported actions.",
    "",
    `User message: ${JSON.stringify(message)}`,
    `Last table: ${JSON.stringify(lastTable)}`,
    `Last sheet: ${JSON.stringify(lastSheet)}`,
    `Last dialog task: ${JSON.stringify(lastDialogTask)}`,
    "",
    "Supported deterministic workflows:",
    "- gfind: locate a spreadsheet by name inside the configured Google Drive sandbox.",
    "- gsalarysync: normalize A:I, then sync salaries from H:I into A:B by employee name, insert new employees alphabetically, align inserted names right.",
    "",
    "Examples of requests that must be reply, not gsalarysync:",
    "- custom sheet-to-sheet transfer with colored blocks, totals, formulas, or nonstandard columns",
    "- requests that mention specific sheets other than the simple H:I -> A:B workflow",
    "- long task descriptions with many custom rules",
    "",
    "Examples:",
    JSON.stringify({
      action: "gsalarysync",
      userMessage: "Запускаю синхронизацию зарплат.",
      tableName: lastTable || "ооо Д1 АВ январь 2026",
      sheetName: lastSheet || "Лист3",
      startRow: 2,
      endRow: 200,
      reasoning: "salary_sync",
    }),
    JSON.stringify({
      action: "reply",
      userMessage: "Уточни, пожалуйста, название таблицы.",
      reasoning: "need_table_name",
    }),
  ].join("\n");
}

function buildConversationPrompt(context) {
  const message = String(context?.messageText || "").trim();
  const lastTable = String(context?.memory?.lastTableName || "").trim();
  const lastSheet = String(context?.memory?.lastSheetName || "").trim();
  const lastDialogTask = String(context?.memory?.lastDialogTask || "").trim();

  return [
    "You are a Telegram assistant for Google Sheets tasks.",
    "Reply in Russian.",
    "Be concise, practical, and natural.",
    "The user may describe a complex spreadsheet task in free form.",
    "Your goal is to show that you understood the task, mention key constraints, and say what you can do next.",
    "Do not claim a task is already completed if it is not.",
    "If the task is more complex than the currently implemented deterministic workflows, say that you understood it and that it is accepted as a custom task.",
    "Avoid markdown lists unless really helpful.",
    "",
    `User message: ${JSON.stringify(message)}`,
    `Last table: ${JSON.stringify(lastTable)}`,
    `Last sheet: ${JSON.stringify(lastSheet)}`,
    `Last dialog task: ${JSON.stringify(lastDialogTask)}`,
    "",
    "Respond as the bot would in chat.",
  ].join("\n");
}

export class CodexExecutor {
  constructor(config) {
    this.config = config;
    this.schemaPath = path.resolve(config.projectRoot, "src/executors/schema.json");
  }

  async executeTask(app, context) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gstg-codex-"));
    const outputPath = path.join(tempDir, "last-message.json");
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--sandbox",
      "workspace-write",
      "--cd",
      app.config.ai.codexWorkdir,
      "--model",
      app.config.ai.codexModel,
      "--output-schema",
      this.schemaPath,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      "--json",
      buildPrompt(context),
    ];

    try {
      const { stdout, stderr } = await runCodex(args, app.config.ai.codexTimeoutMs, {
        ...process.env,
        HOME: process.env.HOME || "/home/user",
      });
      const cleanStderr = String(stderr || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line !== "Reading additional input from stdin...")
        .join("\n");
      if (cleanStderr) {
        app.logger.warn("codex stderr", { stderr: cleanStderr.slice(0, 1000) });
      }
      if (stdout?.trim()) {
        app.logger.debug("codex stdout", { stdout: stdout.trim().slice(0, 1000) });
      }
      const raw = await fs.readFile(outputPath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async generateReply(app, context) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gstg-codex-chat-"));
    const outputPath = path.join(tempDir, "last-message.txt");
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--sandbox",
      "workspace-write",
      "--cd",
      app.config.ai.codexWorkdir,
      "--model",
      app.config.ai.codexModel,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      buildConversationPrompt(context),
    ];

    try {
      const { stdout, stderr } = await runCodex(args, app.config.ai.codexTimeoutMs, {
        ...process.env,
        HOME: process.env.HOME || "/home/user",
      });
      const cleanStderr = String(stderr || "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line !== "Reading additional input from stdin...")
        .join("\n");
      if (cleanStderr) {
        app.logger.warn("codex chat stderr", { stderr: cleanStderr.slice(0, 1000) });
      }
      if (stdout?.trim()) {
        app.logger.debug("codex chat stdout", { stdout: stdout.trim().slice(0, 1000) });
      }
      return String(await fs.readFile(outputPath, "utf8")).trim();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function runCodex(args, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`codex_timeout_after_ms: ${timeoutMs}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`codex_exit_${code}: ${stderr || stdout || "unknown_error"}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
