const { markComplete } = require("./notion-client");
const logger = require("../lib/logger");

require("dotenv").config();

async function markFailed(taskId, error) {
  logger.warn(`[updater] Task ${taskId} failed: ${error}`);
  await markComplete(taskId, 1, "", error);
}

async function markSuccess(taskId, exitCode = 0, output = "") {
  logger.info(`[updater] Task ${taskId} completed`);
  await markComplete(taskId, exitCode, output, "");
}

module.exports = { markComplete, markFailed, markSuccess };
