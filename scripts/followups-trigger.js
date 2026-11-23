// OpenClaw automation trigger.script. Read only the owning agent's workspace list.
// EDIT: this runs inside OpenClaw's script sandbox and cannot import local modules; keep TIMEZONE equal to config/crew.json "timezone".
const TIMEZONE = "UTC";
const LOCALE = "en"; // config "locale": "en" or "zh-CN". This trigger cannot import lexicon.mjs, so the one sentence it sends is in the table below (tests/trigger-literals-consistency.test.mjs keeps both languages in step).
const LX = ({
  "zh-CN": { due: (n, today, tz, ids) => `FOLLOWUPS.md 到期候选 ${n} 项（${today} ${tz}）：${ids.join("、")}。请回读清单并判断提醒价值。` },
  "en": { due: (n, today, tz, ids) => `FOLLOWUPS.md due candidates: ${n} (${today} ${tz}): ${ids.join(", ")}. Please re-read the list and judge whether a reminder is worthwhile.` },
})[LOCALE];
const result = await read({ path: "FOLLOWUPS.md" });
if (!result || result.isError || result.kind === "truncated" || typeof result.content !== "string") {
  throw new Error("FOLLOWUPS.md could not be read completely");
}

const blocks = [...result.content.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
if (blocks.length !== 1) throw new Error("FOLLOWUPS.md must contain one JSON index");
let index;
try {
  index = JSON.parse(blocks[0][1]);
} catch {
  throw new Error("FOLLOWUPS.md JSON index is invalid");
}
if (!index || !Array.isArray(index.items)) throw new Error("FOLLOWUPS.md items must be an array");

const localStamp = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const parts = Object.fromEntries(localStamp.formatToParts(new Date()).map(({ type, value }) => [type, value]));
const today = `${parts.year}-${parts.month}-${parts.day}`;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => typeof value === "string" && datePattern.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dayNumber = value => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
const weekStart = dayNumber(today) - ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7);

const seen = new Set();
for (const item of index.items) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() || seen.has(item.id)) {
    throw new Error("FOLLOWUPS.md has an invalid or duplicate item ID");
  }
  seen.add(item.id);
  if (!validDate(item.nextReview)) throw new Error(`FOLLOWUPS.md invalid nextReview: ${item.id}`);
  if (item.lastMentionedDate !== null && !validDate(item.lastMentionedDate)) {
    throw new Error(`FOLLOWUPS.md invalid lastMentionedDate: ${item.id}`);
  }
  if (!["active", "paused", "stopped", "archived"].includes(item.status) ||
      typeof item.withoutDeadline !== "boolean") {
    throw new Error(`FOLLOWUPS.md invalid status or withoutDeadline: ${item.id}`);
  }
}

const undatedAlreadyMentionedThisWeek = index.items.some(item =>
  item.withoutDeadline && item.lastMentionedDate !== null &&
  dayNumber(item.lastMentionedDate) >= weekStart && item.lastMentionedDate <= today);
const eligible = index.items.filter(item =>
  item.status === "active" && item.nextReview <= today &&
  item.lastMentionedDate !== today &&
  (!item.withoutDeadline || !undatedAlreadyMentionedThisWeek));
const dated = eligible.filter(item => !item.withoutDeadline);
const undated = eligible.filter(item => item.withoutDeadline)
  .sort((left, right) => left.nextReview.localeCompare(right.nextReview) || left.id.localeCompare(right.id));
const due = [...dated, ...undated.slice(0, 1)];

if (due.length === 0) return { fire: false };
return {
  fire: true,
  message: LX.due(due.length, today, TIMEZONE, due.map(item => item.id)),
};
