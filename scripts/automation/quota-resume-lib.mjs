// Pure helper: decides whether a quota failure is one the resume job handles.
export const SKIP_ROLES = new Set(['desktop', 'standby-a', 'standby-b']);
export const SESSION_KEY_RE = /^agent:([^:]+):discord:channel:(\d{15,})$/;
export const CALL_STATES = ['接续没成功', '结果待核', '读不出']; // 白天看护只在这几种状态下才兜底叫醒总控
// 这条撞限登记归不归额度接续管（白天看护也先用它过滤）
export function managedByResume(q) {
  if (!q || q.是定时任务 || !q.角色 || SKIP_ROLES.has(q.角色)) return false;
  const m = SESSION_KEY_RE.exec(String(q.会话键 ?? ''));
  if (!m || m[1] !== q.角色) return false;
  return q.终态已确认 === true && Number.isFinite(q.失败时间毫秒);
}
// 看护用：这条运行编号在账里是什么情况（按运行编号查，不按会话键）。返回 { found, state }
export function ledgerLookup(ledger, runId) {
  const cid = ledger?.运行?.[String(runId)];
  if (!cid) return { found: false };
  const chain = ledger.链?.[cid];
  return chain ? { found: true, state: chain.状态 } : { found: false };
}
