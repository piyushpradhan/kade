const test = require("node:test");
const assert = require("node:assert/strict");
const { buildArgs, launch, appendCapped } = require("../src/providers");

test("buildArgs passes model flag for claude", () => {
  const args = buildArgs(
    {
      subcommand: [],
      prompt_flag: "-p",
      model_flag: "--model",
      extra_args: ["--dangerously-skip-permissions"],
    },
    "do the thing",
    "/repo",
    "opus",
    "claude"
  );
  assert.deepEqual(args, ["--model", "opus", "-p", "do the thing", "--dangerously-skip-permissions"]);
});

test("buildArgs uses opencode run with model, dir, and --pure before the positional prompt", () => {
  const args = buildArgs(
    {
      subcommand: ["run"],
      prompt_as_positional: true,
      model_flag: "-m",
      cwd_flag: "--dir",
      extra_args: ["--pure", "--auto"],
    },
    "fix the bug",
    "/repo",
    "opencode-go/qwen3.7-plus",
    "opencode"
  );
  assert.deepEqual(args, [
    "run",
    "-m",
    "opencode-go/qwen3.7-plus",
    "--dir",
    "/repo",
    "--pure",
    "--auto",
    "fix the bug",
  ]);
});

test("resolveEnv resolves relative paths against the kade root", () => {
  const { resolveEnv } = require("../src/providers");
  const path = require("path");
  const env = resolveEnv({ OPENCODE_CONFIG: "./opencode.kade.jsonc" });
  assert.equal(env.OPENCODE_CONFIG, path.resolve(__dirname, "..", "opencode.kade.jsonc"));
});

test("resolveEnv leaves absolute paths and non-path values untouched", () => {
  const { resolveEnv } = require("../src/providers");
  const env = resolveEnv({
    FOO: "/abs/path",
    BAR: "literal-value",
    BAZ: "~/x",
  });
  assert.equal(env.FOO, "/abs/path");
  assert.equal(env.BAR, "literal-value");
  assert.equal(env.BAZ.indexOf("x") > -1, true);
});

test("buildArgs passes grok single-turn flag and model", () => {
  const args = buildArgs(
    {
      subcommand: [],
      prompt_flag: "-p",
      model_flag: "--model",
      cwd_flag: "--cwd",
      extra_args: [],
    },
    "summarize",
    "/repo",
    "grok-composer-2.5-fast",
    "grok"
  );
  assert.deepEqual(args, [
    "--model",
    "grok-composer-2.5-fast",
    "--cwd",
    "/repo",
    "-p",
    "summarize",
  ]);
});

// --- launch / appendCapped: process hardening (uses node itself as the child) ---

test("appendCapped keeps the tail when over the cap", () => {
  assert.equal(appendCapped("abc", "def", 10), "abcdef");
  assert.equal(appendCapped("abcdef", "gh", 4), "efgh");
  assert.equal(appendCapped("", "xyz", 2), "yz");
});

test("launch captures output and exit code", async () => {
  const { exitCode, stdout } = await launch(
    process.execPath,
    ["-e", "console.log('hello from child')"],
    { timeoutSeconds: 10, tag: "test" }
  );
  assert.equal(exitCode, 0);
  assert.match(stdout, /hello from child/);
});

test("launch resolves with the child's non-zero exit code", async () => {
  const { exitCode } = await launch(process.execPath, ["-e", "process.exit(3)"], {
    timeoutSeconds: 10,
    tag: "test",
  });
  assert.equal(exitCode, 3);
});

test("launch times out, kills the process group, and resolves -1", async () => {
  const started = Date.now();
  const { exitCode, stderr } = await launch(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { timeoutSeconds: 1, tag: "test-timeout" }
  );
  const elapsed = Date.now() - started;
  assert.equal(exitCode, -1);
  assert.match(stderr, /timeout after 1s/);
  assert.ok(elapsed < 20000, `should settle quickly after kill, took ${elapsed}ms`);
});

test("launch caps runaway stdout instead of buffering forever", async () => {
  const { exitCode, stdout } = await launch(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024)); console.log('TAIL-MARKER')"],
    { timeoutSeconds: 30, tag: "test-cap" }
  );
  assert.equal(exitCode, 0);
  assert.ok(stdout.length <= 1024 * 1024 + 100, `expected capped output, got ${stdout.length}`);
  assert.match(stdout, /TAIL-MARKER/); // the tail survives
});

test("launch resolves exitCode 1 when the command does not exist", async () => {
  const { exitCode, stderr } = await launch("kade-no-such-command-xyz", [], {
    timeoutSeconds: 10,
    tag: "test-spawn-error",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /ENOENT/);
});

test("buildArgs pins a session id for a fresh claude run", () => {
  const adapter = {
    subcommand: [],
    prompt_flag: "-p",
    session_flag: "--session-id",
    resume_flag: "--resume",
    extra_args: ["--dangerously-skip-permissions"],
  };
  const args = buildArgs(adapter, "go", "/repo", null, "claude", { sessionId: "abc-123" });
  assert.deepEqual(args, ["--session-id", "abc-123", "-p", "go", "--dangerously-skip-permissions"]);
});

test("buildArgs resumes a claude session with the decision prompt", () => {
  const adapter = {
    subcommand: [],
    prompt_flag: "-p",
    session_flag: "--session-id",
    resume_flag: "--resume",
    extra_args: [],
  };
  const args = buildArgs(adapter, "use staging", "/repo", null, "claude", {
    sessionId: "abc-123",
    resume: true,
  });
  assert.deepEqual(args, ["--resume", "abc-123", "-p", "use staging"]);
});

test("buildArgs ignores session flags for providers that lack them", () => {
  const adapter = { subcommand: ["run"], prompt_as_positional: true, extra_args: [] };
  const args = buildArgs(adapter, "fix it", "/repo", null, "opencode", { sessionId: "abc" });
  assert.deepEqual(args, ["run", "fix it"]);
});
