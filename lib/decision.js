/**
 * Pure helpers for the human-decision park/resume flow.
 *
 * Agents emit free-text <needs-decision> blocks (question + optional options).
 * We parse that into a structure and render it as a harness-style Notion UI —
 * the same content a user would see if Claude Code / OpenCode had paused for
 * an AskUserQuestion-style prompt.
 */

const { mdToBlocks } = require("./output");

// Heading marker written onto the page. Also registered as an output marker so
// getTaskDescription / clearPriorOutput treat the decision section as
// KADE-written (not part of the original task prompt).
const DECISION_MARKER = "Decision needed";

// Comment prefix so getDecisionReply can ignore KADE's own question post.
const DECISION_COMMENT_PREFIX = "KADE needs a decision:";

// Lines that look like selectable options: "1. foo", "a) bar", "- baz".
const OPTION_LINE_RE = /^\s*(?:[-*+]|\d+[.)]|[A-Za-z][.)])\s+(.+)$/;

/**
 * Split free-text decision content into a question + options list.
 * Options are only recognized when ≥2 option-shaped lines appear in sequence
 * (blank lines allowed between). Otherwise the whole text is the question.
 */
function parseDecision(text) {
  const raw = String(text || "").trim();
  if (!raw) return { question: "", options: [], raw: "" };

  const lines = raw.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!OPTION_LINE_RE.test(lines[i])) continue;
    const options = [];
    for (let j = i; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j])) continue;
      const m = lines[j].match(OPTION_LINE_RE);
      if (!m) break;
      const label = m[1].trim();
      if (label) options.push(label);
    }
    if (options.length >= 2) {
      const question = lines.slice(0, i).join("\n").trim();
      return { question: question || raw, options, raw };
    }
  }
  return { question: raw, options: [], raw };
}

function rt(content, annotations) {
  return [
    {
      type: "text",
      text: { content: String(content).slice(0, 2000) },
      ...(annotations ? { annotations } : {}),
    },
  ];
}

function block(type, rich_text, extra = {}) {
  return { object: "block", type, [type]: { rich_text, ...extra } };
}

/**
 * Build Notion blocks that mirror a harness decision prompt:
 *   marker heading → callout framing → question → numbered options → how-to.
 *
 * @param {string} questionText raw <needs-decision> body
 * @param {{ hasDecisionProp?: boolean }} opts
 */
function buildDecisionBlocks(questionText, { hasDecisionProp = true } = {}) {
  const { question, options } = parseDecision(questionText);
  const blocks = [];

  blocks.push(block("heading_3", rt(DECISION_MARKER)));

  blocks.push(
    block(
      "callout",
      rt(
        "The agent paused and needs your answer to continue — the same kind of prompt you'd see in Claude Code or OpenCode."
      ),
      { icon: { type: "emoji", emoji: "❓" }, color: "yellow_background" }
    )
  );

  // Question body: render markdown so agents can bold/list freely.
  if (question) {
    const qBlocks = mdToBlocks(question);
    blocks.push(...(qBlocks.length ? qBlocks : [block("paragraph", rt(question))]));
  }

  if (options.length >= 2) {
    blocks.push(block("paragraph", rt("Options", { bold: true })));
    for (const opt of options) {
      blocks.push(block("numbered_list_item", rt(opt)));
    }
  }

  blocks.push({ object: "block", type: "divider", divider: {} });
  blocks.push(block("paragraph", rt("How to answer", { bold: true })));

  const steps = hasDecisionProp
    ? [
        "1. Type your choice in the **Decision** property at the top of this page (or reply in a page comment).",
        "2. Set **Status** → **In Progress**.",
        "",
        "The agent resumes this same session with your answer — it will not re-run from scratch.",
      ]
    : [
        "1. Reply in a **page comment** with your answer.",
        "2. Set **Status** → **In Progress**.",
        "",
        "The agent resumes this same session with your answer — it will not re-run from scratch.",
      ];
  blocks.push(...mdToBlocks(steps.join("\n")));

  return blocks;
}

/**
 * Plain-text body for the notification comment (and any non-block surfaces).
 */
function formatDecisionComment(questionText) {
  const { question, options } = parseDecision(questionText);
  const parts = [DECISION_COMMENT_PREFIX, "", question || String(questionText || "").trim()];
  if (options.length >= 2) {
    parts.push("", "Options:");
    options.forEach((o, i) => parts.push(`${i + 1}. ${o}`));
  }
  parts.push(
    "",
    "→ Write your answer in the Decision property (or reply here), then set Status → In Progress."
  );
  return parts.join("\n");
}

module.exports = {
  DECISION_MARKER,
  DECISION_COMMENT_PREFIX,
  parseDecision,
  buildDecisionBlocks,
  formatDecisionComment,
};
