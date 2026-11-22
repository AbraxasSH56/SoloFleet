// Reminds the owner (inside the controller turn in the workshop) about approvals that expired without an answer; the program counts reminders, not the model.
// 他在工坊跟总控说话时，如果有“审批过期没批”的事，往总控这一轮的上下文里塞一小段话，让她在回答末尾提醒一句。
// 程序管次数，不靠她自觉：同一件 6 小时内只塞一次（主人 07:41 照建议定 6 小时）；没有待批的事什么都不塞；任何出错都吞掉只记日志（官方也会吞）。
// 钩子：before_prompt_build。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isApprovalExpiry, readLedgerFile, OWNER_ID, WORKSHOP_CHANNEL } from './pending-ledger.mjs';
import { isReminderExcluded } from './channel-exclusions.mjs';

export const REMIND_INTERVAL_MS = 6 * 3600 * 1000; // can be changed

export function remindStatePathOf(ledgerPath) { return ledgerPath ? join(dirname(ledgerPath), '提醒记录.json') : null; }
function readState(path) { try { const v = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } }
function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path);
}

export function reminderText(items) {
  const lines = items.map((it, k) => `${k + 1}. ${it.title}${it.cardId ? `（任务卡 ${it.cardId}）` : ''}${it.link ? `，原线程 ${it.link}` : ''}`);
  return [
    `【待批提醒——程序加的，不是主人说的话】有 ${items.length} 件审批过期没批，那几件事还停着：`,
    ...lines,
    '回答完他这一轮问的事之后，在末尾加一句话提醒他这几件还没批；不要单独发消息。',
    '他要是说“知道了”或“先放着”，这一轮之后就不用再单独提了（程序 6 小时内也不会再让你提）。',
    '他要是说“批”或“重新申请”，到原线程点名那个 bot 让它重新申请，新的审批卡会弹出来，他再点“允许”；你不要替他批。',
  ].join('\n');
}

export function createApprovalReminder({ ledgerPath, syncRoot = null, now = Date.now, readLedger = readLedgerFile, statePath = remindStatePathOf(ledgerPath), intervalMs = REMIND_INTERVAL_MS, log = () => {} } = {}) {
  return function approvalReminderHook(_event, ctx) {
    try {
      if (!ledgerPath || !statePath) return undefined;
      // 条件写死：总控（main）、用户触发、频道精确等于工坊、不在排除列表；发话人字段有值时必须是主人（没值就放行，S0 实测记下有没有值）。
      if (ctx?.agentId !== 'main' || ctx?.trigger !== 'user') return undefined;
      if (String(ctx?.channelId ?? '') !== WORKSHOP_CHANNEL) return undefined;
      if (isReminderExcluded(syncRoot, ctx.channelId)) return undefined;
      if (ctx?.senderId && String(ctx.senderId) !== OWNER_ID) return undefined;
      const t = now();
      const ledger = readLedger(ledgerPath);
      const state = readState(statePath);
      const due = (ledger?.items ?? []).filter((it) => isApprovalExpiry(it) && it.status === '没回' && Number.isFinite(it.deadlineAt) && it.deadlineAt > t
        && !(Number.isFinite(state[it.id]) && t - state[it.id] < intervalMs));
      if (!due.length) return undefined;
      for (const it of due) state[it.id] = t;
      writeState(statePath, state);
      // 第 8 步 S0：记下钩子上下文里发话人字段有没有值，inputProvenance 也记（只记类型和取值，不含内容）
      const prov = ctx?.inputProvenance; const provText = prov == null ? null : (typeof prov === 'string' ? prov : JSON.stringify(prov)).slice(0, 80);
      log({ event: 'approval-reminder-injected', ids: due.map((i) => i.id), senderIdPresent: Boolean(ctx?.senderId), senderIsOwner: ctx?.senderId ? String(ctx.senderId) === OWNER_ID : null, trigger: ctx?.trigger ?? null, inputProvenance: provText });
      return { appendContext: reminderText(due) };
    } catch (e) {
      try { log({ event: 'approval-reminder-error', error: String(e?.message ?? e).slice(0, 200) }); } catch { /* 只是记录 */ }
      return undefined;
    }
  };
}

export function registerApprovalReminder(api, { ledgerPath, syncRoot, log } = {}) {
  if (!ledgerPath) return;
  api.on('before_prompt_build', createApprovalReminder({ ledgerPath, syncRoot, log }), { registrationId: 'approval-reminder' });
}
