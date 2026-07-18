const { spawn } = require("child_process");
const path = require("path");
const config = require("../config.json");
const { resolveModel } = require("../lib/models");
const logger = require("../lib/logger");

const KADE_ROOT = path.resolve(__dirname, "..");

// Cap captured output — a runaway agent must not OOM the daemon. The TAIL is
// kept: the final message (and any <task-plan> block) lives at the end.
const MAX_CAPTURE_BYTES = config.output?.max_capture_bytes ?? 1024 * 1024;
const KILL_GRACE_MS = 5000;

// Live child processes, so shutdown can reap the whole set.
const children = new Set();

function appendCapped(existing, chunk, max) {
  const s = existing + chunk;
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

// Signal the child's whole process group (spawned detached), falling back to
// the child alone — agents spawn subprocesses of their own.
function killTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function killAllChildren(signal = "SIGTERM") {
  for (const child of children) killTree(child, signal);
}

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

function buildArgs(adapter, prompt, cwd, model, provider, { sessionId, resume } = {}) {
  const args = [...(adapter.subcommand || [])];

  const resolvedModel = resolveModel(provider, model);
  if (resolvedModel && adapter.model_flag) {
    args.push(adapter.model_flag, resolvedModel);
  }

  if (adapter.cwd_flag && cwd) {
    args.push(adapter.cwd_flag, cwd);
  }

  // Session continuity: resume the same conversation on a decision reply,
  // otherwise pin a known session id so a later resume can find it. Providers
  // without these flags just run stateless (no resume support).
  if (sessionId) {
    if (resume && adapter.resume_flag) args.push(adapter.resume_flag, sessionId);
    else if (!resume && adapter.session_flag) args.push(adapter.session_flag, sessionId);
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

// Spawn a process, capture capped stdout/stderr, enforce a hard timeout with
// SIGTERM → SIGKILL escalation. Resolves; never rejects.
function launch(command, args, { cwd, env, timeoutSeconds = 600, tag = "task" } = {}) {
  const startedAt = Date.now();

  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    detached: true, // own process group → killTree reaches grandchildren
  });
  children.add(child);

  logger.info(`[dispatcher] [${tag}] process started (pid ${child.pid})`);

  let stdout = "";
  let stderr = "";
  let stdoutSeen = false;
  let stderrSeen = false;
  let stdoutCapped = false;
  let stderrCapped = false;

  child.stdout.on("data", (data) => {
    stdout = appendCapped(stdout, data, MAX_CAPTURE_BYTES);
    if (!stdoutSeen) {
      stdoutSeen = true;
      logger.info(`[dispatcher] [${tag}] stdout stream opened (+${data.length}B)`);
    }
    if (!stdoutCapped && stdout.length >= MAX_CAPTURE_BYTES) {
      stdoutCapped = true;
      logger.warn(`[dispatcher] [${tag}] stdout capture hit ${MAX_CAPTURE_BYTES}B cap — keeping tail only`);
    }
  });
  child.stderr.on("data", (data) => {
    stderr = appendCapped(stderr, data, MAX_CAPTURE_BYTES);
    if (!stderrSeen) {
      stderrSeen = true;
      logger.info(`[dispatcher] [${tag}] stderr stream opened (+${data.length}B)`);
    }
    if (!stderrCapped && stderr.length >= MAX_CAPTURE_BYTES) {
      stderrCapped = true;
      logger.warn(`[dispatcher] [${tag}] stderr capture hit ${MAX_CAPTURE_BYTES}B cap — keeping tail only`);
    }
  });

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let escalate = null;

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      logger.info(
        `[dispatcher] [${tag}] still running… ${elapsed}s elapsed (stdout ${stdout.length}B, stderr ${stderr.length}B)`
      );
    }, 30000);
    heartbeat.unref?.();

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (escalate) clearTimeout(escalate);
      clearTimeout(forceSettle);
      children.delete(child);
      resolve(result);
    };

    const timeoutNote = () =>
      `${stderr}\n[kade: timeout after ${timeoutSeconds}s — process group terminated]`;

    // Last-resort settle so a wedged child can never hang the dispatcher.
    const forceSettle = setTimeout(() => {
      logger.error(`[dispatcher] [${tag}] child did not exit after SIGKILL; giving up on it`);
      settle({ exitCode: -1, stdout, stderr: timeoutNote() });
    }, timeoutSeconds * 1000 + KILL_GRACE_MS * 3);
    forceSettle.unref?.();

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(
        `[dispatcher] [${tag}] TIMEOUT after ${timeoutSeconds}s, sending SIGTERM (pid ${child.pid})`
      );
      killTree(child, "SIGTERM");
      escalate = setTimeout(() => {
        logger.warn(`[dispatcher] [${tag}] still alive after grace, sending SIGKILL (pid ${child.pid})`);
        killTree(child, "SIGKILL");
      }, KILL_GRACE_MS);
      escalate.unref?.();
    }, timeoutSeconds * 1000);
    timeout.unref?.();

    child.on("close", (code) => {
      const elapsedMs = Date.now() - startedAt;
      logger.info(
        `[dispatcher] [${tag}] process exited code=${code ?? "signal"} (stdout ${stdout.length}B, stderr ${stderr.length}B, ${elapsedMs}ms)`
      );
      settle({
        exitCode: timedOut ? -1 : code ?? 1,
        stdout,
        stderr: timedOut ? timeoutNote() : stderr,
      });
    });

    child.on("error", (err) => {
      logger.error(`[dispatcher] [${tag}] spawn error: ${err.message}`);
      settle({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

function spawnAgent(provider, prompt, cwd, model, tag = "task", session = {}) {
  const adapter = config.providers[provider];
  if (!adapter) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const args = buildArgs(adapter, prompt, cwd, model, provider, session);
  const resolvedModel = resolveModel(provider, model);

  const displayCmd = `${adapter.command} ${args.map((a) => truncate(a, 80)).join(" ")}`;
  logger.info(`[dispatcher] [${tag}] command: ${displayCmd}`);
  logger.info(
    `[dispatcher] [${tag}] spawning ${adapter.command} (model: ${resolvedModel || "default"}, cwd: ${cwd})`
  );

  return launch(adapter.command, args, {
    cwd: adapter.cwd_flag ? undefined : cwd,
    env: resolveEnv(adapter.env),
    timeoutSeconds: adapter.timeout_seconds,
    tag,
  });
}

module.exports = {
  spawnAgent,
  buildArgs,
  resolveEnv,
  launch,
  appendCapped,
  killTree,
  killAllChildren,
  children,
};
