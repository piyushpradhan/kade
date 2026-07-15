const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString();
}

function log(level, message, ...args) {
  const line = `[${timestamp()}] [${level}] ${message}`;
  console.log(line, ...args);
  try {
    ensureLogDir();
    fs.appendFileSync(
      path.join(LOG_DIR, "kade.log"),
      `${line} ${args.map(String).join(" ")}\n`
    );
  } catch {
    // ignore file logging errors
  }
}

module.exports = {
  info: (msg, ...args) => log("INFO", msg, ...args),
  warn: (msg, ...args) => log("WARN", msg, ...args),
  error: (msg, ...args) => log("ERROR", msg, ...args),
};
