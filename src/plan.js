"use strict";
// An agent's plan, from TodoWrite (the whole list on every call) or TaskCreate / TaskUpdate (one task at a time;
// Claude Code's default since v2.1.268). completedAt and inProgressSince are set only when we saw the change happen.

const ITEMS = 100, EARLIER = 200;
const STATUS = new Set(["pending", "in_progress", "completed"]);
const norm = (s) => (STATUS.has(s) ? s : "pending");

function empty() { return { items: [], earlier: [], updatedAt: null, source: null }; }

/** Next version of an item, carrying times over from the previous version. */
function advance(old, next, t) {
  const it = { ...next };
  if (old && old.id != null) it.id = old.id;
  if (it.status === "in_progress") it.inProgressSince = old && old.status === "in_progress" ? old.inProgressSince : t;
  if (it.status === "completed") it.completedAt = !old ? null : old.status === "completed" ? old.completedAt : t;
  return it;
}

/** Completed items that drop out of the list are kept in `earlier`, so today's done count survives a new list. */
function archive(plan, items, t) {
  for (const it of items) if (it.status === "completed") plan.earlier.push({ ...it, archivedAt: t });
  if (plan.earlier.length > EARLIER) plan.earlier.splice(0, plan.earlier.length - EARLIER);
}

/** TodoWrite: replaces the list, matching items by their text. */
function todos(plan, list, t) {
  const prev = new Map();
  for (const it of plan.items) { if (!prev.has(it.content)) prev.set(it.content, []); prev.get(it.content).push(it); }
  plan.items = (Array.isArray(list) ? list : []).slice(0, ITEMS).filter((x) => x && x.content).map((x) =>
    advance(prev.get(x.content)?.shift(), { content: x.content, status: norm(x.status), activeForm: x.activeForm || null }, t));
  for (const rest of prev.values()) archive(plan, rest, t);
  plan.updatedAt = t; plan.source = "todos";
}

/** TaskCreate, once its result gives the task id. */
function create(plan, { subject, activeForm } = {}, id, t) {
  if (!subject) return;
  if (plan.source !== "tasks") { archive(plan, plan.items, t); plan.items = []; }
  plan.items.push({ id: id == null ? String(plan.items.length + 1) : String(id), content: subject, status: "pending", activeForm: activeForm || null });
  if (plan.items.length > ITEMS) plan.items.shift();
  plan.updatedAt = t; plan.source = "tasks";
}

/** TaskUpdate: status, text or deletion of one task. */
function update(plan, { taskId, status, subject, activeForm } = {}, t) {
  const i = plan.items.findIndex((x) => x.id === String(taskId));
  if (i < 0) return;
  const old = plan.items[i];
  if (status === "deleted") plan.items.splice(i, 1);
  else plan.items[i] = advance(old, { ...old, status: status ? norm(status) : old.status, content: subject || old.content, activeForm: activeForm || old.activeForm }, t);
  plan.updatedAt = t;
}

/** The in-progress item, as "step 4 of 9". */
function current(plan) {
  const i = plan.items.findIndex((x) => x.status === "in_progress");
  if (i < 0) return null;
  const it = plan.items[i];
  return { text: it.content, activeForm: it.activeForm, since: it.inProgressSince, step: i + 1, of: plan.items.length };
}

/**
 * done / inProgress / pending count the current list. doneToday counts items (current or earlier lists) whose
 * completedAt falls on `day`; items already completed when first seen have no completedAt, so they never count.
 */
function counts(plan, day, localDate) {
  const c = { done: 0, doneToday: 0, inProgress: 0, pending: 0 };
  for (const it of plan.items) c[it.status === "completed" ? "done" : it.status === "in_progress" ? "inProgress" : "pending"]++;
  for (const it of [...plan.items, ...plan.earlier]) if (it.status === "completed" && it.completedAt && localDate(it.completedAt) === day) c.doneToday++;
  return c;
}

module.exports = { empty, todos, create, update, current, counts };
