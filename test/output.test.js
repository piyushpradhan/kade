const test = require("node:test");
const assert = require("node:assert/strict");
const { stripAnsi, chunkText } = require("../lib/output");

test("stripAnsi removes terminal escape sequences", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m text"), "red text");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi(undefined), "");
});

test("chunkText splits output into 2000-char blocks", () => {
  const chunks = chunkText("a".repeat(4500));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 2000);
  assert.equal(chunks[2].length, 500);
});

test("chunkText returns empty array for empty input", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText(null), []);
});

test("chunkText does not split surrogate pairs", () => {
  const pair = "\ud83d\ude00";
  const text = "x".repeat(1999) + pair + "y";
  const chunks = chunkText(text, 2000);
  const joined = chunks.join("");
  assert.equal(joined, text);
  assert.ok(!chunks[0].endsWith("\ud83d"));
});
