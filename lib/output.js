/** Pure helpers for shaping agent output before writing it to Notion. */

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
}

// <task-plan>/<needs-decision> are machine directives, not content — the poller
// parses them (lib/plan.js) and renders the decision separately. Left in the
// output they dump a raw JSON blob onto the Notion page. Strip them before write.
const CONTROL_BLOCK_RE =
  /<(task-plan|needs-decision)>[\s\S]*?<\/\1>/g;

function stripControlBlocks(text) {
  return String(text || "").replace(CONTROL_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

function chunkText(text, size = 2000) {
  const str = String(text || "");
  if (!str) return [];
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    let end = Math.min(i + size, str.length);
    if (end < str.length) {
      const code = str.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(str.slice(i, end));
    i = end;
  }
  return chunks;
}

// --- Markdown → Notion blocks ------------------------------------------------
// Agents emit GitHub-flavored markdown; Notion's API wants typed blocks. Dumping
// the raw text into paragraphs (the old behavior) renders `##`, `- `, and code
// fences as literal characters. This is a deliberately small line-based parser:
// headings, lists, quotes, dividers, fenced code, and inline **bold**/*italic*/
// `code`/[links]. ponytail: no tables/nested lists/images — agents rarely emit
// them and Notion's API makes them costly; add when output actually needs it.

const RT_MAX = 2000;

// Notion 400s on unknown code languages, so map the ones agents actually emit
// and fall back to plain text for the rest.
const CODE_LANGS = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html",
  "java", "javascript", "json", "kotlin", "less", "lua", "makefile", "markdown",
  "php", "plain text", "powershell", "python", "ruby", "rust", "scss", "shell",
  "sql", "swift", "typescript", "xml", "yaml",
]);
const LANG_ALIASES = {
  js: "javascript", ts: "typescript", jsonc: "json", py: "python", rb: "ruby",
  sh: "shell", zsh: "shell", "c++": "c++", golang: "go", yml: "yaml", md: "markdown",
};
function codeLang(raw) {
  const l = (raw || "").toLowerCase();
  const mapped = LANG_ALIASES[l] || l;
  return CODE_LANGS.has(mapped) ? mapped : "plain text";
}

// A rich_text run's `content` is capped at 2000 chars, so long spans split into
// several runs sharing the same annotations/link.
function richRuns(content, annotations, link) {
  return chunkText(content, RT_MAX).map((c) => ({
    type: "text",
    text: { content: c, ...(link ? { link: { url: link } } : {}) },
    ...(annotations ? { annotations } : {}),
  }));
}

// Inline markdown → rich_text array. Unmatched markers stay literal.
function inlineRich(text) {
  const re =
    /\*\*([^*]+)\*\*|(?<![*\w])\*([^*]+)\*(?![*\w])|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  const out = [];
  let last = 0;
  let m;
  const push = (content, ann, link) => {
    if (content) out.push(...richRuns(content, ann, link));
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    if (m[1] != null) push(m[1], { bold: true });
    else if (m[2] != null) push(m[2], { italic: true });
    else if (m[3] != null) push(m[3], { code: true });
    else if (m[4] != null) push(m[4], null, m[5]);
    last = re.lastIndex;
  }
  push(text.slice(last));
  return out;
}

function textBlock(type, text) {
  return { object: "block", type, [type]: { rich_text: inlineRich(text) } };
}

function mdToBlocks(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = codeLang(fence[1]);
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richRuns(buf.join("\n")), language: lang },
      });
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { blocks.push(textBlock(`heading_${h[1].length}`, h[2])); i++; continue; }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++; continue;
    }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { blocks.push(textBlock("quote", q[1])); i++; continue; }

    const b = line.match(/^\s*[-*+]\s+(.*)$/);
    if (b) { blocks.push(textBlock("bulleted_list_item", b[1])); i++; continue; }

    const n = line.match(/^\s*\d+\.\s+(.*)$/);
    if (n) { blocks.push(textBlock("numbered_list_item", n[1])); i++; continue; }

    blocks.push(textBlock("paragraph", line));
    i++;
  }
  return blocks;
}

module.exports = { stripAnsi, chunkText, mdToBlocks, inlineRich, stripControlBlocks };
