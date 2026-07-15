const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inferProvider,
  resolveModel,
  isValidModel,
  DEFAULT_MODEL,
} = require("../lib/models");

test("inferProvider detects provider from model id", () => {
  assert.equal(inferProvider("sonnet"), "claude");
  assert.equal(inferProvider("grok-4.5"), "grok");
  assert.equal(inferProvider("opencode-go/qwen3.7-plus"), "opencode");
  assert.equal(inferProvider("opencode/big-pickle"), "opencode");
});

test("resolveModel falls back to provider default", () => {
  assert.equal(resolveModel("claude", null), DEFAULT_MODEL.claude);
  assert.equal(resolveModel("grok", null), DEFAULT_MODEL.grok);
  assert.equal(resolveModel("opencode", "opencode-go/kimi-k2.6"), "opencode-go/kimi-k2.6");
});

test("isValidModel checks provider catalog", () => {
  assert.equal(isValidModel("claude", "opus"), true);
  assert.equal(isValidModel("grok", "sonnet"), false);
});
