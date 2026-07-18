const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DECISION_MARKER,
  DECISION_COMMENT_PREFIX,
  parseDecision,
  buildDecisionBlocks,
  formatDecisionComment,
} = require("../lib/decision");

test("parseDecision returns the whole text as the question when there are no options", () => {
  const r = parseDecision("Deploy to prod or staging?");
  assert.equal(r.question, "Deploy to prod or staging?");
  assert.deepEqual(r.options, []);
});

test("parseDecision splits a numbered list into options", () => {
  const r = parseDecision(
    "Where should we deploy?\n\n1. Production — live traffic\n2. Staging — safe dry run\n3. Cancel"
  );
  assert.equal(r.question, "Where should we deploy?");
  assert.deepEqual(r.options, [
    "Production — live traffic",
    "Staging — safe dry run",
    "Cancel",
  ]);
});

test("parseDecision accepts lettered and bullet options", () => {
  const lettered = parseDecision("Pick one:\na) Alpha\nb) Beta");
  assert.equal(lettered.question, "Pick one:");
  assert.deepEqual(lettered.options, ["Alpha", "Beta"]);

  const bullets = parseDecision("Pick:\n- red\n- blue");
  assert.deepEqual(bullets.options, ["red", "blue"]);
});

test("parseDecision ignores a single option-shaped line (not a real choice list)", () => {
  const r = parseDecision("Remember:\n1. only one thing");
  assert.equal(r.question, "Remember:\n1. only one thing");
  assert.deepEqual(r.options, []);
});

test("parseDecision trims empty input", () => {
  assert.deepEqual(parseDecision(""), { question: "", options: [], raw: "" });
  assert.deepEqual(parseDecision("   "), { question: "", options: [], raw: "" });
});

test("buildDecisionBlocks starts with the Decision needed marker heading", () => {
  const blocks = buildDecisionBlocks("Ship it?");
  assert.equal(blocks[0].type, "heading_3");
  assert.equal(blocks[0].heading_3.rich_text[0].text.content, DECISION_MARKER);
});

test("buildDecisionBlocks frames the prompt like a harness and includes how-to", () => {
  const blocks = buildDecisionBlocks("Ship it?\n\n1. Yes\n2. No", {
    hasDecisionProp: true,
  });
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes("callout"), "callout framing the pause");
  assert.ok(types.includes("numbered_list_item"), "options as numbered list");
  assert.ok(types.includes("divider"), "divider before how-to");

  const callout = blocks.find((b) => b.type === "callout");
  assert.match(
    callout.callout.rich_text.map((t) => t.text.content).join(""),
    /Claude Code|OpenCode/
  );
  assert.equal(callout.callout.color, "yellow_background");

  // How-to mentions the Decision property when available.
  const body = JSON.stringify(blocks);
  assert.match(body, /at the top of this page/);
  assert.match(body, /In Progress/);
});

test("buildDecisionBlocks falls back to comment-only instructions without Decision prop", () => {
  const blocks = buildDecisionBlocks("Ship it?", { hasDecisionProp: false });
  const body = JSON.stringify(blocks);
  assert.match(body, /page comment/i);
  // Should not tell the user to fill a property that doesn't exist.
  assert.doesNotMatch(body, /at the top of this page/);
});

test("formatDecisionComment includes prefix, question, options, and resume hint", () => {
  const text = formatDecisionComment("Pick:\n1. A\n2. B");
  assert.ok(text.startsWith(DECISION_COMMENT_PREFIX));
  assert.match(text, /Pick:/);
  assert.match(text, /1\. A/);
  assert.match(text, /2\. B/);
  assert.match(text, /In Progress/);
});
