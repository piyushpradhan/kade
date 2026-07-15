const { spawn } = require("child_process");
const path = require("path");
const config = require("../config.json");
const { resolveModel } = require("../lib/models");
const logger = require("../lib/logger");

const KADE_ROOT = path.resolve(__dirname, "..");

function resolveEnv(env) {
  if (!env) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      out[key] = value;
    } else if (value.startsWith("~/")) {
      out[key] = path.join(process.env.HOME || "", value.slice(2));
    } else if (!path.isAbsolute(value) && /^[.~]/.test(value)) {
      out[key] = path.resolve(KADE_ROOT, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildArgs(adapter, prompt, cwd, model, provider) {
  const args = [...(adapter.subcommand || [])];

  const resolvedModel = resolveModel(provider, model);
  if (resolvedModel && adapter.model_flag) {
    args.push(adapter.model_flag, resolvedModel);
  }

  if (adapter.cwd_flag && cwd) {
    args.push(adapter.cwd_flag, cwd);
  }

  if (adapter.prompt_as_positional) {
    args.push(...(adapter.extra_args || []));
    args.push(prompt);
  } else {
    if (adapter.prompt_flag) {
      args.push(adapter.prompt_flag, prompt);
    }
    args.push(...(adapter.extra_args || []));
  }

  return args;
}

function truncate(text, max = 120) {
  const str = String(text || "");
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…(${str.length} chars)`;
}

function spawnAgent(provider, prompt, cwd, model, tag = "task") {
  const adapter = config.providers[provider];
  if (!adapter) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const args = buildArgs(adapter, prompt, cwd, model, provider);
  const resolvedModel = resolveModel(provider, model);
  const startedAt = Date.now();

  const displayCmd = `${adapter.command} ${args.map((a) => truncate(a, 80)).join(" ")}`;
  logger.info(`[dispatcher] [${tag}] command: ${displayCmd}`);
  logger.info(
    `[dispatcher] [${tag}] spawning ${adapter.command} (model: ${resolvedModel || "default"}, cwd: ${cwd})`
  );

  const child = spawn(adapter.command, args, {
    cwd: adapter.cwd_flag ? undefined : cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...resolveEnv(adapter.env) },
  });

  logger.info(`[dispatcher] [${tag}] process started (pid ${child.pid})`);

  let stdout = "";
  let stderr = "";
  let stdoutSeen = false;
  let stderrSeen = false;

  child.stdout.on("data", (data) => {
    stdout += data;
    if (!stdoutSeen) {
      stdoutSeen = true;
      logger.info(`[dispatcher] [${tag}] stdout stream opened (+${data.length}B)`);
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    if (!stderrSeen) {
      stderrSeen = true;
      logger.info(`[dispatcher] [${tag}] stderr stream opened (+${data.length}B)`);
    }
  });

  return new Promise((resolve) => {
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      logger.info(
        `[dispatcher] [${tag}] still running… ${elapsed}s elapsed (stdout ${stdout.length}B, stderr ${stderr.length}B)`
      );
    }, 5000);

    const finish = (result) => {
      clearInterval(heartbeat);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      logger.warn(
        `[dispatcher] [${tag}] TIMEOUT after ${adapter.timeout_seconds}s, sending SIGTERM (pid ${child.pid})`
      );
      child.kill("SIGTERM");
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n[timeout after ${adapter.timeout_seconds}s]`,
      });
    }, adapter.timeout_seconds * 1000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - startedAt;
      logger.info(
        `[dispatcher] [${tag}] process exited code=${code ?? 1} (stdout ${stdout.length}B, stderr ${stderr.length}B, ${elapsedMs}ms)`
      );
      finish({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      logger.error(`[dispatcher] [${tag}] spawn error: ${err.message}`);
      finish({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

module.exports = { spawnAgent, buildArgs, resolveEnv };
