/** Pure helpers for KADE plan JSON — parsing, validation, follow-up extraction. */

const PLAN_TAG_RE = /<task-plan>([\s\S]*?)<\/task-plan>/g;
const DECISION_TAG_RE = /<needs-decision>([\s\S]*?)<\/needs-decision>/g;

// CLI entry: accept a bare JSON plan or one wrapped in <task-plan> tags. Throws
// on invalid input (the caller reports and exits non-zero).
function parsePlan(raw) {
  const match = String(raw).match(/<task-plan>([\s\S]*?)<\/task-plan>/);
  const json = match ? match[1].trim() : String(raw).trim();
  return JSON.parse(json);
}

// Pull the LAST <task-plan> block out of agent output (the final one wins — an
// agent may legitimately quote an example earlier). Returns null when absent or
// unparseable; extraction failure must never fail a completed task.
function extractPlan(output) {
  if (!output) return null;
  const matches = [...String(output).matchAll(PLAN_TAG_RE)];
  if (matches.length === 0) return null;
  try {
    const plan = JSON.parse(matches[matches.length - 1][1].trim());
    if (!plan || !Array.isArray(plan.tasks)) return null;
    return plan;
  } catch {
    return null;
  }
}

// Pull the LAST <needs-decision> block: the agent is blocked on a human choice.
// Its text (the question + options) is shown on the ticket and posted as a
// comment; the ticket parks in Review until the human answers. Returns null when
// absent — a normal completion. Takes precedence over any <task-plan> block.
function extractDecision(output) {
  if (!output) return null;
  const matches = [...String(output).matchAll(DECISION_TAG_RE)];
  if (matches.length === 0) return null;
  const text = matches[matches.length - 1][1].trim();
  return text || null;
}

// Prompt sent when a human answers a parked decision. The provider session is
// resumed (page id = session id), so the agent already has full context — we
// only hand it the answer.
function resumePreamble(decision) {
  return [
    "[KADE] Resuming your earlier session. You had ended with a <needs-decision> block; the human has now answered below.",
    "Continue the task using this decision. Finish it, or — if you hit another blocking choice — end with a fresh <needs-decision> block.",
    "",
    "Human decision:",
    decision || "(no explicit answer was given — proceed with your best judgment)",
  ].join("\n");
}

// Clamp a plan to a task budget (top-level + subtasks combined) and drop
// entries without a usable title. Never throws — bad entries are skipped.
function sanitizeTasks(tasks, { maxTasks = 20 } = {}) {
  let budget = maxTasks;
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (budget <= 0) break;
    if (!t || typeof t.title !== "string" || !t.title.trim()) continue;
    const copy = { ...t };
    budget -= 1;
    if (Array.isArray(t.subtasks)) {
      copy.subtasks = [];
      for (const s of t.subtasks) {
        if (budget <= 0) break;
        if (!s || typeof s.title !== "string" || !s.title.trim()) continue;
        copy.subtasks.push(s);
        budget -= 1;
      }
    }
    out.push(copy);
  }
  return out;
}

// Group plan relation wishes into one batched write per (page, property).
// Notion relation updates REPLACE the array, so per-relation writes would
// clobber each other on tasks with several blockers. idMap: plan id → page id.
function relationWrites(tasks, idMap, { blockedByProp, relatedToProp }) {
  const writes = new Map(); // `${pageId}|${prop}` → { pageId, property, ids: Set }
  const add = (pageId, property, relId) => {
    if (!pageId || !relId || pageId === relId) return;
    const key = `${pageId}|${property}`;
    if (!writes.has(key)) writes.set(key, { pageId, property, ids: new Set() });
    writes.get(key).ids.add(relId);
  };
  for (const t of tasks || []) {
    const pageId = idMap[t.id];
    if (!pageId) continue;
    for (const b of t.blocked_by || []) add(pageId, blockedByProp, idMap[b]);
    for (const r of t.related || []) add(pageId, relatedToProp, idMap[r]);
  }
  return [...writes.values()].map((w) => ({ ...w, ids: [...w.ids] }));
}

// Instructions prepended to every dispatched prompt (when orchestration is on)
// teaching the agent how to schedule follow-up work after itself.
function orchestrationPreamble({ maxTasks = 20 } = {}) {
  return [
    "[KADE] You are one autonomous step in a larger Notion-driven workflow, running unattended in the repo you were started in.",
    "Complete the task below yourself. If — and only if — the work splits into concrete follow-ups that outlive this run, end your reply with exactly one <task-plan> block of raw JSON:",
    "<task-plan>",
    '{"tasks":[{"id":"t1","title":"short title","description":"fully self-contained instructions","provider":"claude","model":"sonnet","priority":"medium","blocked_by":[],"related":[],"tags":[]}]}',
    "</task-plan>",
    `Rules: at most ${maxTasks} tasks; ids unique within the plan; every description must stand alone (the next agent sees ONLY its own description — not this conversation, not your output); provider/model/priority/tags are optional; blocked_by and related reference plan ids; never plan work you already completed. Tasks you emit are auto-scheduled after you finish. If no follow-ups are needed, emit no block.`,
    "",
    "If — and only if — you cannot proceed without a decision that only the human can make, do NOT guess. End your reply with exactly one <needs-decision> block. Write the question the way a CLI harness would prompt the user, and list concrete options as a numbered list when there is a choice:",
    "<needs-decision>",
    "Your question, phrased for a human.",
    "",
    "1. First option — short description",
    "2. Second option — short description",
    "</needs-decision>",
    "The ticket then moves to In Review with that prompt on the page; when the human answers and sets Status → In Progress, you resume this same session with their decision. Emit at most one of <task-plan> or <needs-decision> — a decision block wins and pauses the task.",
    "",
    "Task:",
  ].join("\n");
}

module.exports = {
  parsePlan,
  extractPlan,
  extractDecision,
  resumePreamble,
  sanitizeTasks,
  relationWrites,
  orchestrationPreamble,
};
