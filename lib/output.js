/** Pure helpers for shaping agent output before writing it to Notion. */

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
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

module.exports = { stripAnsi, chunkText };
