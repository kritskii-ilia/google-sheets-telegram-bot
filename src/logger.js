const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeLevel(value) {
  const level = String(value || "info").trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : "info";
}

export function createLogger(levelRaw) {
  const level = normalizeLevel(levelRaw);
  const min = LEVELS[level];

  function write(kind, message, meta) {
    if (LEVELS[kind] < min) return;
    const stamp = new Date().toISOString();
    const base = `[${stamp}] [${kind}] ${message}`;
    if (meta === undefined) {
      console.log(base);
      return;
    }
    console.log(`${base} ${JSON.stringify(meta)}`);
  }

  return {
    debug(message, meta) {
      write("debug", message, meta);
    },
    info(message, meta) {
      write("info", message, meta);
    },
    warn(message, meta) {
      write("warn", message, meta);
    },
    error(message, meta) {
      write("error", message, meta);
    },
  };
}
