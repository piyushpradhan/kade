const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isOutputMarker,
  blockText,
  groupTemplates,
  matchTemplate,
  templateLabel,
} = require("../src/notion-client");

const kadeProps = {
  Provider: {}, Assigned: {}, Status: {},
};
const tasksDb = (id, page) => ({
  id, parent: { page_id: page },
  title: [{ plain_text: "Tasks" }], properties: kadeProps,
});
const projectsDb = (id, page) => ({
  id, parent: { page_id: page },
  title: [{ plain_text: "Projects" }], properties: {},
});

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

test("groupTemplates pairs Tasks+Projects DBs sharing a parent page", () => {
  const dbs = [
    tasksDb("t1", "pageA"), projectsDb("p1", "pageA"),
    tasksDb("t2", "pageB"), projectsDb("p2", "pageB"),
    tasksDb("t3", "pageC"), // orphan: no Projects sibling → dropped
    projectsDb("p4", "pageD"), // orphan: no Tasks sibling → dropped
  ];
  const templates = groupTemplates(dbs);
  assert.deepEqual(
    templates.map((t) => [t.pageId, t.tasksDbId, t.projectsDbId]).sort(),
    [["pageA", "t1", "p1"], ["pageB", "t2", "p2"]]
  );
});

test("groupTemplates ignores a non-KADE Tasks DB (missing marker props)", () => {
  const bare = { id: "x", parent: { page_id: "pZ" }, title: [{ plain_text: "Tasks" }], properties: {} };
  assert.deepEqual(groupTemplates([bare, projectsDb("p", "pZ")]), []);
});

test("groupTemplates tolerates trailing space / split runs in DB titles", () => {
  const dbs = [
    { id: "t", parent: { page_id: "pS" }, title: [{ plain_text: "Tasks " }], properties: kadeProps },
    { id: "p", parent: { page_id: "pS" }, title: [{ plain_text: "Pro" }, { plain_text: "jects" }], properties: {} },
  ];
  assert.deepEqual(
    groupTemplates(dbs).map((t) => [t.tasksDbId, t.projectsDbId]),
    [["t", "p"]]
  );
});

test("matchTemplate resolves exact, substring, and errors on miss/ambiguous", () => {
  const ts = [
    { name: "Telemetry", tasksDbId: "t1" },
    { name: "Telemetry Archive", tasksDbId: "t2" },
    { name: "Billing", tasksDbId: "t3" },
  ];
  assert.equal(matchTemplate(ts, "billing").tasksDbId, "t3"); // case-insensitive
  assert.equal(matchTemplate(ts, "Telemetry").tasksDbId, "t1"); // exact beats substring
  assert.throws(() => matchTemplate(ts, "tele"), /matches 2 templates/); // ambiguous substring
  assert.throws(() => matchTemplate(ts, "nope"), /No KADE template/);
});

test("templateLabel qualifies duplicate parent-page names with the short page id", () => {
  const ts = [
    { name: "KADE setup", pageId: "11111111-2222-3333-4444-555555555555" },
    { name: "KADE setup", pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    { name: "Telemetry", pageId: "deadbeef-0000-0000-0000-000000000000" },
  ];
  assert.equal(templateLabel(ts, ts[0]), "KADE setup [11111111]");
  assert.equal(templateLabel(ts, ts[1]), "KADE setup [aaaaaaaa]");
  // Unique names stay unqualified.
  assert.equal(templateLabel(ts, ts[2]), "Telemetry");
  // A single template never collides → no bracket.
  const solo = [{ name: "Solo", pageId: "11111111-2222-3333-4444-555555555555" }];
  assert.equal(templateLabel(solo, solo[0]), "Solo");
  // Untitled pages fall back to a stable placeholder and still disambiguate.
  const untitled = [
    { name: "", pageId: "11111111-2222-3333-4444-555555555555" },
    { name: "", pageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ];
  assert.equal(templateLabel(untitled, untitled[0]), "Untitled [11111111]");
});
