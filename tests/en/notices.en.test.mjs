// English (locale en): every fixed sentence the programs send to the owner on Discord (or show on his approval cards).
// The table lists each sentence of lexicon().notices with the arguments it is called with and the exact English text that must come out;
// the second half checks the programs that build the texts, and that no Chinese character is left.
// Run: SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json node --test tests/en/notices.en.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { locale, lexicon } from '../../plugins/personal-inbox/lexicon.mjs';
import { approvalNoticeText } from '../../plugins/personal-inbox/approval-card.mjs';
import { buildTable, APPROVAL_EXPIRED_THREAD_TEXT } from '../../plugins/personal-inbox/pending-ledger.mjs';
import { decideClosing } from '../../plugins/personal-inbox/audit-gate.mjs';
import { cardTextOf, expiredNoticeText } from '../../plugins/personal-inbox/desktop-lock.mjs';
import { PROGRAM_NOTE } from '../../plugins/personal-inbox/sensitive-click.mjs';
import { TEXT_PRE, TEXT_POST } from '../../scripts/automation/reset-notice.mjs';
import { dueReminders } from '../../scripts/automation/timed-reminders.mjs';
import { summaryText } from '../../scripts/automation/quota-resume.mjs';
import { fmtDate, fmtDateTime } from '../../scripts/automation/gap-common.mjs';

