const test = require("node:test");
const assert = require("node:assert/strict");
const { stripAnsi, chunkText, stripControlBlocks } = require("../lib/output");

test("stripControlBlocks removes task-plan and needs-decision blobs", () => {
  const out =
    'Done the work.\n\n<task-plan>\n{"tasks":[]}\n</task-plan>\n\nTrailing note.';
  assert.equal(stripControlBlocks(out), "Done the work.\n\nTrailing note.");
  assert.equal(
    stripControlBlocks("before\n<needs-decision>\npick A or B\n</needs-decision>"),
    "before"
  );
  assert.equal(stripControlBlocks("<task-plan>\n{}\n</task-plan>"), "");
  assert.equal(stripControlBlocks("no blocks here"), "no blocks here");
});

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

const { mdToBlocks, inlineRich } = require("../lib/output");

test("mdToBlocks maps headings, lists, quote, divider to typed blocks", () => {
  const blocks = mdToBlocks(
    "# Title\n\n## Sub\n\nSome text.\n\n- one\n- two\n\n1. first\n2. second\n\n> a quote\n\n---"
  );
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, [
    "heading_1",
    "heading_2",
    "paragraph",
    "bulleted_list_item",
    "bulleted_list_item",
    "numbered_list_item",
    "numbered_list_item",
    "quote",
    "divider",
  ]);
  assert.equal(blocks[0].heading_1.rich_text[0].text.content, "Title");
  assert.equal(blocks[3].bulleted_list_item.rich_text[0].text.content, "one");
});

test("mdToBlocks turns a fenced block into a code block with a mapped language", () => {
  const blocks = mdToBlocks("intro\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nafter");
  const code = blocks.find((b) => b.type === "code");
  assert.ok(code, "expected a code block");
  assert.equal(code.code.language, "javascript");
  assert.equal(code.code.rich_text[0].text.content, "const x = 1;\nconsole.log(x);");
});

test("mdToBlocks falls back to plain text for unknown code languages", () => {
  const [code] = mdToBlocks("```wat\nhuh\n```");
  assert.equal(code.code.language, "plain text");
});

test("inlineRich parses bold, code, and links", () => {
  const runs = inlineRich("do **this** with `npm run setup` see [docs](https://x.com)");
  const bold = runs.find((r) => r.annotations?.bold);
  const code = runs.find((r) => r.annotations?.code);
  const link = runs.find((r) => r.text.link);
  assert.equal(bold.text.content, "this");
  assert.equal(code.text.content, "npm run setup");
  assert.equal(link.text.content, "docs");
  assert.equal(link.text.link.url, "https://x.com");
});

test("mdToBlocks splits code content over the 2000-char rich_text cap", () => {
  const [code] = mdToBlocks("```\n" + "x".repeat(4500) + "\n```");
  assert.equal(code.code.rich_text.length, 3);
  assert.ok(code.code.rich_text.every((r) => r.text.content.length <= 2000));
});
