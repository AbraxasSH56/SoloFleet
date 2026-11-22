// Posts the reply card as a trailing message when a long reply is split into several messages.
//  ·启动默认走 E；只有 init() 成功（动态导入到可调用的 sendDurableMessageBatch、message_sent 已注册）才 ready，钩子才允许"拿掉正文上的框"；
//    导入失败／导出缺失／未完成导入＝disabled，正文上的框照给（E），并留状态和日志，不循环重试。
//  ·登记带归属（平台、账号、目的地、会话），回调时核；账号或目的地缺失、不一致＝不补、不消费登记、记 ownership-mismatch。
//  ·登记在内存、有容量上限和过期；消费（发完）、失败、过期、停用（disable／retire）都清理；跨重启和队列恢复不保证。
//  ·发送结果 sent／suppressed／partial_failed／failed 分别处理，不把失败当成功；补发那条自己再触发事件时什么都不做。
export function createTrailingCard({ loadSend, getCfg = () => ({}), now = Date.now, log = () => {}, maxPending = 64, ttlMs = 10 * 60 * 1000 }) {
  const pending = new Map(); // runId -> { body, card, owner, at }
  const done = new Map();    // runId -> at（内存防重复；重启后不保证）
  const outcomes = new Map();
  const handledMsg = new Map();   // 已处理过的 message_sent 事件身份（messageId）→ 时刻；同一个 messageId 的重复回调不再消耗任何登记
  let initPromise = null, sendBatch = null, state = { status: 'not-ready', reason: 'init 未完成' };
  const clean = s => String(s ?? '').trim();
  const idOf = v => { const t = String(v ?? '').trim().toLowerCase(); const m = /^(?:channel|thread|discord|chan)?:?\s*<?#?(\d+)>?$/.exec(t); return m ? m[1] : t; };
  const gc = () => {
    const cut = now() - ttlMs;
    for (const [k, v] of pending) if (v.at < cut) { pending.delete(k); outcomes.set(k, { at: now(), status: 'expired' }); }
    const cut2 = now() - 24 * 3600e3;
    for (const m of [done, outcomes, handledMsg]) for (const [k, v] of m) if ((v.at ?? v) < cut2) m.delete(k);
    while (handledMsg.size > 512) handledMsg.delete(handledMsg.keys().next().value);
  };
  return {
    init() {                                                      // 幂等：就绪／导入失败过（permanent）／正在导入，都不重复做
      if (state.permanent || state.status === 'ready') return Promise.resolve(state);
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          const fn = await loadSend();
          if (typeof fn !== 'function') throw new Error('sendDurableMessageBatch 不是可调用函数');
          sendBatch = fn; state = { status: 'ready' };
        } catch (e) { sendBatch = null; state = { status: 'disabled', reason: String(e?.message ?? e).slice(0, 200), permanent: true }; log(`trailing card disabled: ${state.reason}`); }
        return state;
      })().finally(() => { initPromise = null; });
      return initPromise;
    },
    isReady: () => state.status === 'ready',
    state: () => state,
    disable(reason = 'stopped') { state = { status: 'disabled', reason, permanent: state.permanent === true }; pending.clear(); },
    arm(runId, armed) {
      gc();
      if (state.status !== 'ready' || !runId || !armed?.owner) return false;
      if (!armed.owner.accountId || !armed.owner.destination) return false;      // 归属不全不登记（钩子侧应保留 E 的框）
      if (done.has(runId) || pending.has(runId)) return false;
      if (pending.size >= maxPending) { outcomes.set(runId, { at: now(), status: 'rejected-full' }); log('trailing card: pending full, rejected new arm'); return false; }   // 满了：拒绝新登记（钩子保留 E 的框），不挤掉旧登记
      pending.set(runId, { body: clean(armed.body), card: armed.card, owner: armed.owner, at: now() });
      return true;
    },
    async onSent(event, ctx = {}) {
      gc();
      // 小保护①：同一个 messageId（官方事件身份）只处理一次——重复回调不再消耗任何登记，也不抢下一轮的卡。事件没带 messageId 时认不出重复（无从判断，照常配对）。
      const msgId = event?.messageId ?? ctx?.messageId;
      if (msgId && handledMsg.has(String(msgId))) return 'duplicate';
      // 小保护②：回调带 sessionKey、登记也存了 sessionKey 且（去空白转小写后）不同＝不是同一个会话，不配对。两边都有值才起作用；任何一边缺 sessionKey 就不因此拒绝，照常按平台＋账号＋目的地＋正文配对（缺值的那次回调没有这层保护，也区分不了同一 sessionKey 内的不同轮次）。当前安装版本的普通 Discord 回复调用链会传 sessionKey，现场回调原始字段未保存。
      const cbSession = event?.sessionKey ?? ctx?.sessionKey ?? null;
      const sessionOk = v => !cbSession || !v.owner.sessionKey || String(cbSession).trim().toLowerCase() === String(v.owner.sessionKey).trim().toLowerCase();
      let runId = event?.runId ?? ctx?.runId;
      let p = runId && pending.get(runId);
      if (!runId) {
        // 上机实测（21:11 A3-2）：官方正常回复路径的 message_sent 事件和 ctx 里都没有 runId（当时的诊断只记录了 runId、to、success、正文摘要和频道／账号／目标，没有记录 sessionKey、messageId）。
        // 没有运行编号时改按"同平台＋同账号＋同目的地＋逐字相同的正文"配对，多条相同时取登记最早的一条（Map 迭代顺序＝登记顺序）；
        // 内容为空的事件（补发那条自己触发的）永远配不上。
        const text = clean(event?.content), acct0 = String(ctx.accountId ?? '').trim().toLowerCase(), dest0 = idOf(event?.to ?? ctx.conversationId), plat0 = String(ctx.channelId ?? '').toLowerCase();
        if (text) for (const [k, v] of pending) if (v.body === text && v.owner.platform === plat0 && v.owner.accountId === acct0 && v.owner.destination === dest0 && sessionOk(v)) { runId = k; p = v; break; }
      }
      if (!p) return 'ignored';                                    // 含补发那条自己的事件：没有登记就什么都不做
      if (state.status !== 'ready') return 'not-ready';
      if (clean(event.content) !== p.body) return 'other-payload'; // 同一轮的其他载荷（块回复等）
      if (!sessionOk(p)) { outcomes.set(runId, { at: now(), status: 'session-mismatch' }); return 'ownership-mismatch'; }   // 带 runId 但会话不同：不配对、不消费
      const acct = String(ctx.accountId ?? '').trim().toLowerCase(), dest = idOf(event.to ?? ctx.conversationId);
      if (String(ctx.channelId ?? '').toLowerCase() !== p.owner.platform || !acct || acct !== p.owner.accountId || !dest || dest !== p.owner.destination) {
        outcomes.set(runId, { at: now(), status: 'ownership-mismatch' }); log('trailing card: ownership mismatch, not sent'); return 'ownership-mismatch';
      }
      pending.delete(runId);
      if (msgId) handledMsg.set(String(msgId), { at: now() });
      if (event.success !== true) { outcomes.set(runId, { at: now(), status: 'body-not-sent' }); return 'delivery-failed-no-card'; }
      done.set(runId, now());                                      // 先写 done 再发
      let res;
      try {
        res = await sendBatch({ cfg: getCfg(), channel: p.owner.platform, to: event.to ?? ctx.conversationId, accountId: ctx.accountId,
          payloads: [{ text: '', channelData: { discord: { embeds: [p.card] } } }], bestEffort: true, durability: 'best_effort', deliveryRetryOwner: 'caller' });
      } catch (e) { log(`card send threw: ${e}`); outcomes.set(runId, { at: now(), status: 'threw' }); return 'card-send-failed'; }
      const st = res?.status;
      const verdict = ({ sent: 'card-sent', suppressed: 'card-suppressed', partial_failed: 'card-partial', failed: 'card-failed' })[st] ?? 'card-unknown-result';
      if (verdict !== 'card-sent') log(`card send result: ${st ?? 'no status'}`);
      outcomes.set(runId, { at: now(), status: st ?? 'unknown' });
      return verdict;
    },
    pendingCount: () => pending.size,
    outcome: runId => outcomes.get(runId),
  };
}
