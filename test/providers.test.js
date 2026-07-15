const test = require("node:test");
const assert = require("node:assert/strict");
const { buildArgs } = require("../src/providers");

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