assert.equal(locale(), 'en', 'run the tests in tests/en/ with SOLOFLEET_CONFIG=tests/fixtures/crew.test.en.json');
const N = lexicon('en').notices;
const HAN = /[\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const get = (o, p) => p.split('.').reduce((a, k) => a[k], o);

// [path in notices, arguments, exact English output]
const SENTENCES = [
  ["dateMD", [11, 22], "Nov 22"],
  ["dateTime", [11, 22, "09", "30"], "Nov 22 09:30"],
  ["titleQuote", ["<t>"], " \"<t>\""],
  ["approvalCard.noReason", null, "(no reason given)"],
  ["approvalCard.newCard", ["<@100000000000000001>", "<source>", "C-1", "<one>"], "<@100000000000000001> A new approval card is waiting in the approval channel: <source> (task card C-1) — <one>"],
  ["closing.source", null, "Closing confirmation"],
  ["closing.title", null, "Closing confirmation"],
  ["closing.jn", null, ", "],
  ["closing.reasons.duplicate", null, "duplicate submission, needs checking"],
  ["closing.reasons.unverifiable", null, "the result cannot be verified"],
  ["closing.reasons.unbound", null, "the Opus re-review binding cannot be verified"],
  ["closing.description", ["C-1", 3, "<reasons>"], "Card C-1, review round 3: <reasons>; only the owner can approve completing it. The approval is valid for this one card and this one closing only."],
  ["closing.botLine", ["<agent>", "C-1"], "\n— requested by bot: <agent>; task card: C-1"],
  ["closing.threadLine", ["L-1"], "; thread: L-1. The approval covers this one closing only."],
  ["closing.sessionFallback", ["<key>"], "(session <key>)"],
  ["closing.timeoutReason", null, "Not approved, so the closing did not go ahead"],
  ["desktopApproval.source", null, "Desktop operator: six kinds of action"],
  ["desktopApproval.title", null, "Six-kinds-of-action confirmation"],
  ["desktopApproval.timeoutReason", null, "Not approved, so nothing on the screen was touched"],
  ["desktopApproval.jn", null, ", "],
  ["desktopApproval.whatHead", null, "What: "],
  ["desktopApproval.whatMissing", null, "(the matter was not recorded)"],
  ["desktopApproval.programNote", null, "Recognized by the program, not reported by the Desktop operator. "],
  ["desktopApproval.approved", ["<programNote>"], ". Approves only this one screen call (void once used; the next one needs a new confirmation). <programNote>Requested by: Desktop operator. Task card: "],
  ["desktopApproval.linkTail", ["L-1"], "; thread: L-1."],
  ["desktopApproval.tail", ["<tid>"], " The Desktop operator wants to keep using the screen in thread <tid>; each further action of the six kinds needs a new confirmation."],
  ["desktopApproval.ambiguous", ["<list>", "<tid>"], "Several unfinished cards match this thread (<list>); unclear which (thread <tid>)"],
  ["desktopApproval.ambiguousMore", [3], " ... 3 cards in all"],
  ["desktopApproval.noCard", ["<tid>"], "No related task card found (thread <tid>)"],
  ["desktopApproval.selfCheckMarker", ["<t>"], "(self-check S<t>)"],
  ["desktopApproval.recognized.upload", null, "(auto) choose a file to upload"],
  ["desktopApproval.recognized.dialog", null, "(auto) click \"OK\" in a confirmation dialog on a web page"],
  ["desktopApproval.recognized.click", ["<label>", "<role>", "<win>"], "(auto) click \"<label>\" (<role>), window \"<win>\""],
  ["desktopApproval.recognized.menu", ["<path>"], "(auto) choose menu \"<path>\""],
  ["desktopApproval.recognized.enter", ["<label>", "<win>"], "(auto) press Return (or input with a line break); the screen shows a \"<label>\" button this may be pressing, window \"<win>\""],
  ["desktopApproval.expired", ["<@100000000000000001>", 7], "<@100000000000000001> The Desktop operator did not get to you this round (queue number 7); your matter was passed to the next one. If you still want it done, call it again in this thread."],
  ["desktopApproval.selfCheck", ["<marker>"], "Desktop operator queue self-check (not a mention) <marker>"],
  ["desktopApproval.stuck", ["<@100000000000000001>", "L-1"], "<@100000000000000001> The Desktop operator is stuck in thread L-1. It asked the Task auditor for help more than 20 minutes ago and has had no \"[Help reply]\" yet. It will not touch the screen again; the screen stays where it stopped. You can tell it in that thread what to do, or ask the Task auditor to look again."],
  ["ledger.tableTitle", null, "**Matters waiting for your decision (master list)**"],
  ["ledger.tableNote", null, "Only open matters are listed. Follow the link back to the original request and reply under it, or in that matter's thread, for the reply to count."],
  ["ledger.tag", ["<fp>"], "[Awaiting decision · <fp>]"],
  ["ledger.updatedLabel", null, "Last updated: "],
  ["ledger.updated", ["<t>"], "Last updated: <t> UTC"],
  ["ledger.none", null, "(none right now)"],
  ["ledger.tooLong", null, "… (too long; see the ledger for the rest)"],
  ["ledger.itemFull", [3, "<title>", "<suggestion>", "<blocks>", "<deadline>", "<st>", "F", "L-1"], ["3. <title> (suggestion: <suggestion>; blocked if undecided: <blocks>; deadline: <deadline>; status: <st>; F)", "   Original request: L-1"]],
  ["ledger.itemOne", [3, "<title>", "<st>", "L-1"], "3. <title> (<st>) original request L-1"],
  ["ledger.itemTitle", [3, "<title>", "<st>"], "3. <title> (<st>)"],
  ["ledger.linkFallback", ["<mid>"], "message <mid>"],
  ["ledger.flagJoin", null, "; "],
  ["ledger.flagPossible", ["<mid>"], "you may have replied (message <mid>), the bot has not matched it yet"],
  ["ledger.flagUnknown", ["<x>"], "reply: unknown (<x>)"],
  ["ledger.readFailed", ["<hhmm>"], "reading failed, <hhmm>"],
  ["ledger.received", ["<word>", true, "<date>"], "<word> (no date agreed; default: look again on <date>)"],
  ["ledger.judgeTimeoutNote", null, "You replied, but the bot could not judge it; please take a look"],
  ["ledger.batchAsk", ["<@100000000000000001>", 3, "<list>"], "<@100000000000000001> 3 items left over from the setup period still need your decision; the master list is pinned here:\n<list>"],
  ["ledger.batchLine", ["<k>", "<title>", "L-1"], "<k>. <title> (original request L-1)"],
  ["ledger.newAsk", ["<@100000000000000001>", "<title>", "L-1"], "<@100000000000000001> One new item is waiting for your decision: <title>, original request L-1"],
  ["ledger.mergedExtra", null, "\n(Discord could not be read; the status of the items below is unknown)"],
  ["ledger.mergedLine", ["<k>", "<title>", true, "L-1"], "<k>. <title> (you may have replied, the bot has not matched it yet; original request L-1)"],
  ["ledger.mergedBody", ["<@100000000000000001>", "<extra>", "<lines>"], "<@100000000000000001> Combined reminder: these items are still waiting for your decision<extra>\n<lines>\nThe full list is pinned."],
  ["ledger.deadlineAsk", ["<@100000000000000001>", "<deadline>", "<title>", "L-1"], "<@100000000000000001> The deadline is close (<deadline>): <title>, original request L-1"],
  ["ledger.expiryNoReason", null, "(no reason given)"],
  ["ledger.expiryTitle", ["<kind>", "<one>"], "Approval expired unapproved: <kind> — <one>"],
  ["ledger.expirySuggestion", null, "If you want it done, tell the Controller; it will have that bot apply again, and you click Allow on the new card. If not, it is treated as not approved"],
  ["ledger.expiryBlocks", ["<kind>"], "<kind>: that matter was not done"],
  ["ledger.expiryReminder", ["<@100000000000000001>", "<deadline>", "<title>", "C-1", "L-1"], "<@100000000000000001> An approval has expired unapproved and the 24 hours are almost up (<deadline>): <title> (task card C-1), original thread L-1. If you want it done, tell the Controller; it will have that bot apply again, and you click Allow on the new card. If not, it is treated as not approved."],
  ["ledger.expiryThread", null, "This approval expired (not approved within 24 hours) and is treated as not approved. Call me again if you want it done."],
  ["reset.pre", null, "[Daily reset reminder] At 18:00 the sessions in the Workshop and in the main area of each project channel will reset: the first thing each bot says there afterwards starts a new session and continues from the task record, so you do not need to explain again. Task threads are not affected (they reset only after 24 hours idle). If you have something unfinished to say, it is safest to say it before 18:00."],
  ["reset.post", null, "[Daily reset] 18:00 has passed. From now on each bot's next message in the main area uses a new session; half-finished work continues from the task record. If a bot does not remember the earlier context, tell it to read the task record first."],
  ["reminders.apiFirst", ["<when>", 22], "This API credit period ends on <when>; 22 day(s) left."],
  ["reminders.apiUsedLong", ["<@100000000000000001>", "<first>"], "[API credit reminder] <@100000000000000001> The credit is used up and the daily audit, patrol, deep review and weekly audit are stopped; <first> Please check the Billing page of the Anthropic Console for a next period to claim."],
  ["reminders.apiLong", ["<@100000000000000001>", "<first>"], "[API credit reminder] <@100000000000000001> <first> Please check the Billing page of the Anthropic Console for a next period to claim; if this period will not be used up, you can ask the Controller to have Standby A and Standby B use more."],
  ["reminders.apiUsedShort", ["<@100000000000000001>", "<first>"], "[API credit reminder] <@100000000000000001> The credit is used up and the daily audit, patrol, deep review and weekly audit are stopped; <first> Have you claimed the next period? If so, reply to the Controller with \"the new period ends on X\"."],
  ["reminders.apiTomorrow", ["<@100000000000000001>", "<when>"], "[API credit reminder] <@100000000000000001> This API credit period ends tomorrow (<when>). If you have claimed the next period, reply to the Controller with \"the new period ends on X\"; if not, the four audit jobs will pause automatically at that time. If this period still has credit left, you can ask the Controller to have Standby A and Standby B use it up today."],
  ["reminders.apiStopped", ["<@100000000000000001>", 2, "<reason>"], "[API credit reminder] <@100000000000000001> The daily audit, patrol, deep review and weekly audit have been stopped for 2 days (<reason>). Have you claimed the next period? If so, reply to the Controller with \"the new period ends on X\" and I will resume."],
  ["reminders.pauseReason", ["<r>"], "<r>"],
  ["reminders.apiNoExpiry", ["<@100000000000000001>"], "[API credit reminder] <@100000000000000001> I have no record of when the next API credit period ends. Please check the Console and reply to the Controller with \"the new period ends on X\"."],
  ["reminders.apiNoGate", ["<@100000000000000001>"], "[API credit reminder] <@100000000000000001> I cannot read the credit gate's state, so I do not know the next end date. Please check the Console and reply to the Controller with \"the new period ends on X\"."],
  ["reminders.reviewNoGate", null, "I cannot read the credit gate record this time, so I do not know how often the audit jobs were stopped."],
  ["reminders.reviewZones", [3, 2], "In this time the audit jobs were stopped 3 time(s), about 2 day(s) in all."],
  ["reminders.reviewNone", null, "In this time the audit jobs were not stopped because of the credit."],
  ["reminders.review", ["<@100000000000000001>", "<hist>"], "[API credit · review] <@100000000000000001> We agreed to review this at about this time, and now it is time to decide, pick one of three: ① keep \"stop when used up\" ② switch to \"fall back to the subscription when used up\" ③ withdraw the subscription. <hist> Please also look at the usage in the Console."],
  ["reminders.loginOut", ["<@100000000000000001>"], "[Claude login] <@100000000000000001> Claude on this machine has been signed out. Every bot that runs on the Claude subscription may be unable to reply now. To sign in again: open Terminal → type `~/.local/bin/claude auth login` and press Return → sign in and approve in the browser as you usually do for Claude."],
  ["reminders.loginCaveat", null, " (by the recorded end date; it could not be checked with Claude)"],
  ["reminders.loginRenewed", ["<@100000000000000001>", "<when>"], "[Claude login] <@100000000000000001> The login was renewed; the new end date is <when>. Earlier reminders are void."],
  ["reminders.loginBody", ["<when>", 3, "<caveat>"], "The Claude login on this machine ends on **<when>** (3 day(s) left)<caveat>. After that **every bot that runs on the Claude subscription will be unable to reply at the same time** (Standby A, Standby B and the four audit jobs, which use API credit, are not affected). Signing in again takes about 2 minutes:\n1. Open Terminal on the Mac.\n2. Type `~/.local/bin/claude auth login` and press Return. (Typing just `claude` says the command is not found.)\n3. The browser opens the Claude sign-in page; sign in the way you usually do and click approve when it asks.\n4. Go back to Terminal; once it says the login succeeded you are done.\nNothing else is needed afterwards: this reminder will notice the new end date and stop by itself."],
  ["reminders.loginSoon", ["<@100000000000000001>", "<body>"], "[Claude login expiring soon] <@100000000000000001>: <body>"],
  ["reminders.loginExpired", ["<@100000000000000001>", "<when>", "<caveat>"], "[Claude login expired] <@100000000000000001> The Claude login on this machine has expired (<when>)<caveat>. Every bot that runs on the Claude subscription should be unable to reply now. Please sign in again soon: open Terminal → type `~/.local/bin/claude auth login` and press Return → sign in and approve in the browser."],
  ["quotaGate.pauseWhyExpired", ["<when>"], "This credit period has ended (<when>)"],
  ["quotaGate.pauseWhyExpiredFallback", null, "end date"],
  ["quotaGate.pauseWhyManual", null, "API credit was paused by hand"],
  ["quotaGate.pauseWhyUsed", null, "API credit is used up (the provider answered \"not enough money\")"],
  ["quotaGate.pause", ["<why>", "<at>"], "[API credit] <why>. The daily audit, patrol, deep review and weekly audit are paused, so failures will no longer be reported to the Workshop every day.\nWhile paused: none of these four jobs runs; the daily command spot-check and file reconcile hung on the daily-audit trigger stop too; nobody inspects the system every day, and the \"daytime watch\" keeps running. Standby A, Standby B and the bots on the subscription are not affected.\nHow to resume: I will probe automatically and resume when credit is back; you can also tell the Controller \"the new period ends on X\". (noted <at>)"],
  ["quotaGate.resumeHeadManual", null, "Resumed on instruction: "],
  ["quotaGate.resumeHeadAuto", null, "Credit is back and resumed automatically: "],
  ["quotaGate.resumeExp", ["<when>"], "The new period is recorded as ending <when>."],
  ["quotaGate.resumeNoExp", null, "Please tell me when the new period ends (reply to the Controller with \"the new period ends on X\"), otherwise I do not know when to stop next time."],
  ["quotaGate.resume", ["<head>", 2, "<exp>"], "[API credit] <head>the daily audit, patrol, deep review and weekly audit (stopped for about 2 days). <exp>\nReminder: the first daily audit after resuming has to cover the paused days and may take longer than usual."],
  ["quotaGate.verbStop", null, "stopped"],
  ["quotaGate.verbEnable", null, "enabled"],
  ["quotaGate.jn", null, ", "],
  ["quotaGate.partial", ["<failed>", 3, "<verb>"], "[API credit] <failed>: 3 could not be <verb>; I will keep trying every 30 minutes."],
  ["quotaGate.stuck", ["<failed>", "<verb>"], "[API credit] <failed> failed to be <verb> for 3 rounds in a row; please have a look (you can check with openclaw cron list --all in the terminal)."],
  ["dayWatch.stateWord", ["<s>"], "<s>"],
  ["dayWatch.discordResume", [3], "In the last hour Discord reconnected 3 time(s) without resuming the old connection (resume=false); a few seconds of messages may have been lost"],
  ["dayWatch.discordHeartbeat", [3], "In the last hour Discord heartbeats went unanswered 3 time(s) (normally about once a day)"],
  ["dayWatch.catchupState", ["<name>", "<st>"], "Catch-up ledger \"<name>\" is in state \"<st>\" (left by the first catch-up step; needs a look)"],
  ["dayWatch.catchupNotice", ["<name>", "<ns>"], "The notice for catch-up ledger \"<name>\": <ns> (the Workshop may not have received it)"],
  ["dayWatch.catchupStuck", ["<day>"], "The catch-up check got stuck (<day>; the lock was older than twice the time limit and was not taken over)"],
  ["dayWatch.quotaHit", ["<role>", "<job>", "<snippet>", "<resumeAt>"], "Stopped because the quota ran out: <role><job>, <snippet>resume time <resumeAt>; not one of the four jobs the catch-up looks after, please judge whether to carry on"],
  ["dayWatch.quotaRoleUnknown", null, "unknown role"],
  ["dayWatch.quotaJob", ["<id>"], " (scheduled job <id>)"],
  ["dayWatch.quotaChat", null, " (in a conversation)"],
  ["dayWatch.quotaSnippet", ["<s>"], "\"<s>\", "],
  ["dayWatch.quotaResumeUnknown", null, "unknown"],
  ["dayWatch.lockWhatLedger", null, "The \"waiting for your decision\" ledger lock is too old"],
  ["dayWatch.lockWhatWatch", null, "The daytime-watch lock is too old"],
  ["dayWatch.lockStale", ["<what>", "<name>", "<at>"], "<what>; the lock was not taken over (log `<name>`, last at <at>); needs someone to handle it"],
  ["dayWatch.boardUnreadable", [11], "Cannot read the task board: 11"],
  ["dayWatch.cardStale", ["<title>", "<id>", 12], "Task card \"<title>\" (<id>) is running but has not moved for 12 minutes"],
  ["dayWatch.oneshotMissed", ["<title>", "<job>"], "The due-time job <job> of card \"<title>\" is past due and has no run record"],
  ["dayWatch.oneshotFailed", ["<title>", "<job>", "<status>"], "The due-time job <job> of card \"<title>\" has run status <status>"],
  ["dayWatch.oneshotOkNotDone", ["<title>", "<job>"], "The due-time job <job> of card \"<title>\" finished (ok), but the card is not completed: check whether the work was really done"],
  ["dayWatch.closingUnlogged", ["<title>", "<id>"], "Card \"<title>\" (<id>) is completed but the closing gate has no release record (you may have changed it yourself in the console, or it was done by a workaround)"],
  ["dayWatch.ledgerTitle", ["<text>"], "Daytime watch: <text>"],
  ["dayWatch.suggestionEscalate", null, "Disable this watch item or handle it by hand"],
  ["dayWatch.suggestionLook", null, "Check whether you changed this card yourself; if not, have the Controller look into it"],
  ["dayWatch.blocks", null, "Nobody is handling this anomaly right now, and it will keep coming back"],
  ["catchup.lockStuck", null, "The catch-up check got stuck and needs checking (the lock file was older than twice the time limit and was not taken over)"],
  ["catchup.failedTwice", ["<task>", "<date>"], "Catch-up failed: <task> (<date>); the quota did not recover twice; not trying again"],
  ["catchup.skipped", ["<task>", "<date>"], "Skipped: <task> (<date>) is too close to the next round; not catching up"],
  ["catchup.uncertainMany", ["<task>", "<date>"], "Catch-up needs checking: <task> (<date>); more than one run appeared after the launch; not launching again automatically"],
  ["catchup.uncertainNoRecord", ["<task>", "<date>"], "Catch-up needs checking: <task> (<date>); no launch record was found; not launching again automatically"],
  ["catchup.resultQueue", ["<task>", "<date>"], "Catch-up result needs checking: <task> (<date>); it was queued too long and the result cannot be found; not sending more requests"],
  ["catchup.resultUnclear", ["<task>", "<date>"], "Catch-up result needs checking: <task> (<date>); it is unclear which round this run belongs to; not sending more requests"],
  ["catchup.done", ["<task>", "<date>"], "Caught up: <task> (<date>)"],
  ["catchup.resultUnverified", ["<task>", "<date>"], "Catch-up result needs checking: <task> (<date>); the run succeeded but the round record or the delivery receipt was not verified"],
  ["catchup.failedWithReason", ["<task>", "<date>", "<reason>"], "Catch-up failed: <task> (<date>) <reason>; not trying again"],
  ["quotaResume.resumed", [3, "<links>"], "The quota is back and 3 unfinished job(s) were told to carry on: <links>"],
  ["quotaResume.stuck", [3, "<items>"], "3 job(s) could not be resumed or confirmed; please say \"continue\" in these threads: <items>"],
  ["quotaResume.item", ["L-1", "type"], "L-1 (type)"],
  ["quotaResume.jn", null, ", "],
  ["quotaResume.typeWord", ["<t>"], "<t>"],
  ["auditGuard.p4Title", null, "P4 forwarding test"],
  ["auditGuard.p4Description", null, "This is a test of approval forwarding by the plugin: please click \"Deny\". Whether you allow it or not, nothing is changed."],
  ["ledgerWatch.gaveUp", [3, 3], "[Ledger backlog] 3 decision(s) are still not written into the ledger; the Controller has been called 3 times and did not catch up; please have a look."],
  ["ledgerWatch.old", [3, 2], "[Ledger backlog] 3 decision(s) are still not written into the ledger; the oldest is already 2 day(s) old; please have a look."],
];

test('every sentence of the notices group comes out exactly as written here', () => {
  const seen = new Set();
  for (const [path, args, want] of SENTENCES) {
    const v = get(N, path);
    assert.deepEqual(args === null ? v : v(...args), want, path);
    seen.add(path);
  }
  const all = [];
  const walk = (o, base) => { for (const [k, v] of Object.entries(o)) { const p = base ? `${base}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p); else all.push(p); } };
  walk(N, '');
  assert.deepEqual(all.filter((p) => !seen.has(p)), [], 'a sentence has no assertion above');
  assert.equal(all.length, SENTENCES.length);
});

test('no Chinese character in any English notice, whatever the arguments', () => {
  const sample = (fn) => fn(...Array.from({ length: fn.length }, () => 'x'));
  const walk = (o, base) => { for (const [k, v] of Object.entries(o)) { const p = `${base}.${k}`; if (typeof v === 'function') { let s; try { s = JSON.stringify(sample(v)); } catch { continue; } assert.ok(!HAN.test(s), p); } else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p); else assert.ok(!HAN.test(JSON.stringify(v)), p); } };
  walk(N, 'notices');
});

test('dates follow the locale: "Nov 22" and "Nov 22 09:30"', () => {
  const ms = Date.parse('2026-11-22T09:30:00+05:30'); // the test config's time zone is Asia/Kolkata
  assert.equal(fmtDate(ms), 'Nov 22');
  assert.equal(fmtDateTime(ms), 'Nov 22 09:30');
});

test('approval card notice, closing confirmation card and the desktop card texts', () => {
  assert.equal(approvalNoticeText({ what: undefined, cardId: 'C-1', source: N.closing.source }), '<@100000000000000001> A new approval card is waiting in the approval channel: Closing confirmation (task card C-1) — (no reason given)');
  assert.equal(PROGRAM_NOTE, 'Recognized by the program, not reported by the Desktop operator. ');
  assert.equal(cardTextOf(null, '1000000000000000003'), 'No related task card found (thread 1000000000000000003)');
  assert.equal(cardTextOf({ id: 'C-1', title: 'T' }, 'x'), 'C-1 "T"');
  assert.equal(cardTextOf({ ambiguous: [{ id: 'C-1', title: 'T' }, { id: 'C-2', title: null }] }, '1000000000000000003'), 'Several unfinished cards match this thread (C-1 "T", C-2); unclear which (thread 1000000000000000003)');
  assert.equal(expiredNoticeText(7), '<@100000000000000001> The Desktop operator did not get to you this round (queue number 7); your matter was passed to the next one. If you still want it done, call it again in this thread.');
});

test('closing gate: the card the owner sees is in English', () => {
  const ledger = { latestSubmission: () => ({ n: 2, threadId: 't', duplicate: true, unverifiableFlag: true }), reportFor: () => null, opusFor: () => [], approvalFor: () => null };
  const d = decideClosing({ ledger, cardId: 'C-1', card: { labels: ['audit:single-task'], notes: '' } });
  assert.ok(d.approval, 'a card is required');
  {
    assert.equal(d.title, 'Closing confirmation');
    assert.equal(d.description, 'Card C-1, review round 2: duplicate submission, needs checking, the result cannot be verified; only the owner can approve completing it. The approval is valid for this one card and this one closing only.');
  }
});

test('master list and the approval-expiry texts', () => {
  const ledger = { items: [{ id: 'P-1', title: 'Pick a plan', suggestion: 'plan A', blocks: 'the release', deadline: null, status: lexicon('en').ledgerStatus.noReply, requestMessageId: '1000000000000000009', requestLink: null, isTest: false, possibleReply: { messageId: '1000000000000000010' } }] };
  const t = buildTable(ledger, Date.parse('2026-11-22T09:30:00Z'));
  assert.equal(t.split('\n')[0], '**Matters waiting for your decision (master list)**');
  assert.ok(t.includes('1. Pick a plan (suggestion: plan A; blocked if undecided: the release;'), t);
  assert.ok(t.includes('you may have replied (message 1000000000000000010), the bot has not matched it yet'), t);
  assert.ok(t.includes('   Original request: message 1000000000000000009'), t);
  assert.ok(t.endsWith('Last updated: 2026-11-22 09:30 UTC'), t);
  assert.ok(buildTable({ items: [] }, 0).includes('(none right now)'));
  assert.equal(APPROVAL_EXPIRED_THREAD_TEXT, 'This approval expired (not approved within 24 hours) and is treated as not approved. Call me again if you want it done.');
  assert.ok(!HAN.test(t));
});

test('daily reset notices', () => {
  assert.ok(TEXT_PRE.startsWith('[Daily reset reminder] At 18:00 the sessions in the Workshop'));
  assert.ok(TEXT_POST.startsWith('[Daily reset] 18:00 has passed.'));
  assert.ok(!HAN.test(TEXT_PRE + TEXT_POST));
});

test('timed reminders: API credit and Claude login', () => {
  const nowMs = Date.parse('2026-11-23T09:30:00+05:30');
  const gate = { 当期到期: '2026-11-24T07:00:00+05:30', 状态: '正常', 暂停区间: [] };
  const out = dueReminders({ nowMs, gate, login: { 记录到期: null }, status: { ok: true, loggedIn: true, expiresAt: Date.parse('2027-03-31T00:00:00Z') } });
  const texts = out.map((x) => x.text);
  assert.ok(texts.length >= 1);
  assert.ok(texts.every((x) => !HAN.test(x)), texts.join('\n'));
  assert.ok(texts.some((x) => x.startsWith('[API credit reminder]') && x.includes('This API credit period ends tomorrow (Nov 24 07:00).')), texts.join('\n'));
  const out2 = dueReminders({ nowMs, gate: null, login: {}, status: { ok: true, loggedIn: false } });
  assert.ok(out2.some((x) => x.text.startsWith('[Claude login]') && x.text.includes('signed out')));
});

test('quota resume summary for the Workshop', () => {
  const t = summaryText([{ 类型: '已叫醒', 线程: '1000000000000000003' }, { 类型: '没接上', 线程: '1000000000000000004' }]);
  assert.ok(t.startsWith('The quota is back and 1 unfinished job(s) were told to carry on:'));
  assert.ok(t.includes('(not resumed)'));
  assert.ok(!HAN.test(t), t);
});
