const test = require("node:test");
const assert = require("node:assert/strict");
const { isOutputMarker, blockText } = require("../src/notion-client");

function heading3(text) {
  return { type: "heading_3", heading_3: { rich_text: [{ plain_text: text }] } };
}
function paragraph(text) {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

test("isOutputMarker flags kade-appended Output / Error output headings", () => {
  assert.equal(isOutputMarker(heading3("Output")), true);
  assert.equal(isOutputMarker(heading3("Error output")), true);
  assert.equal(isOutputMarker(heading3("Output ")), true);
  assert.equal(isOutputMarker(heading3("Summary")), false);
  assert.equal(isOutputMarker(paragraph("Output")), false);
});

test("blockText extracts plain text from any block type", () => {
  assert.equal(blockText(paragraph("hello world")), "hello world");
  assert.equal(blockText(heading3("Title")), "Title");
  assert.equal(blockText({ type: "code", code: {} }), "");
});
