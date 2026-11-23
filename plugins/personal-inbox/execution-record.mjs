// Reply card ("execution record"): model, route (subscription or API), changed files and optional remaining quota under every reply. Optional module.
import { spawn } from 'node:child_process';
import { crew } from './crew-config.mjs';
import { tzName } from './tz.mjs';
import { cardText, cardTextAll, englishCleanupEnabled, lexicon } from './lexicon.mjs';
import { createTrailingCard } from './trailing-card.mjs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { callWithin, isPrivateSegment, isTimedOut, labelOf, limitInflight, withDeadline, withinRoot } from './change-scan.mjs';

const quotaWindow=(value,expectedMinutes,now)=>{
  if(!value||value.windowMinutes!==expectedMinutes||typeof value.usedPercent!=='number'||!Number.isFinite(value.usedPercent)||value.usedPercent<0||value.usedPercent>100)return null;
  const reset=Date.parse(value.resetsAt);
  return {usedPercent:value.usedPercent,remainingPercent:100-value.usedPercent,windowMinutes:value.windowMinutes,resetsAt:Number.isFinite(reset)?value.resetsAt:null,resetPassed:Number.isFinite(reset)&&reset<=now};
};

// Read the already-running app's quota-only widget export. Never fetch, refresh,
// read credentials, infer account percentages from tokens, or inspect other providers.
// Model families the card recognises, and the family that has its own weekly cap on the quota line (config attachCard.modelFamilies / attachCard.scopedWeeklyFamily).
const FAMILIES = (Array.isArray(crew.attachCard?.modelFamilies) && crew.attachCard.modelFamilies.length ? crew.attachCard.modelFamilies : ['sonnet', 'opus', 'haiku', 'fable']).map((f) => String(f).toLowerCase());
const SCOPED = String(crew.attachCard?.scopedWeeklyFamily || 'fable').toLowerCase();
const SCOPED_RE = new RegExp(SCOPED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const CODEXBAR_BIN = crew.paths.codexbarBin || '/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI'; // optional external tool (macOS menu-bar quota widget CLI)
export function selectClaudeQuota(snapshot, { credentialProfilePath, now = Date.now() } = {}) {
  const entries = snapshot?.entries?.filter(e => e.provider === 'claude') ?? [];
  if (entries.length !== 1 || !isAbsolute(credentialProfilePath ?? '')) return { status: 'unknown', reason: 'missing_or_ambiguous_profile' };
  const e = entries[0];
  const owner = createHash('sha256').update(`codexbar:claude-oauth-cache-profile:v1\0${resolve(credentialProfilePath)}`).digest('hex');
  if (e.quotaOwnerKey !== owner) return { status: 'unknown', reason: 'profile_mismatch' };
  const measured = Date.parse(e.updatedAt);
  if (!Number.isFinite(measured) || measured > now + 60000) return { status: 'unknown', reason: 'invalid_measurement_time' };
  return { status: 'cached', source: 'CodexBar widget snapshot', measuredAt: e.updatedAt,
    ageSeconds: Math.max(0, Math.floor((now - measured) / 1000)), profileMatched: true,
    accountIdentity: 'not_exposed_by_snapshot', session: quotaWindow(e.primary, 300, now), week: quotaWindow(e.secondary, 10080, now) };
}

// Fable 单独的周窗口：CodexBar 把它放在 usage.extraRateWindows 里（id 含 fable）。缺这一项就是 null（附卡写“未知”），不报错。
const fableWindow=(list,now)=>{const hit=Array.isArray(list)?list.find(x=>SCOPED_RE.test(String(x?.id??''))):null;return hit?quotaWindow(hit.window,10080,now):null;};
const pickFable=list=>(Array.isArray(list)?list.filter(x=>SCOPED_RE.test(String(x?.id??''))).slice(0,1):[]).map(x=>({id:x.id,window:x.window&&{usedPercent:x.window.usedPercent,windowMinutes:x.window.windowMinutes,resetsAt:x.window.resetsAt}}));
export function selectClaudeCliQuota(rows,{now=Date.now()}={}){
  if(!Array.isArray(rows)||rows.length!==1||rows[0]?.provider!=='claude'||rows[0].error||!rows[0].usage)return {status:'unknown',reason:'cli_usage_unavailable'};
  const u=rows[0].usage,measured=Date.parse(u.updatedAt);
  if(!Number.isFinite(measured)||measured>now+60000)return {status:'unknown',reason:'invalid_measurement_time'};
  return {status:'cached',source:'CodexBar CLI usage',measuredAt:u.updatedAt,ageSeconds:Math.max(0,Math.floor((now-measured)/1000)),profileMatched:false,accountIdentity:'not_independently_verified',session:quotaWindow(u.primary,300,now),week:quotaWindow(u.secondary,10080,now),fable:fableWindow(u.extraRateWindows,now)};
}

// One existing service owns a bounded official /usage query. Replies only read
// the last snapshot; no blocking query or Group Container I/O in the reply path.
export function createCliQuotaSource({credentialProfilePath,spawnProcess=spawn,now=Date.now,timeoutMs=35000,cooldownMs=300000,killProcess=child=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}}={}){
  let pending,lastRows,lastAttempt=-Infinity,lastError;
  const read=()=>{
    const value=lastRows?selectClaudeCliQuota(lastRows,{now:now()}):{status:'unknown',reason:pending?'cli_usage_pending':lastError??'cli_usage_not_sampled'};
    return {...value,...(lastRows&&lastError?{refreshFailed:true}: {})};
  };
  const refresh=({signal}={})=>{
    if(signal?.aborted)return Promise.resolve({status:'unknown',reason:'reader_retired'});
    if(pending)return pending;
    if(now()-lastAttempt<cooldownMs)return Promise.resolve(read());
    if(!isAbsolute(credentialProfilePath??''))return Promise.resolve({status:'unknown',reason:'missing_profile_directory'});
    lastAttempt=now();
    const operation=new Promise(resolveResult=>{
      let child,closed=false,failed,timer,killTimer,size=0;const chunks=[];
      const kill=()=>{if(child)try{killProcess(child);}catch{}};
      const cancel=reason=>{failed??=reason;kill();};
      const abort=()=>cancel('reader_retired');
      const finish=code=>{
        if(closed)return;closed=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
        let rows;try{if(failed||code!==0)throw Error();rows=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(selectClaudeCliQuota(rows,{now:now()}).status!=='cached')throw Error();const u=rows[0].usage;lastRows=[{provider:'claude',usage:{updatedAt:u.updatedAt,primary:u.primary,secondary:u.secondary,extraRateWindows:pickFable(u.extraRateWindows)}}];lastError=undefined;}catch{lastError=failed??'cli_usage_unavailable';}
        resolveResult(lastRows?{...selectClaudeCliQuota(lastRows,{now:now()}),...(lastError?{refreshFailed:true}:{})}:{status:'unknown',reason:lastError??'cli_usage_unavailable'});
      };
      // Preserve native runtime account routing. Explicitly setting even the
      // default CLAUDE_CONFIG_DIR can select a different credential namespace.
      // A configured cache fingerprint path is not authority to rewrite it.
      try{child=spawnProcess(CODEXBAR_BIN,['usage','--provider','claude','--source','cli','--format','json','--no-credits'],{stdio:['ignore','pipe','ignore'],detached:true,env:{...process.env}});}catch{failed='cli_usage_unavailable';finish(1);return;}
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',bytes=>{size+=bytes.length;if(size>65536)cancel('oversize_cli_usage');else chunks.push(bytes);});
      child.on('error',()=>{failed='cli_usage_unavailable';finish(1);});child.on('close',finish);
      timer=setTimeout(()=>{cancel('cli_usage_timeout');killTimer=setTimeout(()=>finish(1),1000);},timeoutMs);
      if(signal?.aborted)abort();
    });
    pending=operation;operation.finally(()=>{if(pending===operation)pending=undefined;});return operation;
  };
  return {read,refresh};
}

// A macOS privacy prompt can block filesystem I/O beyond AbortSignal cancellation.
// Keep that single read in a disposable process using the same Node executable
// and OS permission checks; never leave it attached to the Gateway's I/O pool.
const quotaReadProgram = `import {readFile} from 'node:fs/promises';
const b=await readFile(process.argv[1]);
if(b.length>4*1024*1024)process.exit(2);
const s=JSON.parse(b);
const window=w=>w&&({usedPercent:w.usedPercent,windowMinutes:w.windowMinutes,resetsAt:w.resetsAt});
process.stdout.write(JSON.stringify({entries:s.entries?.filter(e=>e.provider==='claude').map(e=>({provider:e.provider,quotaOwnerKey:e.quotaOwnerKey,updatedAt:e.updatedAt,primary:window(e.primary),secondary:window(e.secondary)}))}));`;
export function createSnapshotProcessReader({ spawnProcess = spawn } = {}) {
  return (snapshotPath, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Read cancelled'), { code: 'ABORT_ERR' }));
    const child = spawnProcess(process.execPath, ['--input-type=module', '-e', quotaReadProgram, '--', snapshotPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    const buffers = []; let size = 0, failure;
    const abort = () => { failure ??= Object.assign(new Error('Read cancelled'), { code: 'ABORT_ERR' }); child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > 4 * 1024 * 1024) { failure ??= Object.assign(new Error('Snapshot too large'), { code: 'MAX_BUFFER' }); child.kill('SIGKILL'); }
      else buffers.push(bytes);
    });
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure ?? Object.assign(new Error('Snapshot reader unavailable'), { code: 'READ_FAILED' }));
      else resolve(Buffer.concat(buffers));
    });
  });
}
export function createQuotaCacheReader({ read = createSnapshotProcessReader(), timeoutMs = 1000 } = {}) {
  const pending = new Map();
  return async ({ snapshotPath, credentialProfilePath, now, signal, waitForOriginalRead = false } = {}) => {
    if (signal?.aborted) return { status: 'unknown', reason: 'reader_retired' };
    const key = JSON.stringify([snapshotPath, credentialProfilePath]);
    // macOS can leave an access request unresolved. Do not accumulate more I/O
    // or hold the task reply while that same original read is still pending.
    if (pending.has(key)) return { status: 'unknown', reason: 'snapshot_read_pending' };
    const controller = new AbortController();
    const retire = () => controller.abort();
    signal?.addEventListener('abort', retire, { once: true });
    if (signal?.aborted) retire();
    const operation = (async () => {
      try {
        const bytes = await read(snapshotPath, { signal: controller.signal });
        if (bytes.length > 4 * 1024 * 1024) return { status: 'unknown', reason: 'oversize_snapshot' };
        return selectClaudeQuota(JSON.parse(bytes), { credentialProfilePath, now });
      } catch (error) { return { status: 'unknown', reason: controller.signal.aborted ? signal?.aborted ? 'reader_retired' : 'snapshot_read_timeout' : 'snapshot_unavailable', errorCode: error.code ?? error.name }; }
    })();
    pending.set(key, operation);
    operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); });
    let timer;
    try {
      // Only the existing service startup probe waits for the original OS
      // decision. Reply hooks keep the short deadline and never create a second
      // read while it is pending. Service stop owns cancellation and reaping.
      if (waitForOriginalRead) return await operation;
      return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ status: 'unknown', reason: 'snapshot_read_timeout' });
      }, timeoutMs); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', retire); }
  };
}
export const readClaudeQuota = createQuotaCacheReader();

export function executionModelLabel(resolvedRef) {
  const T = cardText();
  if (typeof resolvedRef !== 'string') return T.modelUnknown;
  const slash = resolvedRef.indexOf('/');
  if (slash < 1) return T.modelUnknown;
  const provider = resolvedRef.slice(0, slash), model = resolvedRef.slice(slash + 1);
  const family = new RegExp(`^claude-(${FAMILIES.join('|')})-[0-9][a-z0-9.-]*$`, 'i').exec(model)?.[1]?.toLowerCase();
  if (!family) return T.modelUnrecognized;
  const name = family[0].toUpperCase() + family.slice(1);
  // Only a known actual provider identifies transport. A model family or a
  // requested alias cannot turn an unknown route into CLI or API evidence.
  // API 额度的提供商名以 `API_PROVIDERS` 为准（现在是四个：标准 `anthropic`、定时任务专用的 `anthropic-api`、备用A的 `anthropic-standby-a`、备用B的 `anthropic-standby-b`），名单里的都算 API 额度，型号行写 `…/api`；新增 API 提供商名时要一起加进这个名单。
  return `${name}/${provider === 'claude-cli' ? 'Cli' : API_PROVIDERS.has(provider) ? 'api' : T.routeUnknown}`;
}
function measuredLabel(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${tzName()}`;
}

const CARD_MARK = '__executionRecordCard';
// ───────── 附卡（嵌入卡）辅助函数 ─────────
// 官方页脚＝官方 appendUsageLine 追加在最后一个有文字的载荷末尾（agent-runner-run-3xhrTB12.mjs:5501-5510，换行隔开）。
// 页脚内容由模板渲染（usage-footer.json：`{model.resolved_ref|alias:models}` ＋ ` · {model.reasoning}`），
// 同源数据是官方用量状态 usageState.resolvedRef／reasoningEffort（deliver-prepare-DAsx55vE.mjs:60-90）。
// 所以"确认是官方页脚"＝末行与按用量状态算出的页脚逐字相同；算不出来或对不上，就是"来源不明"，保留正文、不用它断言实际型号。
function modelLabelOf(u) {
  if (!u || typeof u.resolvedRef !== 'string') return null;
  const label = executionModelLabel(u.resolvedRef);
  return [...cardTextAll('modelUnknown'), ...cardTextAll('modelUnrecognized')].includes(label) ? null : label;
}
function expectedFooter(u, text) {
  const label = modelLabelOf(u);
  if (!(label && typeof u.reasoningEffort === 'string' && u.reasoningEffort)) return null;
  // API 路径的官方页脚没有配别名时，模板原样写出型号引用（如 `anthropic/claude-fable-5-2 · high`），
  // 不是别名形式。载荷末行如果逐字等于这个"原样型号引用＋档位"，就把它当官方页脚（否则末行不是预期页脚，
  // 前面的 [[oc_changes …]] 就不在"末行"，清不掉）。只对 API 路径这样认，命令行路径一个字不变。
  if (typeof text === 'string' && isApiRouteRef(u.resolvedRef)) {
    const raw = `${u.resolvedRef.trim()} · ${u.reasoningEffort}`;
    const last = text.replace(/\s+$/, '').split('\n').at(-1)?.trim();
    if (last === raw) return raw;
  }
  return `${label} · ${u.reasoningEffort}`;
}
// 卡的第一栏：只用用量状态；缺型号、缺档位各写未知；两样都没有写整栏未知
function modelLineFrom(u) {
  const label = modelLabelOf(u), effort = typeof u?.reasoningEffort === 'string' && u.reasoningEffort ? u.reasoningEffort : null;
  const T = cardText();
  if (!label && !effort) return T.modelAndEffortUnknown;
  return `${label ?? T.labelUnknown} · ${effort ?? T.effortUnknown}`;
}
// ───────── 归属：平台、账号、最终频道／线程 ─────────
// 官方消息工具：账号不写＝本角色自己的账号（openclaw-tools-Wz412ubE.mjs:8546 `explicitAccountId ?? scheduledAccountId ?? agentAccountId`）；
// 目标不写＝当前会话（同文件 :538、:3452、:7911 `currentMessagingTarget ?? currentChannelId`）。这两条默认读代码得出，且已上机核过：不写账号／目标时落在总控账号和本频道（返回的 details.to 为本频道，返回不带账号，账号由实际消息作者证实）。
// 线程是独立频道：最终目的地＝threadId ?? target；父频道和线程是两个不同的目的地，不能互换。
const idOf = v => { const t = String(v ?? '').trim().toLowerCase(); if (!t) return ''; const m = /^(?:channel|thread|discord|chan)?:?\s*<?#?(\d+)>?$/.exec(t); return m ? m[1] : t; };
// 归属以官方"权威返回"的最终落点为准：请求参数只作对照，不能盖过返回里明确不同的目的地；
// 返回里没有可读的落点、或几处落点互相矛盾、或和请求写的不一致，都算"确认不了"，不判作本频道附件。
// 上机实测形状（19:47～19:52）：details.to、details.result.target.id、details.result.receipt…raw.channelId 都是同一个频道／线程 id。
const uniq = arr => [...new Set(arr.filter(Boolean))];
function returnedDestinations(result) {
  const d = result?.details, rc = d?.result?.receipt;
  return uniq([d?.to, d?.threadId, d?.channelId, d?.result?.target?.id, d?.result?.threadId, d?.result?.channelId, result?.to, result?.payload?.to, result?.payload?.channelId,
    ...(Array.isArray(rc?.parts) ? rc.parts.map(x => x?.raw?.channelId) : []), ...(Array.isArray(rc?.raw) ? rc.raw.map(x => x?.channelId) : []),
    ...(Array.isArray(d?.result?.raw) ? d.result.raw.map(x => x?.channelId) : [])].map(idOf));
}
const lowerId = v => String(v ?? '').trim().toLowerCase();
// 返回 { ok, platform, account, destination }；ok=false 表示请求和返回冲突或落点确认不了
function attachmentRoute(params, result) {
  const d = result?.details;
  const ret = returnedDestinations(result), req = idOf(params?.threadId) || idOf(params?.target);   // 线程是独立频道：请求的最终落点＝threadId ?? target
  if (ret.length !== 1 || (req && req !== ret[0])) return { ok: false };
  const accts = uniq([d?.accountId, d?.result?.accountId, result?.accountId].map(lowerId)), reqAcct = lowerId(params?.accountId);
  if (accts.length > 1 || (reqAcct && accts.length === 1 && reqAcct !== accts[0])) return { ok: false };
  const plats = uniq([d?.channel, d?.result?.channel, result?.channel].map(lowerId)), reqPlat = lowerId(params?.channel);
  if (plats.length > 1 || (reqPlat && plats.length === 1 && reqPlat !== plats[0])) return { ok: false };
  return { ok: true, platform: plats[0] ?? (reqPlat || 'discord'), account: accts[0] ?? (reqAcct || null), destination: ret[0] };
}
// 官方消息工具认的附件写法（dist/openclaw-tools-Wz412ubE.mjs:7824-7870）：media／mediaUrl／path／filePath／fileUrl、mediaUrls 数组、attachments 数组、buffer
const hasText = v => typeof v === 'string' && v.trim() !== '';
function sendsMedia(input) {
  if (!input || typeof input !== 'object') return false;
  return ['media', 'mediaUrl', 'path', 'filePath', 'fileUrl', 'buffer'].some(k => hasText(input[k]))
    || (Array.isArray(input.mediaUrls) && input.mediaUrls.some(hasText))
    || (Array.isArray(input.attachments) && input.attachments.length > 0);
}
// 附件成功：必须有正面证据（ok:true／status:sent／带消息号），否则不算；失败形状（ok:false、status failed/suppressed/error、isError）一律不算
function messageSendSucceeded(result) {
  if (result === undefined || result === null || typeof result !== 'object') return false;
  // 上机实测的官方 message 工具返回（19:47～19:52 三次）：{content, details:{channel,to,via,mediaUrl,mediaUrls,
  // result:{target,receipt,messageId,channel}, deliveryStatus:'sent', payloadOutcomes:[{status:'sent'}],
  // messageDelivery:{status:'settled',partialDelivery:false,…}}}——成功证据在 details.result 和 deliveryStatus 里，不在顶层。
  const d = result.details && typeof result.details === 'object' ? result.details : null;
  const flat = [result, d, result.payload, result.result, d?.result].filter(x => x && typeof x === 'object');
  const bad = v => ['failed', 'suppressed', 'error', 'partial_failed'].includes(String(v ?? '').toLowerCase());
  if (flat.some(x => x.isError === true || x.ok === false || bad(x.status))) return false;
  if (d && (bad(d.deliveryStatus) || bad(d.messageDelivery?.status) || d.messageDelivery?.partialDelivery === true
    || (Array.isArray(d.payloadOutcomes) && d.payloadOutcomes.some(o => String(o?.status ?? '').toLowerCase() !== 'sent')))) return false;
  return flat.some(x => x.ok === true || ['sent', 'ok', 'delivered', 'success'].includes(String(x.status ?? '').toLowerCase()) || x.messageId || x.messageIds?.length || x.receipt)
    || String(d?.deliveryStatus ?? '').toLowerCase() === 'sent';
}
// 本轮有没有"发到这条回复所在平台、账号、最终频道／线程"的附件。回复所在目的地取官方 ctx.conversationId（不用自造的 ctx.threadId）。
function attachmentMatches(r, ctx, { strict = false } = {}) {
  if (!r?.attachments?.length) return false;
  const here = idOf(ctx?.conversationId), myAcct = String(ctx?.accountId ?? '').trim().toLowerCase();
  if (!here || !myAcct || String(ctx?.channelId ?? '').toLowerCase() !== 'discord') return false;   // 回复这边的归属缺失＝无法核对
  return r.attachments.some(a => {
    if ((a.platform ?? 'discord') !== 'discord') return false;
    if (a.account ? a.account !== myAcct : strict) return false;
    if (a.destination ? a.destination !== here : strict) return false;
    return true;
  });
}
// ───────── 附卡"修改"栏 ─────────
// 3.1 工具分类。工具名：去 mcp__openclaw__ 前缀后，按官方钩子同一套规范化（驼峰拆成下划线、小写、别名 bash→exec 等；
// 官方 tool-policy-tVbJkh67.mjs:12-14 normalizeCliToolName、tool-policy-shared-PsZCKeeN.mjs:10-15 TOOL_NAME_ALIASES）——
// 钩子收到的名字已经是这样改写过的（Bash→exec、WebFetch→web_fetch、ToolSearch→tool_search），事件流那份要用同一规则才对得上。
// 动作名"小写、- 和空格换成 _"（官方 normalizeActionName 同做法）。
const TOOL_ALIASES = new Map([['bash', 'exec'], ['apply-patch', 'apply_patch'], ['tool_call', 'dispatch_action'], ['cron', 'automations']]);
const nameOf = s => {
  const snake = String(s ?? '').trim().replace(/^mcp__openclaw__/i, '').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return TOOL_ALIASES.get(snake) ?? snake;
};
const actionOf = v => typeof v === 'string' && v.trim() ? v.trim().toLowerCase().replace(/[-\s]+/g, '_') : undefined;
// R：官方 dist/tool-mutation-BTW6eoAN.mjs 的 REPLAY_SAFE_TOOL_NAMES；toolsearch 是 Claude 命令行自带别名；
// memory_search 只维护内部索引（P0 核过：写 ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite，不写用户文件）；
// personal_inbox_lookup／personal_inbox_sync_verify 是我们自己的只读接口；workboard 按 P0《接口归类表》逐个核实。
const R_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find', 'web_fetch', 'web_search', 'memory_get', 'sessions_list', 'sessions_history', 'sessions_search',
  'agents_list', 'pdf', 'view_image', 'get_goal', 'tool_search', 'tool_describe', 'toolsearch', 'memory_search', 'personal_inbox_lookup', 'personal_inbox_sync_verify',
  'workboard_read', 'workboard_runs', 'workboard_boards', 'workboard_stats', 'workboard_attachment_read', 'workboard_notify_list', 'workboard_notify_events']);
// T：《接口归类表》里核实为只改任务板内部状态（SQLite）的接口；表里没有的 workboard_* 一律 U，不按前缀归类。
const WORKBOARD_T = new Set(['workboard_create', 'workboard_link', 'workboard_claim', 'workboard_heartbeat', 'workboard_release', 'workboard_comment', 'workboard_proof',
  'workboard_complete', 'workboard_attachment_add', 'workboard_attachment_delete', 'workboard_block', 'workboard_unblock', 'workboard_move', 'workboard_board_create',
  'workboard_board_archive', 'workboard_board_delete', 'workboard_specify', 'workboard_decompose', 'workboard_notify_subscribe', 'workboard_notify_advance',
  'workboard_notify_unsubscribe', 'workboard_promote', 'workboard_reassign', 'workboard_reclaim', 'workboard_dispatch', 'workboard_worker_log',
  'workboard_protocol_violation', 'workboard_sessions_board_update', 'workboard_sessions_board_move']);
const W_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit', 'multi_edit', 'notebook_edit']);
const X_TOOLS = new Set(['exec', 'bash']);
const I_TOOLS = new Set(['personal_inbox_capture', 'personal_inbox_link_card', 'personal_inbox_sync_register']);
// 官方 tool-mutation 的 MESSAGE_READ_ONLY_ACTIONS、READ_ONLY_ACTIONS；computer 观察动作：computer-tool-shared-B6dQ6PvX.mjs:6-20。
const MESSAGE_R = new Set(['reactions', 'read', 'list_pins', 'permissions', 'thread_list', 'search', 'sticker_search', 'member_info', 'role_info', 'emoji_list', 'channel_info', 'channel_list', 'voice_status', 'event_list']);
const MESSAGE_SEND = new Set(['send', 'reply', 'thread_reply', 'sendattachment', 'sendwitheffect', 'broadcast', 'upload_file']);
const MESSAGE_OTHER = cardText('zh-CN').messageOther; // only the keys are used for classification; the texts live in lexicon.mjs (both locales)
const AUTOMATION_R = new Set(['get', 'list', 'read', 'status', 'show', 'fetch', 'search', 'query', 'view', 'poll', 'log', 'inspect', 'check', 'probe', 'runs']);
const AUTOMATION_T = new Set(['add', 'update', 'remove', 'run', 'next_check', 'wake']);   // 官方 cron-tool-B1TlluJ9.mjs:376 CRON_ACTIONS 里的非只读动作
const COMPUTER_OBS = new Set(['screenshot', 'wait', 'list_apps', 'list_windows', 'get_accessibility_tree', 'get_cursor_position', 'get_window_state', 'zoom', 'get_browser_state', 'get_recording_state']);
// "可能写文件"集合：起始快照时点、终扫、"扫描范围外仍可能有修改"都以它为准。
const MAYBE_WRITE = new Set(['W', 'W?', 'X', 'C', 'S', 'DL', 'U']);
const isObj = v => v !== null && typeof v === 'object';

// 返回 { cls, action, needsArgs }。分类要靠参数而参数缺失的，先按 U（needsArgs），等补齐。
export function classifyTool(rawName, args) {
  const tool = nameOf(rawName), a = isObj(args) ? args : undefined, act = actionOf(a?.action);
  const pending = { cls: 'U', needsArgs: true };
  if (R_TOOLS.has(tool)) return { cls: 'R' };
  if (W_TOOLS.has(tool)) return { cls: 'W' };
  if (tool === 'apply_patch') return { cls: 'W?' };
  if (X_TOOLS.has(tool)) return { cls: 'X' };
  if (tool === 'personal_inbox_sync_apply') return { cls: 'S' };
  if (I_TOOLS.has(tool)) return { cls: 'I' };
  if (tool === 'workboard_list') return a ? { cls: a.refreshDiagnostics === true ? 'T' : 'R' } : pending;
  if (WORKBOARD_T.has(tool)) return { cls: 'T' };
  if (tool === 'message') {
    if (!a) return pending;
    if (!act) return { cls: 'U', action: 'missing' };
    if (MESSAGE_R.has(act)) return { cls: 'R', action: act };
    if (MESSAGE_SEND.has(act)) return { cls: 'M', action: act };
    if (act === 'download_file') return { cls: 'DL', action: act };
    if (MESSAGE_OTHER[act]) return { cls: 'M', action: act };
    return { cls: 'U', action: 'other' };
  }
  if (tool === 'automations' || tool === 'cron') {
    if (!a) return pending;
    if (!act) return { cls: 'U', action: 'missing' };
    if (AUTOMATION_R.has(act)) return { cls: 'R', action: act };
    if (AUTOMATION_T.has(act)) return { cls: 'T', action: act };
    return { cls: 'U', action: 'other' };
  }
  if (tool === 'session_status') return a ? { cls: a.model === undefined || a.model === null ? 'R' : 'U' } : pending;
  if (tool === 'process') return a ? { cls: act === 'list' || act === 'log' ? 'R' : 'U', action: !act ? 'missing' : act === 'list' || act === 'log' ? act : 'other' } : pending;
  if (tool === 'subagents') return a ? { cls: !act || act === 'list' ? 'R' : 'U', action: !act ? 'missing' : act === 'list' ? 'list' : 'other' } : pending;
  if (tool === 'computer') {
    if (!a) return pending;
    if (COMPUTER_OBS.has(act) || (act === 'browser_dialog' && actionOf(a.dialogAction) === 'inspect')) return { cls: 'R', action: act };
    return { cls: 'C', action: !act ? 'missing' : /^[a-z0-9_]{1,40}$/.test(act) ? act : 'other' };
  }
  return { cls: 'U' };
}

// 3.2 共享记录表：放 globalThis，和 assistantSeen 同法；版本不符不覆盖别人的，换键并给本实例的运行记缺口。
const REGISTRY_KEY = Symbol.for('personal-inbox.execution-record.runs.v1');
const REGISTRY_FALLBACK_KEY = Symbol.for('personal-inbox.execution-record.runs.v1-isolated');
// fsInflight：本插件路径查询（解析真实路径、读链接）的未完成调用上限，进程内共享、跨模块实例有效。
const FS_INFLIGHT_MAX = 8;
const freshRegistry = () => ({ version: 1, instances: 0, fsInflight: { active: 0, max: FS_INFLIGHT_MAX }, runs: new Map(), evicted: new Map(), snapshots: new Map(), digests: new Map() });
function openRegistry() {
  const existing = globalThis[REGISTRY_KEY];
  if (!existing) return { reg: (globalThis[REGISTRY_KEY] = freshRegistry()), versionGap: false };
  if (existing.version === 1) return { reg: existing, versionGap: false };
  return { reg: (globalThis[REGISTRY_FALLBACK_KEY] ??= freshRegistry()), versionGap: true };
}
const RUN_TTL = 24 * 60 * 60 * 1000, RUN_CAP = 256;
const newRun = t => ({ started: false, startedAt: null, endedAt: null, firstSeenAt: t, seenAt: t, agentId: null, sessionKey: null,
  tools: new Map(), gaps: new Set(), settled: false, attachments: null });

// 用量状态 resolvedRef 的提供者段（/ 前），去首尾空白、转小写；缺失或格式不明返回 null。
// 只用来划 bot 自列的支持范围（本轮是 Claude 命令行后端），不是旧的强／弱口径。
export const refProviderOf = ref => { if (typeof ref !== 'string') return null; const s = ref.trim().toLowerCase(), i = s.indexOf('/'); return i > 0 ? s.slice(0, i) : null; };
// 走 API 额度的提供商（标准 `anthropic` 的内置运行方式，和定时任务专用的 `anthropic-api`）。
// 这两种路径上的回复也要照样清 [[oc_changes …]] 标记、末尾 NO_REPLY、开头英文过程话，所以和 claude-cli 一起算"可清理路径"。
// 提供商缺失或不认识（含 openai 等）一律不算，保持保守。
// Separate keys: 备用A、备用B各有一个按变量取密钥的单独提供商 `anthropic-standby-a`、`anthropic-standby-b`，同样算 API 额度；名单写死，别的名字（如 anthropic-apix）仍不认。
const API_PROVIDERS = new Set(['anthropic', 'anthropic-api', 'anthropic-standby-a', 'anthropic-standby-b']);
export const isApiRouteRef = ref => API_PROVIDERS.has(refProviderOf(ref));
export const isCleanRouteRef = ref => refProviderOf(ref) === 'claude-cli' || isApiRouteRef(ref);

// ───────── bot 自列名单 ─────────
// bot 在会出附卡的最终回复里，全文最后一行单独写 [[oc_changes {"files":[...]}]]；空数组＝没改。
const MARKER_HEAD = '[[oc_changes ', MARKER_TAIL = ']]', MARKER_MAX_BYTES = 8 * 1024, MARKER_MAX_FILES = 50;
const markerHashOf = line => createHash('sha256').update(String(line).trim()).digest('hex');
// 宿主公开的代码区域识别函数（openclaw/plugin-sdk/text-chunking 导出的 findCodeRegions）。服务注册时提前加载；
// 最终助手事件到来时还没加载好，这一轮就走保守分支（不删、写"未列"）。不在同步事件处理里等导入。
const CODE_REGIONS_KEY = Symbol.for('personal-inbox.execution-record.findCodeRegions');
export function preloadCodeRegions(load = () => import('openclaw/plugin-sdk/text-chunking')) {
  const slot = (globalThis[CODE_REGIONS_KEY] ??= { fn: null, pending: null });
  if (slot.fn) return Promise.resolve(slot.fn);
  if (slot.pending) return slot.pending;
  slot.pending = Promise.resolve().then(load)
    .then(m => { if (typeof m?.findCodeRegions === 'function') slot.fn = m.findCodeRegions; return slot.fn; })
    .catch(() => null).finally(() => { slot.pending = null; });
  return slot.pending;
}
const loadedCodeRegions = () => globalThis[CODE_REGIONS_KEY]?.fn ?? null;
// 只认整段原始全文（宿主还没抽走 MEDIA 行的那份）的最后一个非空行：整行以 [[oc_changes 开头、]] 结尾，
// 用 findCodeRegions 在整段全文上判定不在代码区域里（以 [[ 开头，自然不是 > 引用）。
// 返回 none（没有标记、在代码区域里、函数没有）、invalid（是协议行，但 JSON 错、超 50 项或超 8 KB）、valid（files 数组）。
// 容错：bot 常在标记后面多写一行型号档位（如 `Sonnet/Cli · high`）。标记后面只许跟最多 2 行
// “型号样式的行”（正则 MODEL_LINE_RE，档位只许小写英文字母），或整行等于官方页脚 footerText 的行；中间允许空行。
// 后面只要有任何别的文字（哪怕一个字）仍然不认。返回里多带 trailingModelLines（0～2）和标记行在全文里的起始位置 markerStart。
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const MODEL_LINE_RE = new RegExp(`^(${FAMILIES.map((f) => f[0].toUpperCase() + f.slice(1)).join('|')})\\/(Cli|api|${cardTextAll('routeUnknown').map(reEsc).join('|')}) · [a-z]+$`);
const MAX_TRAILING_MODEL_LINES = 2;

// ───────── 发出消息清理─────────
// 乙：去掉正文末尾的 NO_REPLY。"独立词"：前面是行首、空白或 *，后面只许空白和标点；反引号包着的一律不去。
// 返回 { text, removed }。`*NO_REPLY*` 连两边的星号一起去。
export function stripTrailingNoReply(text) {
  const t = String(text ?? '');
  const star = /(?:^|\s)\*{1,2}NO_REPLY\*{1,2}[\s.。!！,，;；:：]*$/i.exec(t);
  if (star) return { text: t.slice(0, star.index).replace(/\s+$/, ''), removed: true };
  const plain = /(?<![^\s*])NO_REPLY[\s*.。!！,，;；:：]*$/i.exec(t);
  if (plain) return { text: t.slice(0, plain.index).replace(/\s+$/, ''), removed: true };
  return { text: t, removed: false };
}
// 官方可能把 bot 自己写的（或没确认搬走的）型号行留在 NO_REPLY 后面：先把末尾最多 2 行型号样式的行拿开，再判 NO_REPLY。
export function splitTrailingModelLines(text, footerText) {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  const footer = typeof footerText === 'string' && footerText.trim() ? footerText.trim() : null;
  const kept = [];
  let n = 0;
  while (lines.length && n < MAX_TRAILING_MODEL_LINES) {
    const t = lines[lines.length - 1].trim();
    if (!t) { lines.pop(); continue; }
    if (MODEL_LINE_RE.test(t) || (footer !== null && t === footer)) { kept.unshift(lines.pop()); n += 1; } else break;
  }
  return { head: lines.join('\n'), modelLines: kept };
}
// 整条（去掉空白后）只剩官方页脚或型号样式行（最多 2 行）？
export function isModelLinesOnly(text, footerText) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const footer = typeof footerText === 'string' && footerText.trim() ? footerText.trim() : null;
  return lines.length >= 1 && lines.length <= MAX_TRAILING_MODEL_LINES && lines.every(l => MODEL_LINE_RE.test(l) || (footer !== null && l === footer));
}
// 甲：开头（以及乙＋：紧挨 NO_REPLY 前面）那种整段纯英文的"工具前过程话"。
const CJK_RE = /[⺀-鿿　-〿豈-﫿＀-￯぀-ヿ가-힯]/;
const CJK_G = /[⺀-鿿　-〿豈-﫿＀-￯぀-ヿ가-힯]/g;
const PROTECT_RE = /error|fail|denied|exception|traceback|warn|not found|no such|not permitted|refused|timed? ?out|unauthori[sz]ed|forbidden|invalid|cannot|can['’]t|unable|permission|ENOENT|EACCES|EPERM|exit code/i;
// 开头最多 8 段、合计 800 字符（原来 2 段、300）；每一段自己的条件一条不松。
// 桌面角色型（A-3，只对桌面角色）：一段里中文字不超过 ENGLISH_DESKTOP_MAX_CJK 个（多是按钮名）也算英文段，其余条件照旧。
export const ENGLISH_PARAGRAPH_MAX = 160, ENGLISH_PREFIX_MAX_PARAGRAPHS = 8, ENGLISH_PREFIX_MAX_TOTAL = 800, ENGLISH_DESKTOP_MAX_CJK = 4;
// 一段是不是"可删的纯英文过程话"（不含"要不要删"的上下文条件）。返回 true／false。
export function isEnglishProcessParagraph(raw, { allowCjk = 0 } = {}) {
  const par = String(raw ?? '');
  if (/^( {4,}|\t)/.test(par)) return false;
  const t = par.trim();
  if (!t || t.length > ENGLISH_PARAGRAPH_MAX) return false;
  if (CJK_RE.test(t) && (allowCjk <= 0 || (t.match(CJK_G) ?? []).length > allowCjk)) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  if (!/[.!?:…]$/.test(t)) return false;
  if (/`|http|<@|<#|\[\[/i.test(t)) return false;
  if (/^(>|#|\|)/.test(t) || /^([-*•]\s|\d+[.)]\s)/.test(t)) return false;
  if (PROTECT_RE.test(t)) return false;
  return true;
}
const splitParagraphs = text => String(text).split(/(\n[ \t]*\n\s*)/); // 偶数下标是段落，奇数下标是分隔
// 开头：最多连续 ENGLISH_PREFIX_MAX_PARAGRAPHS 段、合计不超过 ENGLISH_PREFIX_MAX_TOTAL 字符；整条必须有中文，删完剩下至少 2 个中文字符。返回 { body, removed:[段], candidate, why }
export function stripLeadingEnglish(text, { allowCjk = 0 } = {}) {
  const t = String(text ?? '').replace(/^(?:[ \t]*\n)+/, '');   // 只去开头的空行，第一行的缩进要留着（缩进 4 空格以上当代码保住）
  const parts = splitParagraphs(t);
  const res = { body: String(text ?? ''), removed: [], candidate: false, why: null };
  if (!CJK_RE.test(t)) { res.why = '整条没有中文，不动'; return res; }
  if (!/^[A-Za-z]/.test(parts[0].trim())) { res.why = '开头不是英文段'; return res; }
  res.candidate = true;
  let k = 0, total = 0;
  while (k < ENGLISH_PREFIX_MAX_PARAGRAPHS && parts[2 * k] !== undefined && 2 * k + 1 < parts.length) {
    const par = parts[2 * k];
    if (!isEnglishProcessParagraph(par, { allowCjk })) break;
    if (total + par.trim().length > ENGLISH_PREFIX_MAX_TOTAL) break;
    total += par.trim().length; k += 1;
  }
  if (k === 0) { res.why = PROTECT_RE.test(parts[0]) ? '含保护词' : '不符合删除条件（长度／标点／格式）'; return res; }
  if (parts[2 * k] !== undefined && 2 * k + 1 < parts.length && isEnglishProcessParagraph(parts[2 * k], { allowCjk })) { res.why = `开头英文超过 ${ENGLISH_PREFIX_MAX_PARAGRAPHS} 段或 ${ENGLISH_PREFIX_MAX_TOTAL} 字符，不动`; return res; }
  const rest = parts.slice(2 * k).join('');
  if ((rest.match(CJK_G) ?? []).length < 2) { res.why = '删完剩下不足 2 个中文字符'; return res; }
  res.body = rest; res.removed = parts.filter((_, i) => i % 2 === 0).slice(0, k).map(x => x.trim());
  return res;
}
// 乙＋：去完 NO_REPLY 的正文里，紧挨在后面（结尾）的那一段如果是纯英文过程话，也去掉。返回 { body, removed:string|null }
export function stripEnglishBeforeNoReply(text) {
  const t = String(text ?? '').replace(/\s+$/, '');
  if (!t) return { body: t, removed: null };
  const parts = splitParagraphs(t);
  const lastIdx = parts.length - 1;
  if (!isEnglishProcessParagraph(parts[lastIdx])) return { body: t, removed: null };
  const body = parts.slice(0, Math.max(0, lastIdx - 1)).join('').replace(/\s+$/, '');
  return { body, removed: parts[lastIdx].trim() };
}
// 丙：两句写死的系统英文换成中文（整句精确匹配，不是包含匹配）。返回新文字，或 null＝不是这两句。
const SYSTEM_ENGLISH_KEYS = new Map([
  ['The AI service returned an empty reply. Please try again.', 'emptyReplyReplacement'],
  ["I couldn't confirm whether my previous reply reached this chat, so I won't resend it automatically. Please ask for any missing remainder.", 'unconfirmedReplacement'],
]);
const EMPTY_REPLY_NOTICE = 'The AI service returned an empty reply. Please try again.';
const UNCONFIRMED_NOTICE = "I couldn't confirm whether my previous reply reached this chat, so I won't resend it automatically. Please ask for any missing remainder.";
const normSystemEnglish = text => String(text ?? '').replace(/[‘’]/g, "'").trim().replace(/^⚠️?\s*/, '').trim();
export const isEmptyReplyNotice = text => typeof text === 'string' && normSystemEnglish(text) === EMPTY_REPLY_NOTICE;
export const isUnconfirmedDeliveryNotice = text => typeof text === 'string' && normSystemEnglish(text) === UNCONFIRMED_NOTICE;
export function translateSystemEnglish(text) {
  if (typeof text !== 'string') return null;
  const norm = text.replace(/[‘’]/g, "'").trim().replace(/^⚠️?\s*/, '').trim();
  const key = SYSTEM_ENGLISH_KEYS.get(norm);
  return key ? cardText()[key] : null;
}
export function parseChangeMarker(text, findCodeRegions, footerText) {
  if (typeof text !== 'string' || typeof findCodeRegions !== 'function') return { status: 'none' };
  const body = text.replace(/\s+$/, '');
  const footer = typeof footerText === 'string' && footerText.trim() ? footerText.trim() : null;
  const isModelLine = t => MODEL_LINE_RE.test(t) || (footer !== null && t === footer);
  // 从末尾往前找标记行：先数过最多 2 行型号样式的行（空行跳过），再往前第一个非空行必须是标记行。
  const lines = body.split('\n'), starts = [];
  for (let i = 0, o = 0; i < lines.length; i += 1) { starts.push(o); o += lines[i].length + 1; }
  let trailing = 0, idx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith(MARKER_HEAD) && t.endsWith(MARKER_TAIL)) { idx = i; break; }
    if (isModelLine(t) && trailing < MAX_TRAILING_MODEL_LINES) trailing += 1;
    else return { status: 'none' };
  }
  if (idx < 0) return { status: 'none' };
  const start = starts[idx], raw = lines[idx], line = raw.trim();
  const tail = { trailingModelLines: trailing, markerStart: start };
  if (!line.startsWith(MARKER_HEAD) || !line.endsWith(MARKER_TAIL)) return { status: 'none' };
  let regions;
  try { regions = findCodeRegions(text); } catch { return { status: 'none' }; }
  const offset = start + (raw.length - raw.trimStart().length);
  if (!Array.isArray(regions) || regions.some(g => offset >= g.start && offset < g.end)) return { status: 'none' };
  const markerHash = markerHashOf(line);
  if (Buffer.byteLength(line) > MARKER_MAX_BYTES) return { status: 'invalid', markerHash, ...tail };
  let data;
  try { data = JSON.parse(line.slice(MARKER_HEAD.length, -MARKER_TAIL.length)); } catch { return { status: 'invalid', markerHash, ...tail }; }
  const ok = isObj(data) && !Array.isArray(data) && Object.keys(data).length === 1 && Array.isArray(data.files)
    && data.files.length <= MARKER_MAX_FILES && data.files.every(f => typeof f === 'string' && f.trim());
  return ok ? { status: 'valid', files: data.files.map(f => f.trim()), markerHash, ...tail } : { status: 'invalid', markerHash, ...tail };
}

// 路径基准。bot 名单：资料/… → 资料根目录；其他相对路径 → 该 bot 工作区；/ 开头原样；
// ~ 开头、空串、含控制字符 → 无法识别（null）。工具证据只用绝对目标，不套 bot 的"资料/"简称。
const badChars = s => /[\u0000-\u001f\u007f]/.test(s);
export function listLiteral(raw, workspace, ziliaoRoot) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.startsWith('~') || badChars(s)) return null;
  if (isAbsolute(s)) return resolve(s);
  const alias = lexicon().dataAlias; // zh-CN "资料", en "dataroot": the short name of the data root in the changed-files list
  if (s === alias || s.startsWith(`${alias}/`)) return ziliaoRoot ? resolve(ziliaoRoot, s.slice(alias.length + 1)) : null;
  return workspace ? resolve(workspace, s) : null;
}
const evidenceLiteral = raw => typeof raw === 'string' && isAbsolute(raw) && !badChars(raw) ? resolve(raw) : null;
const rawPrivate = raw => String(raw ?? '').split(/[\\/]+/).some(isPrivateSegment);
// 真实键：文件在 → 真实路径；文件不在但上级在 → 上级真实路径加文件名；上级也不在、超时、到上限、权限拒绝 → null（没核清）。
async function realKeyOf(literal, rp, deadline) {
  if (!literal) return null;
  try { const v = await callWithin(rp, [literal], deadline); return isTimedOut(v) ? null : v; }
  catch (error) {
    if (error?.code !== 'ENOENT') return null;
    try { const d = await callWithin(rp, [dirname(literal)], deadline); return isTimedOut(d) ? null : join(d, basename(literal)); } catch { return null; }
  }
}
// 能显示名字：真实落点已核清、在该 bot 工作区或资料根目录之内，原始写法和真实路径每一级都没命中私密名。
// 其余只计数：私密名或确认不了 → 名称隐藏；真实落点在范围外 → 范围外文件。
function displayOf(item, roots) {
  if (item.rawPrivate || !item.real || !roots.length) return { kind: 'hidden' };
  for (const root of roots) {
    const rel = withinRoot(root.path, item.real);
    if (!rel) continue;
    const segments = rel.split(sep);
    return segments.some(isPrivateSegment) ? { kind: 'hidden' } : { kind: 'ok', label: labelOf(segments) };
  }
  return item.real.split(sep).some(isPrivateSegment) ? { kind: 'hidden' } : { kind: 'outside' };
}
const sameFile = (a, b) => (a.literal && a.literal === b.literal) || (a.real && b.real && a.real === b.real);
const uniqFiles = items => { const out = []; for (const x of items) if (!(x.literal || x.real) || !out.some(y => sameFile(x, y))) out.push(x); return out; };
const nameList = (names, cap) => names.slice(0, cap).join(cardText().listSep) + (names.length > cap ? cardText().more(names.length) : '');
function sortDisplay(items, roots) {
  const shown = [], acc = { hidden: 0, outside: 0 };
  for (const it of items) { const d = displayOf(it, roots); if (d.kind === 'ok') shown.push(d.label); else acc[d.kind]++; }
  return { shown, ...acc };
}
const countsText = ({ hidden, outside }) => [hidden ? cardText().hiddenN(hidden) : '', outside ? cardText().outsideN(outside) : ''].filter(Boolean).join(cardText().listSep);
// 一行写法。status：valid／invalid／none；bots、evid 是已核过的条目。
export function composeChange(status, bots, evid, roots, { nameCap = 8, leakCap = 3 } = {}) {
  const T = cardText();
  const E = uniqFiles(evid);
  if (status !== 'valid') {
    if (!E.length) return T.unlisted;
    const d = sortDisplay(E, roots), counts = countsText(d);
    const inner = d.shown.length ? (counts ? T.withExtra(nameList(d.shown, leakCap), counts) : nameList(d.shown, leakCap)) : counts;
    return T.unlistedTools(inner);
  }
  const B = uniqFiles(bots);
  const allResolved = B.every(b => b.real);
  // 漏列：这条证据核清、名单每一项都核清、却没有一项和它相同。其余不报漏列。字面完全相同直接算列过。
  const leaks = E.filter(e => !B.some(b => sameFile(b, e)) && e.real && allResolved);
  const listed = sortDisplay(B, roots), leaked = sortDisplay(leaks, roots);
  const counts = countsText(listed);
  const base = listed.shown.length ? nameList(listed.shown, nameCap) : counts || T.none;
  const segs = [];
  if (listed.shown.length && counts) segs.push(T.also(counts));
  if (leaked.shown.length) segs.push(T.leaked(leaked.shown.length, nameList(leaked.shown, leakCap)));
  if (leaked.hidden) segs.push(T.leakedHidden(leaked.hidden));
  if (leaked.outside) segs.push(T.leakedOutside(leaked.outside));
  return base + (segs.length ? T.wrap(segs.join(T.segSep)) : '');
}
const LINE_CAP = 700;
function composeChangeLine(status, bots, evid, roots) {
  for (const caps of [{ nameCap: 8, leakCap: 3 }, { nameCap: 4, leakCap: 2 }, { nameCap: 2, leakCap: 1 }, { nameCap: 1, leakCap: 1 }]) {
    const line = composeChange(status, bots, evid, roots, caps);
    if (line.length <= LINE_CAP) return line;
  }
  return `${composeChange(status, bots, evid, roots, { nameCap: 1, leakCap: 1 }).slice(0, LINE_CAP - 1)}…`;
}

// 3.3 成功状态三态：失败（有错误或失败形状）、成功（有结果、没错误）、不明（结束了但既没结果也没错误）。
const badStatus = v => ['failed', 'suppressed', 'error', 'partial_failed'].includes(String(v ?? '').toLowerCase());
const failedShape = r => isObj(r) && (r.isError === true || r.ok === false || (isObj(r.details) && (r.details.isError === true || r.details.ok === false || badStatus(r.details.status))));
const statusOf = (result, isError) => isError || failedShape(result) ? 'failed' : result === undefined || result === null ? 'unknown' : 'ok';
// T／I 等插件工具的成功证据：插件层 {content, details}（官方 tool-results-BCM3fdVS.mjs:2-13、我们的 index.mjs:84-85）里 details 是对象且没有失败标志。
const detailsOk = r => isObj(r) && isObj(r.details) && !failedShape(r);

// 监控根目录的真实路径：异步解析，可按截止时间放弃（没解析出来的根目录当作没有）。
const rootsFor = async (workspace, ziliaoRoot, { deadline, realpathFn = realpath } = {}) => {
  const one = async (id, p) => { if (!p) return null; try { const v = await callWithin(realpathFn, [p], deadline); return isTimedOut(v) ? null : { id, path: v }; } catch { return null; } };
  return (await Promise.all([one('workspace', workspace), one('ziliao', ziliaoRoot)])).filter(Boolean);
};

// scan：前后比对——代码留在 change-scan.mjs，这里不再调用；参数只为测试证明调用次数为 0。
export function createExecutionRecord({ now = Date.now, readQuota = async () => ({ status: 'unknown' }), workspaceFor = () => null, strictRoute = false, trailing = null,
  ziliaoRoot = null, scan = null, finalScanWaitMs = 800, random = Math.random, realpathFn = realpath, findCodeRegions = null, logger = null, archive = null } = {}) {
  void scan;
// 英文清理的每次判断（删／没删）原文另存档，长期可查（网关日志在临时目录，只留两天左右）。archive 由注册处注入；没注入就不存。
  const ARCHIVE_ACTIONS = new Set(['drop-leading-english', 'keep-leading-english', 'drop-english-before-NO_REPLY', 'keep-english-before-NO_REPLY']);
  const logD9 = row => {
    try { logger?.(row); } catch { /* 只是记录 */ }
    if (archive && ARCHIVE_ACTIONS.has(row?.action)) { try { archive({ at: new Date(now()).toISOString(), ...row, text: typeof row.text === 'string' ? row.text.slice(0, 300) : undefined }); } catch { /* 存档失败不影响发消息 */ } }
  };
  const { reg, versionGap } = openRegistry();
  // 本插件所有路径查询都过这个共享上限（到上限就按超时处理、不排队）
  const fsLimit = (reg.fsInflight ??= { active: 0, max: FS_INFLIGHT_MAX });
  const rp = limitInflight(fsLimit, realpathFn);
  const codeRegions = () => findCodeRegions ?? loadedCodeRegions();
  const instanceId = `${reg.instances++}-${Math.floor(random() * 0x10000).toString(16).padStart(4, '0')}`;
  // 本实例私有：卡片去重、回复自带附件
  const carded = new Map();
  const replyMedia = new Map();
  const markCarded = runId => {
    const cutoff = now() - 24 * 60 * 60 * 1000;
    for (const [k, seenAt] of carded) if (seenAt < cutoff) carded.delete(k);
    while (carded.size >= 256 && !carded.has(runId)) carded.delete(carded.keys().next().value);
    carded.set(runId, now());
  };
  const forget = runId => {
    while (reg.evicted.size >= 1024) reg.evicted.delete(reg.evicted.keys().next().value);
    reg.evicted.set(runId, now());
  };
  // 容量 256、24 小时，最旧先挤出；被挤出的运行后来再来事件 → 当作没有开始，记缺口。
  const touch = (runId, { create = true } = {}) => {
    const cutoff = now() - RUN_TTL;
    for (const [k, r] of reg.runs) if (r.seenAt < cutoff) { reg.runs.delete(k); forget(k); }
    let r = reg.runs.get(runId);
    if (!r && !create) return null;
    if (!r) {
      while (reg.runs.size >= RUN_CAP) { const [k] = reg.runs.entries().next().value; reg.runs.delete(k); forget(k); }
      r = newRun(now());
      if (reg.evicted.has(runId)) r.gaps.add('evicted');
      if (versionGap) r.gaps.add('registry-version');
      r.ziliaoRoot = ziliaoRoot;
      reg.runs.set(runId, r);
    }
    r.seenAt = now();
    return r;
  };
  const noteIdentity = (r, agentId, sessionKey) => { if (agentId && !r.agentId) r.agentId = agentId; if (sessionKey && !r.sessionKey) r.sessionKey = sessionKey; };

  // 两套工具号并存：不配对、不猜。
  // 同号（source 'native'）：Claude 命令行自带工具和别的 MCP 服务的工具，事件流和钩子都用 toolu_…，按完整工具号合并。
  // 并存：OpenClaw 自带工具。事件流那份（'openclaw-stream'）只管开始／结束；钩子那份（'openclaw-hook'，MCP 回环 mcp-<uuid>，
  // 官方 mcp-http.handlers-Dqi__4xG.mjs:70-86）按完整 mcp- 号去重，成功证据和文件目标只认它，成功和目标来自同一份返回。
  const sourceOf = (rawName, toolId, via) => via === 'hook' ? (/^mcp-/.test(String(toolId)) ? 'openclaw-hook' : 'native')
    : /^mcp__openclaw__/i.test(String(rawName ?? '')) ? 'openclaw-stream' : 'native';
  // 合并只能加风险：可能写文件 > 任务板／收件箱／发消息 > 只读
  const riskRank = cls => !cls ? 0 : MAYBE_WRITE.has(cls) ? 3 : cls === 'R' ? 1 : 2;
  // 冲突同时记在运行上（缺口）和这条工具记录上；有冲突的工具记录不进明确写入证据。
  const conflict = (r, t) => { r.gaps.add('conflict'); if (t) t.conflict = true; };
  const entryFor = (r, toolId, name, source) => {
    let t = r.tools.get(toolId);
    if (t) { if (t.source !== source && !(t.source === 'native' && source === 'native')) conflict(r, t); return t; }
    t = { name, source, cls: null, action: undefined, needsArgs: false, terminal: false, status: undefined, target: undefined, via: new Set(), startAt: null, conflict: false };
    r.tools.set(toolId, t);
    return t;
  };
  // 覆盖核对（出卡判定点算，只留在记录里，不影响卡上文字）
  const groupKey = t => `${t.cls ?? '?'}|${t.action ?? 'none'}`;
  const coverageOf = r => {
    const groups = new Map();
    for (const t of r.tools.values()) {
      if (t.source === 'native') continue;
      if (t.source === 'openclaw-stream' && !t.terminal) continue;
      const k = `${t.name}#${groupKey(t)}`, g = groups.get(k) ?? { stream: 0, hook: 0 };
      g[t.source === 'openclaw-stream' ? 'stream' : 'hook']++; groups.set(k, g);
    }
    for (const g of groups.values()) if (g.stream !== g.hook) return false;
    return true;
  };
  const settleGaps = r => { for (const t of r.tools.values()) if (t.needsArgs) r.gaps.add('class-missing'); };
  // 合并：第一个结束事件定下状态；有一边不明 → 留不明；明确成功对明确失败 → 不明＋冲突。
  const mergeStatus = (r, t, status) => {
    if (!t.terminal) { t.terminal = true; t.status = status; return; }
    if ((t.status === 'ok' && status === 'failed') || (t.status === 'failed' && status === 'ok')) { t.status = 'unknown'; conflict(r, t); }
    else if (status === 'unknown' || t.status === 'unknown') t.status = 'unknown';
  };
  const mergeSync = (r, t, sync) => {
    if (!t.sync) { t.sync = { ...sync }; return; }
    for (const k of ['written', 'target']) {
      if (sync[k] === undefined) continue;
      if (t.sync[k] === undefined) t.sync[k] = sync[k]; else if (t.sync[k] !== sync[k]) { conflict(r, t); t.sync.written = undefined; }
    }
  };
  const resolveLoose = (p, ws) => typeof p === 'string' ? resolve(ws ?? '/', p) : p;
  // phase：'start' 或 'end'；via：'stream'／'hook'
  const record = ({ runId, toolId, rawName, args, phase, result, isError, via, agentId, sessionKey }) => {
    if (!runId) return;
    const r = touch(runId);
    noteIdentity(r, agentId, sessionKey);
    if (!toolId) { r.gaps.add('unlinkable'); return; }
    const name = nameOf(rawName), source = sourceOf(rawName, toolId, via);
    const t = entryFor(r, toolId, name, source);
    t.via.add(via);
    if (name && !t.name) t.name = name;
    if (name && t.name && t.name !== name) conflict(r, t);
    const cl = classifyTool(t.name || name, args);
    if (!cl.needsArgs) {
      if (t.cls && !t.needsArgs && (t.cls !== cl.cls || (t.action && cl.action && t.action !== cl.action))) {
        conflict(r, t);
        if (riskRank(cl.cls) > riskRank(t.cls)) { t.cls = cl.cls; t.action = cl.action; }
      }
      if (!t.cls || t.needsArgs) { t.cls = cl.cls; t.action = cl.action; t.needsArgs = false; }
    } else if (!t.cls) { t.cls = cl.cls; t.action = cl.action; t.needsArgs = true; }
    // 写类工具只留目的地提示（到出卡为止），绝不留文件内容、命令、工具结果或任意参数
    if (t.cls === 'W' && isObj(args)) {
      const p = args.file_path ?? args.path ?? args.notebook_path;
      if (typeof p === 'string' && p.trim()) {
        const ws = workspaceFor(r.sessionKey, runId, r.agentId);
        if (t.target !== undefined && resolveLoose(t.target, ws) !== resolveLoose(p, ws)) conflict(r, t);
        if (t.target === undefined) t.target = p;
      }
    }
    if (phase === 'start' && t.startAt === null) t.startAt = now();
    if (phase !== 'end') return;
    mergeStatus(r, t, statusOf(result, isError));
    if (source === 'openclaw-stream') return;   // 事件流那份不提供成功证据和文件目标
    if (detailsOk(result)) t.detailsOk = true;
    if (t.cls === 'M' && messageSendSucceeded(result)) t.sendOk = true;
    if (t.cls === 'S' && isObj(result?.details) && typeof result.details.written === 'boolean')
      mergeSync(r, t, { written: result.details.written, target: typeof result.details.target === 'string' ? result.details.target : undefined });
    // D9：这一轮用 message 工具发过带附件的消息（不管成没成、目的地对不对得上）——状态通知的新分流不碰这种轮次，走老路径
    if (t.cls === 'M' && MESSAGE_SEND.has(t.action) && isObj(args) && sendsMedia(args)) r.mediaSendSeen = true;
    if (t.cls === 'M' && MESSAGE_SEND.has(t.action) && isObj(args) && sendsMedia(args) && messageSendSucceeded(result)) {
      const route = attachmentRoute(args, result);
      if (route.ok) (r.attachments ??= []).push({ platform: route.platform, account: route.account, destination: route.destination });
    }
  };
  // 明确写入证据：同号工具和 OpenClaw 钩子那份；成功、有绝对目标、没冲突；同步要 written:true。
  const evidenceOf = r => {
    const out = [];
    for (const t of r.tools.values()) {
      if (t.source === 'openclaw-stream' || !t.terminal || t.status !== 'ok' || t.conflict) continue;
      if (t.cls === 'W' && typeof t.target === 'string') out.push(t.target);
      else if (t.cls === 'S' && t.sync?.written === true && typeof t.sync.target === 'string') out.push(t.sync.target);
    }
    return out.map(evidenceLiteral).filter(Boolean);
  };

  // 官方页脚确认和 bot 自列名单的依据：CLI 运行时在最终回复前发一条 assistant 事件，data.text＝最终可见文字（不含页脚；
  // dist/agent-runner-run-3xhrTB12.mjs:1909-1925，优先取 meta.finalAssistantVisibleText，正常 CLI 路径上是整轮全文）。
  // 只存哈希和名单解析结果，不存正文；容量 64、10 分钟；键是 runId。两张表放在 globalThis 上，跨 record 实例／模块代共享。
  const assistantSeen = (globalThis[Symbol.for('personal-inbox.execution-record.assistantSeen')] ??= new Map());
  const lastDelivery = new Map();
  const changeLists = (globalThis[Symbol.for('personal-inbox.execution-record.changeLists')] ??= new Map());
  // 发送前处理：按 runId 记本轮每份载荷里的标记内容，和“本轮已发片段表”（顺序、去掉标记后正文的哈希、是不是最终那份、发送结果）。
  const runMarkers = (globalThis[Symbol.for('personal-inbox.execution-record.runMarkers')] ??= new Map());
  const fragmentsByRun = (globalThis[Symbol.for('personal-inbox.execution-record.fragments')] ??= new Map());
  const normText = t => String(t ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const hashText = t => createHash('sha256').update(normText(t)).digest('hex');
  const stripMediaLines = t => String(t ?? '').split(/\r?\n/).filter(l => !/^\s*MEDIA:\s*\S/.test(l)).join('\n');
  // 宿主（directive-tags-BdDun4Er.mjs 第 10、12 行起）会把回复开头的 [[reply_to_current]]、[[reply_to: …]] 抽走，载荷里就没有了；
  // 算哈希前照同样的规则去掉开头的回复指令，才能和载荷对上。
  const stripReplyDirective = t => String(t ?? '').replace(/^\s*\[\[\s*reply_to(?:_current|\s*:[^\]]*)\s*\]\]\s*/i, '');
  const bounded = (map, runId, value) => {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [k, v] of map) if (v.at < cutoff) map.delete(k);
    while (map.size >= 64 && !map.has(runId)) map.delete(map.keys().next().value);
    map.set(runId, value);
  };
  const noteAssistant = (runId, text) => {
    // 实测（文字＋附件）：assistant 最终文字末尾带 `MEDIA:路径` 行，宿主把它抽成附件后，载荷正文里没有这一行。两种写法的哈希都记。
    const hashes = { hash: hashText(text), hashNoMedia: hashText(stripMediaLines(text)), hashNoReply: hashText(stripReplyDirective(text)), hashNoMediaNoReply: hashText(stripReplyDirective(stripMediaLines(text))), at: now() };
// 这一轮最终文字只有 NO_REPLY（bot 故意不说话）；官方随后可能报“空回复”，那句提示要取消。
    { const nr = stripTrailingNoReply(String(text ?? '')); if (nr.removed && !nr.text.trim()) hashes.silentNoReply = true; }
    bounded(assistantSeen, runId, hashes);
    // 名单在这里同步解析（用整段原始全文，MEDIA 行还没抽走）；路径查询留到出卡时在预算里做。
    bounded(changeLists, runId, { ...hashes, ...parseChangeMarker(text, codeRegions()) });
  };
  const hasMediaOf = q => Boolean(q.mediaUrl || q.mediaUrls?.length || q.attachments?.length);
  // 删法（D7）：从标记行开头（markerStart）整段截掉——标记行、它后面的空行、型号行一起去掉；按位置截，不按行数删。
  const cutFrom = (text, markerStart) => String(text ?? '').slice(0, markerStart).replace(/\r\n/g, '\n').replace(/\s+$/, '');
  // ───── 发出消息清理：乙去末尾 NO_REPLY（含乙＋），甲删开头纯英文过程话。管 claude-cli 路径和 API 路径（anthropic、anthropic-api，备用 bot 批 L6）；甲和乙＋只在这一轮确实用过工具时动。
  // 这一轮用过工具？拿 touch(runId,{create:false}) 的记录，r.tools 至少一条；拿不到记录按"没有"处理。
  const usedTools = runId => (touch(runId, { create: false })?.tools?.size ?? 0) > 0;
  const whoOf = runId => ({ agent: touch(runId, { create: false })?.agentId ?? null, runId, usedTools: usedTools(runId) });
  // 乙（先做）：去掉正文末尾的 NO_REPLY。官方可能把 bot 自己写的（或没确认搬走的）型号行留在 NO_REPLY 后面：先拿开末尾型号行再判；
  // 去完只剩型号行就整条算空；还有正文就把型号行原样接回去。标记可能写在 NO_REPLY 前面也可能后面，所以这一步排在删标记之前。
  const dropNoReply = (runId, text, footerText) => {
    const { head, modelLines } = splitTrailingModelLines(text, footerText);
    const nr = stripTrailingNoReply(head);
    if (!nr.removed) return { text, removed: false };
    logD9({ ...whoOf(runId), action: 'drop-NO_REPLY' });
    return { text: nr.text.trim() ? [nr.text, ...modelLines].join('\n') : '', removed: true };
  };
  // 乙＋和甲（删标记之后做）。noReplyRemoved：前面确实去掉了末尾 NO_REPLY（乙＋只在这时动）。
  // hasMedia：这份载荷带图片、附件（按钮、presentation 在更前面已提前返回）时，乙＋和甲都跳过；去末尾 NO_REPLY（乙）在 peel 里照做，不受影响。
  const cleanBody = (runId, body, noReplyRemoved, hasMedia = false) => {
    if (!englishCleanupEnabled()) return { body: String(body ?? ''), changed: false }; // only for locale zh-CN
    if (hasMedia) { if (String(body ?? '').trim()) logD9({ ...whoOf(runId), action: 'skip-english-cleanup', why: '载荷带附件，甲和乙＋不动' }); return { body: String(body ?? ''), changed: false }; }
    const who = whoOf(runId), used = who.usedTools;
    let out = String(body ?? ''), changed = false;
    if (noReplyRemoved && out.trim()) {
      if (used) {
        const tail = stripEnglishBeforeNoReply(out);
        if (tail.removed !== null) { out = tail.body; changed = true; logD9({ ...who, action: 'drop-english-before-NO_REPLY', text: tail.removed.slice(0, 300) }); }
      } else if (isEnglishProcessParagraph(splitParagraphs(out).at(-1))) {
        logD9({ ...who, action: 'keep-english-before-NO_REPLY', why: '这一轮没用过工具', text: String(splitParagraphs(out).at(-1) ?? '').trim() });
      }
    }
    // 甲：开头纯英文过程话（只在用过工具时）。桌面角色型（A-3）：只对桌面角色，一段里中文字不超过 ENGLISH_DESKTOP_MAX_CJK 个也算。
    const lead = stripLeadingEnglish(out, { allowCjk: who.agent === 'desktop' ? ENGLISH_DESKTOP_MAX_CJK : 0 });
    if (lead.candidate) {
      if (!used) logD9({ ...who, action: 'keep-leading-english', why: '这一轮没用过工具', text: out.trim().slice(0, 300) });
      else if (lead.removed.length) { out = lead.body; changed = true; logD9({ ...who, action: 'drop-leading-english', text: lead.removed.join(' ¶ ').slice(0, 300) }); }
      else logD9({ ...who, action: 'keep-leading-english', why: lead.why, text: out.trim().slice(0, 300) });
    }
    return { body: out, changed };
  };
  // 认出这份载荷末行的 [[oc_changes …]] 标记并去掉；标记内容记到本轮（中途那份里的也不丢，并进最终那份的附卡）。
  // 只认整行独占、不在代码区域里的协议行；识别函数没加载好时什么都不删（保守）。
  const takeMarker = (runId, text, footerText) => {
    const parsed = parseChangeMarker(text, codeRegions(), footerText);
    if (parsed.status === 'none') return { body: text, removed: false };
    const items = runMarkers.get(runId)?.items ?? [];
    bounded(runMarkers, runId, { at: now(), items: [...items, parsed.status === 'valid' ? { status: 'valid', files: parsed.files } : { status: 'invalid' }] });
    return { body: cutFrom(text, parsed.markerStart), removed: true };
  };
  // 一份载荷的"剥皮"：先去末尾 NO_REPLY（标记可能写在它后面）→ 删标记（含后面的型号行）→ 标记后面如果还留着 NO_REPLY（标记写在它前面）再去一次。
  const peel = (runId, text, footerText) => {
    let body = text, noReplyRemoved = false, markerRemoved = false;
    const n1 = dropNoReply(runId, body, footerText);
    if (n1.removed) { body = n1.text; noReplyRemoved = true; }
    const taken = takeMarker(runId, body, footerText);
    if (taken.removed) { body = taken.body; markerRemoved = true; }
    if (!noReplyRemoved) { const n2 = dropNoReply(runId, body, footerText); if (n2.removed) { body = n2.text; noReplyRemoved = true; } }
    return { body, markerRemoved, noReplyRemoved };
  };
  const mergedMarkers = runId => {
    const items = runMarkers.get(runId)?.items ?? [];
    if (!items.length) return { status: 'none' };
    if (items.some(i => i.status === 'invalid')) return { status: 'invalid' };
    return { status: 'valid', files: [...new Set(items.flatMap(i => i.files))].slice(0, MARKER_MAX_FILES) };
  };
  const addFragment = (runId, fragment) => {
    const list = fragmentsByRun.get(runId)?.list ?? [];
    bounded(fragmentsByRun, runId, { at: now(), list: [...list, { ...fragment, sent: 'pending', at: now() }].slice(-32) });
  };
  // 一轮中途发出的载荷（不是最终那份）：只在发送前去标记、记片段，不挂附卡。
  const midPayload = (event, p) => {
    if (p.isStatusNotice || typeof p.text !== 'string' || !p.text.trim()) return;
    if (p.presentation || p.interactive || p.audioAsVoice || p.channelData?.discord?.components?.length || p.channelData?.execApproval) return;
    const u = event.usageState;
    if (u?.resolvedRef !== undefined && !isCleanRouteRef(u.resolvedRef)) return;
    const cli = isCleanRouteRef(u?.resolvedRef);
    let taken, body, edited = false;
    if (cli) {
      const pl = peel(event.runId, p.text, expectedFooter(u, p.text));
      taken = { removed: pl.markerRemoved }; body = pl.body; edited = pl.noReplyRemoved;
      const c = cleanBody(event.runId, body, pl.noReplyRemoved, hasMediaOf(p)); body = c.body; if (c.changed) edited = true;
    } else { taken = takeMarker(event.runId, p.text, expectedFooter(u, p.text)); body = taken.body; }
    addFragment(event.runId, { hash: hashText(body), final: false });
    if (!taken.removed && !edited) return;
    if (!body.trim() && !hasMediaOf(p)) return { cancel: true, reason: 'execution-record: change-list marker only' };
    return { payload: { ...p, text: body } };
  };
  return {
    instanceId,
    observe(event) {
      if (!event?.runId) return;
      // assistant 事件只认回复结束前的最终正文 `{itemId:'cli-assistant:<runId>', text}`（没有 delta）；
      // 中间增量一律不记，且作废这一轮已记的（以免"最终之后又有增量"）。
      if (event.stream === 'assistant') {
        const d = event.data ?? {};
        if (typeof d.delta === 'string') { assistantSeen.delete(event.runId); changeLists.delete(event.runId); }
        else if (d.itemId === `cli-assistant:${event.runId}` && typeof d.text === 'string' && d.text.trim() && d.completedText === undefined) noteAssistant(event.runId, d.text);
      }
      if (event.stream === 'lifecycle') {
        const phase = event.data?.phase;
        if (phase === 'start') { const r = touch(event.runId); noteIdentity(r, event.agentId, event.sessionKey); r.started = true; if (r.startedAt === null) r.startedAt = now(); }
        else if (phase === 'end' || phase === 'error') { const r = touch(event.runId, { create: false }); if (r && r.endedAt === null) r.endedAt = now(); }
      }
      if (event.stream !== 'tool') return;
      const d = event.data ?? {};
      if (!['start', 'result'].includes(d.phase)) return;
      record({ runId: event.runId, toolId: d.toolCallId, rawName: d.name, args: d.args, phase: d.phase === 'result' ? 'end' : 'start',
        result: d.result, isError: d.isError === true || d.result?.isError === true, via: 'stream', agentId: event.agentId, sessionKey: event.sessionKey });
    },
    afterTool(event, ctx) {
      record({ runId: ctx?.runId ?? event.runId, toolId: ctx?.toolCallId ?? event.toolCallId, rawName: event.toolName, args: event.params, phase: 'end',
        result: event.result, isError: Boolean(event.error) || event.result?.isError === true, via: 'hook', agentId: ctx?.agentId, sessionKey: ctx?.sessionKey });
    },
// bot 用 message 工具直接发的话，文字字段里若带着 [[oc_changes …]] 标记，发出前去掉（返回改后的参数）。
    // 标记内容照 takeMarker 记到本轮（修改栏不丢）；没有运行编号就只去掉不记。字段名沿用 audit-gate 读 message 文字的那四个。
    // 读代码说命令行的 MCP 桥会用改后的参数执行（mcp-http.handlers 第 102～117 行），真实路径上要在上线后第一件事实测。
    stripToolMarker(event, ctx = {}) {
      const tool = String(event?.toolName ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();
      if (tool !== 'message') return undefined;
      const params = event?.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
      const next = { ...params }; let changed = false;
      for (const f of ['message', 'content', 'text', 'body']) {
        if (typeof params[f] !== 'string') continue;
        try {
          if (ctx?.runId) {
            const t = takeMarker(ctx.runId, params[f], undefined);
            if (t.removed) { next[f] = t.body; changed = true; }
          } else {
            const parsed = parseChangeMarker(params[f], codeRegions(), undefined);
            if (parsed.status !== 'none') { next[f] = cutFrom(params[f], parsed.markerStart); changed = true; }
          }
        } catch { /* 识别出错就不动这一段 */ }
      }
      // 第 8 步 S0：真实路径上要能看出“标记到底有没有被去掉”——记一行（只记字段名，不记内容）。
      if (changed) logD9({ action: 'strip-tool-marker', runId: ctx?.runId ?? null, fields: ['message', 'content', 'text', 'body'].filter((f) => next[f] !== params[f]) });
      return changed ? { params: next } : undefined;
    },
    async payload(event, ctx = {}) {
      if ((event.channel ?? ctx.channelId) !== 'discord' || !event.runId) return;
      const p = event.payload;
      if (!p || p.isError) return;
      // 不是最终那份（一轮中途发出的）：发送前同样去标记并记片段，但不挂附卡。
      if (event.kind !== 'final' || ctx.openclawMacFinalPayload === false) return midPayload(event, p);
      const hasMedia = hasMediaOf;
      // 回复本身带附件、没有文字：这条不加框，只记"本轮回复自己带了附件"，等随后的页脚状态通知换成独立的框。
      if (!p.isStatusNotice && !p.text?.trim() && hasMedia(p) && !p.channelData?.discord?.embeds?.some(e => e?.[CARD_MARK]) && !carded.has(event.runId)) {
        while (replyMedia.size >= 256 && !replyMedia.has(event.runId)) replyMedia.delete(replyMedia.keys().next().value);
        replyMedia.set(event.runId, now()); return;
      }
      // "这一轮之前有没有发过正文片段"必须在这一份载荷自己的 addFragment 之前算（算晚了永远为真，甲路走不到）。
      const earlier = (fragmentsByRun.get(event.runId)?.list.length ?? 0) > 0;
      const r = touch(event.runId, { create: false }), u = event.usageState;
      const expected = expectedFooter(u, p.text);
      // 只发附件：官方在最终回复无文字时造一条只有页脚行的状态通知载荷。只有"页脚行逐字等于按用量状态算出的官方页脚"、
      // 且本轮有附件成功发到这条回复所在的平台／账号／最终频道或线程，才换成"空文字＋框"。
      const footerOnly = p.isStatusNotice === true && expected && typeof p.text === 'string' && p.text.trim() === expected
        && (replyMedia.has(event.runId) || attachmentMatches(r, ctx, { strict: strictRoute }));
      // 丁（D9 第 7 点）：官方在"这一轮没有任何文字"时造一条只有页脚行的状态通知（agent-runner-run appendUsageLine）。
      // 整条只剩官方页脚或型号样式行（最多 2 行）、没有任何别的字、没有附件／按钮：这一轮之前没发出过任何片段 → cancel（既不发也不出卡）；
      // 之前已发过正文、只是最终这份没字 → 才只出一张"空文字＋附卡"（已出过卡的仍是 cancel）。其余状态通知原样放行（保守）。
      let statusOnly = false;
      if (p.isStatusNotice && !footerOnly) {
        // 这一轮有过附件（不管目的地对不对得上）：属 footerOnly 老路径的范围，一个字不动——原样放行
        const runAttachments = replyMedia.has(event.runId) || (r?.attachments?.length ?? 0) > 0 || r?.mediaSendSeen === true;
        const richSkip = runAttachments || p.presentation || p.interactive || p.audioAsVoice || p.channelData?.discord?.components?.length || p.channelData?.execApproval || hasMedia(p) || p.channelData?.discord?.embeds?.length;
        if (!isCleanRouteRef(u?.resolvedRef) || richSkip || !isModelLinesOnly(p.text, expected)) return;
        if (!earlier || carded.has(event.runId)) {
          logD9({ action: 'cancel-footer-only-status', runId: event.runId, earlier, carded: carded.has(event.runId), text: String(p.text).slice(0, 80) });
          return { cancel: true, reason: 'execution-record: footer-only status notice' };
        }
        statusOnly = true;
      }
      if (!footerOnly && !statusOnly && !p.text?.trim() && !hasMedia(p)) return;
      // 有意跳过（不加框）的输出：富组件／版式／互动／语音／审批类／错误／状态通知。
      if (p.presentation || p.interactive || p.audioAsVoice || p.channelData?.discord?.components?.length || p.channelData?.execApproval) return;
      // 处理顺序固定：①页脚 → ②删标记 → ③尾框。
      // ①页脚搬走：末行逐字等于按用量状态算出的官方页脚，且去掉它后的正文哈希等于本轮最终助手事件的文字，才去掉；否则原样保留。
      let body = statusOnly ? '' : (p.text ?? '');
      if (expected && !statusOnly) {
        const lines0 = body.replace(/\s+$/, '').split('\n');
        if (lines0.length > 1 && lines0[lines0.length - 1].trim() === expected) {
          const rest = lines0.slice(0, -1).join('\n');
          const seen = assistantSeen.get(event.runId), restHash = hashText(rest);
          // 一轮里先发过别的载荷（中途插话）时，最终助手文字是几段拼起来的，和这一份对不上哈希；此时末行逐字等于官方页脚就搬走。
          // API 路径的原生运行方式不发命令行那种"最终正文"事件（没有 seen），所以 API 路径上末行逐字等于官方页脚就搬走，不再要求哈希对上。
          if ((seen && [seen.hash, seen.hashNoMedia, seen.hashNoReply, seen.hashNoMediaNoReply].includes(restHash)) || earlier || isApiRouteRef(u?.resolvedRef)) { body = rest; }
        }
      }
      // ②bot 自列名单：在发送前按这一轮（runId）处理——凡属于"可清理路径"（`isCleanRouteRef`：Claude 命令行，或 API 通路的四个提供商）这一轮的载荷，末行的 [[oc_changes …]] 标记一律去掉
      // （中途那份也去，不再等最终文字对上哈希）；标记里的内容并进最终那份的附卡。没有用量状态、认不出是可清理路径的最终载荷保守：不删、写"未列"。
      let listState = { status: 'none' }, markerRemoved = false, edited = false, noReplyRemoved = false;
      if (!footerOnly && isCleanRouteRef(u?.resolvedRef)) {
        if (!statusOnly) {
          // 乙／甲必须插在 addFragment 和 tr.arm 之前：这两处按"删完后的正文"和发出后的 message_sent.content 逐字配对。
          const pl = peel(event.runId, body, expected);
          body = pl.body; markerRemoved = pl.markerRemoved; noReplyRemoved = pl.noReplyRemoved; if (noReplyRemoved) edited = true;
          const c = cleanBody(event.runId, body, noReplyRemoved, hasMedia(p));
          if (c.changed) { body = c.body; edited = true; }
        }
        // 乙路补出的附卡：修改栏照常合并本轮 bot 自己列的名单（不当成 footerOnly 跳过这一合并，否则写成"未列"）
        listState = mergedMarkers(event.runId);
      }
      // 去掉 NO_REPLY 后什么都不剩（且没有附件）：这一轮之前没发出过任何片段 → 直接取消、什么都不发；之前发过正文的才只出附卡。
      if (noReplyRemoved && !body.trim() && !hasMedia(p) && !earlier) {
        logD9({ action: 'cancel-silent-turn', runId: event.runId });
        return { cancel: true, reason: 'execution-record: silent turn (NO_REPLY only)' };
      }
      const alreadyCarded = p.channelData?.discord?.embeds?.some(e => e?.[CARD_MARK]) || carded.has(event.runId);
      addFragment(event.runId, { hash: hashText(body), final: true });
      if (alreadyCarded) {
        // 同一轮已经出过卡：不再加卡，但可信载荷上的标记照样删；删完什么都不剩、也没有附件 → 跳过这条（不出第二张卡）。
        if (!markerRemoved && !edited) return;
        if (!body.trim() && !hasMedia(p)) return { cancel: true, reason: 'execution-record: change-list marker only' };
        return { payload: { ...p, text: body } };
      }
      markCarded(event.runId);
      // 修改栏：名单和明确写入证据的路径查询，都在出卡的 800 ms 预算里做（共享上限 8 个、到点不再发起、晚到不改卡）。
      if (r) settleGaps(r);
      const workspace = (r ? workspaceFor(r.sessionKey, event.runId, r.agentId) : null) ?? workspaceFor(ctx.sessionKey ?? event.sessionKey, event.runId, ctx.agentId);
      const zRoot = r?.ziliaoRoot ?? ziliaoRoot;
      const bots = listState.status === 'valid'
        ? listState.files.map(raw => ({ literal: listLiteral(raw, workspace, zRoot), rawPrivate: rawPrivate(raw), real: null })) : [];
      const evid = (r ? evidenceOf(r) : []).map(literal => ({ literal, rawPrivate: rawPrivate(literal), real: null }));
      const resolved = { roots: [] };
      const deadline = Date.now() + finalScanWaitMs;
      const work = bots.length || evid.length ? (async () => {
        resolved.roots = await rootsFor(workspace, zRoot, { deadline, realpathFn: rp });
        // 逐个解析（一张卡内不并发，名额随即归还）；到点就停，剩下的算没核清
        for (const it of [...evid, ...bots]) {
          if (Date.now() >= deadline) break;
          it.real = await realKeyOf(it.literal, rp, deadline);
        }
      })().catch(() => {}) : Promise.resolve();
      // 这条回复走 API 额度时，不读订阅的 5 小时／周数字（那是订阅的，和这条回复无关），额度行改写 API 说明。
      const apiRoute = isApiRouteRef(u?.resolvedRef);
      const [quota] = await Promise.all([apiRoute ? Promise.resolve({ status: 'api' }) : readQuota(), withDeadline(work, deadline)]);
      // 到点后才回来的解析结果不再改这张卡：出卡用的是此刻的快照
      const snapshot = items => items.map(it => ({ ...it }));
      const changeLine = `${cardText().changeLabel}${composeChangeLine(listState.status, snapshot(bots), snapshot(evid), [...resolved.roots])}`;
      if (r) {
        r.settled = true; r.settledAt = now(); r.lastCoverage = coverageOf(r);
        r.lastChange = { status: listState.status, listed: bots.length, evidence: evid.length, line: changeLine };
      }
      const C = cardText();
      const amount = w => !w ? C.quotaUnknown : w.resetPassed ? C.quotaResetPassed : C.quotaRemaining(w.remainingPercent);
      // Quota source off (the default: no CodexBar CLI / no credential profile): leave the quota line out entirely, neither an error nor "not available".
      const quotaOffNow = quota.reason === 'quota_source_off';
      const quotaLine = quotaOffNow ? null : apiRoute ? C.quotaApi : quota.status === 'cached'
        ? `${C.quotaLine(amount(quota.session), amount(quota.week), amount(quota.fable), SCOPED)}\n${C.sampleNote(quota.source === 'CodexBar CLI usage' ? C.sampleCli : C.sampleCache, measuredLabel(quota.measuredAt), Math.floor(quota.ageSeconds / 60), quota.refreshFailed)}`
        : C.quotaUnavailable;
      const embed = { description: [modelLineFrom(u), quotaLine, changeLine].filter(l => l !== null).join('\n'), color: 0x8b95a1, [CARD_MARK]: true };
      const discord = { ...(p.channelData?.discord ?? {}), embeds: [...(p.channelData?.discord?.embeds ?? []), embed] };
      // ③路线 a：只有 trailing 就绪才有这个设置；预计被拆成多条的长回复不挂框，登记"整条正文发完后补发一条只有框的消息"。
      // 登记用删完标记的正文（trailing-card.mjs 用登记正文和 message_sent.content 逐字配对）。登记失败就保留 E 的框。
      const tr = typeof trailing === 'function' ? trailing() : trailing;
      let trail = Boolean(tr) && !footerOnly && (body.length > (tr.maxChars ?? 1800) || body.split('\n').length > (tr.maxLines ?? 15));
      if (trail) trail = Boolean(tr.arm?.(event.runId, { body, card: embed, owner: { platform: 'discord', accountId: String(ctx.accountId ?? '').trim().toLowerCase(), destination: idOf(ctx.conversationId), sessionKey: ctx.sessionKey ?? event.sessionKey ?? null } }));
      const next = trail ? { ...p, text: body } : { ...p, text: body, channelData: { ...(p.channelData ?? {}), discord } };
      // 只发附件的页脚通知，或删完标记正文为空：发"空文字＋框"（沿用已上机验证的只发附件路径）。
      if (footerOnly || statusOnly || ((markerRemoved || edited) && !body.trim())) { delete next.isStatusNotice; next.text = ''; }
      return { payload: next };
    },
    // 丙＋丁兜底：message_sending 钩子，作用在发出前的最后一份文字上，不依赖 runId、isError、kind。
    //   丙：两句写死的系统英文整句匹配后换成中文（不拦掉）。
    //   丁兜底：整条文字只剩官方页脚／型号样式行（最多 2 行）、没有附件 → 取消。正常路径上这种载荷已在 reply_payload_sending 里按
    //   "这一轮之前有没有发过片段"分流处理；能走到这里说明那一步没拦到（没有 runId、不是 final 等），宁可不发。
    messageSending(event, ctx = {}) {
      const channel = ctx.channelId ?? event?.metadata?.channel;
      if (channel !== 'discord' || typeof event?.content !== 'string') return;
      const zh = translateSystemEnglish(event.content);
      if (zh !== null) {
// 查不到或失败才发中文。
        if (isUnconfirmedDeliveryNotice(event.content)) {
          const prev = [ctx.sessionKey, event?.to, ctx.conversationId].filter(Boolean).map(k => lastDelivery.get(k)).find(Boolean);
          if (prev?.success === true && now() - prev.at <= 15 * 60 * 1000) { logD9({ action: 'cancel-unconfirmed-notice', runId: ctx.runId ?? null, why: '上一条其实发成功了' }); return { cancel: true }; }
        }
        if (isEmptyReplyNotice(event.content)) {
          const rid = ctx.runId ?? event.runId ?? event?.metadata?.runId;
          if (rid && assistantSeen.get(rid)?.silentNoReply) { logD9({ action: 'cancel-empty-reply-notice', runId: rid, why: '这一轮本来就只有 NO_REPLY' }); return { cancel: true }; }
        }
        logD9({ action: 'translate-system-english', runId: ctx.runId ?? null, text: event.content.slice(0, 120) }); return { content: zh };
      }
      if (!(event?.metadata?.mediaUrls?.length) && isModelLinesOnly(event.content, null)) {
        logD9({ action: 'cancel-model-only-message', runId: ctx.runId ?? null, text: event.content.slice(0, 80) });
        return { cancel: true };
      }
    },
    // message_sent 只用来核“发送成功／失败”，并把消息编号记到对应片段上；不承担删正文。按去掉标记后的正文哈希配对（事件里常没有 runId）。
    sent(event, ctx = {}) {
// 记下每个会话最近一条消息的送达结果，“没法确认上一条是否送到”那句提示出现时用来核对。
      try { if (event?.success === true || event?.success === false) for (const k of [ctx.sessionKey, event.to, ctx.conversationId].filter(Boolean)) { lastDelivery.delete(k); lastDelivery.set(k, { success: event.success === true, at: now() }); while (lastDelivery.size > 200) lastDelivery.delete(lastDelivery.keys().next().value); } } catch { /* 只是记录 */ }
      if (typeof event?.content !== 'string' || !event.content.trim()) return;
      const h = hashText(event.content), runId = event.runId ?? ctx.runId;
      for (const key of runId ? [runId] : [...fragmentsByRun.keys()].reverse()) {
        const hit = fragmentsByRun.get(key)?.list.find(f => f.hash === h && f.sent === 'pending');
        if (hit) { hit.sent = event.success === true ? 'sent' : 'failed'; hit.messageId = event.messageId ?? ctx.messageId ?? null; return hit; }
      }
    },
    fragments: runId => (fragmentsByRun.get(runId)?.list ?? []).map(f => ({ ...f })),
// 这一轮明确写成功的文件（绝对路径）；小活兜底用它判断“这一轮动过文件”（命令行路径上原生写文件的工具调用走事件流，after_tool_call 钩子不一定看得到，附卡的修改栏一直靠这份证据）。
    writesOf: runId => { const r = reg.runs.get(runId); return r ? evidenceOf(r) : []; },
    // 诊断用（S7c）：这一轮记到了哪些工具——名字／类别／状态／来源／有没有写目标，只给名字不给内容。
    toolSummaryOf: runId => { const r = reg.runs.get(runId); return r ? [...r.tools.values()].slice(0, 20).map(t => `${t.name ?? '?'}/${t.cls ?? '?'}/${t.status ?? '?'}/${t.source ?? '?'}${t.target ? '/有目标' : ''}`) : null; },
    // 退役／换代：不再清共享表。只清本实例私有的东西；跨过断点（已开始、未结束）的运行记缺口。
    retire() {
      carded.clear(); replyMedia.clear();
      for (const r of reg.runs.values()) if (r.started && r.endedAt === null && !r.settled) r.gaps.add('recorder-retired');
    },
    assistantSeenSize: () => assistantSeen.size,
    // 只读视图：离线测试用（不含路径、命令、内容）
    peek: runId => reg.runs.get(runId) ?? null,
  };
}

// Native scoped registries may register hooks without starting a second copy of
// the global service. Share bounded telemetry only, never grants or sender state.
const recordCollectors = new Map();
// Role-scoped hook APIs can project different workspaces/config key order.
// Quota belongs to the same configured account source, not that projection.
const quotaSources = new Map();
// A scoped native registry can load a separate module generation. Module-local
// maps are not a transport for the host service's last successful sample.
// Use native plugin state for quota-only data; it carries no task authority.
export function quotaRows(value) {
  const window=w=>w&&({usedPercent:w.usedPercent,windowMinutes:w.windowMinutes,resetsAt:w.resetsAt});
  const scoped=value.fable?[{id:`claude-weekly-scoped-${SCOPED}`,window:window(value.fable)}]:[]; // the id carries the configured family, so the reader (SCOPED_RE) finds it again
  return [{provider:'claude',usage:{updatedAt:value.measuredAt,primary:window(value.session),secondary:window(value.week),extraRateWindows:scoped}}];
}
export async function publishCliQuota(store,key,value,assertCurrent=()=>{}) {
  if(!store||value.status!=='cached'||value.refreshFailed)return;
  const rows=quotaRows(value);
  for(let attempt=0;attempt<2;attempt++){
    assertCurrent();
    const observed=await store.observe(key);assertCurrent();
    const old=observed.value;
    if(old?.version===1&&old.sourceKey===key&&selectClaudeCliQuota(old.rows).status==='cached'&&Date.parse(old.rows[0].usage.updatedAt)>=Date.parse(value.measuredAt))return true;
    const result=await store.compareAndApply(key,observed.comparison,{operation:'update',action:'set',value:{version:1,sourceKey:key,rows}});assertCurrent();
    if(result.status!=='conflict')return true;
  }
  return false;
}
// 路线 a 的登记表和接线状态进程内共享（事件订阅、页脚钩子、message_sent 钩子可能来自不同的注册／模块代，和 assistantSeen 同理）。
const TRAILING_KEY = Symbol.for('personal-inbox.execution-record.trailing');
function sharedTrailing(api) {
  let t = globalThis[TRAILING_KEY];
  if (!t) {
    t = { api };
    t.card = createTrailingCard({
      loadSend: async () => (await import('openclaw/plugin-sdk/channel-outbound')).sendDurableMessageBatch,   // 动态导入：失败就记 disabled，长回复仍带 E 的框
      getCfg: () => t.api?.config ?? {},
      log: m => { try { t.api?.logger?.warn?.(m); } catch {} },
    });
    globalThis[TRAILING_KEY] = t;
  } else t.api = api;
  return t.card;
}
// 存档一行到 <资料>/运行记录/英文清理原文/<本地日期>.jsonl（只追加，不删不改）。
export function writeEnglishArchive(ziliaoRoot, row, nowMs = Date.now()) {
  const day = new Date(nowMs).toLocaleDateString('sv-SE', { timeZone: tzName() });
  const dir = join(ziliaoRoot, lexicon().layout.runLogs, lexicon().layout.runLogDirs.englishCleanupRaw);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(row)}\n`);
}
export function registerExecutionRecord(api,{makeCliQuotaSource=createCliQuotaSource,trailingCard}={}) {
  // The reply card is ON by default; set executionRecord.enabled to false to turn it off.
  const config = { ...(api.pluginConfig?.executionRecord ?? {}) };
  if (config.enabled === false) return;
  const workspaces = Object.fromEntries(Object.entries(api.config?.agents?.entries ?? {}).map(([id, entry]) => [id, entry.workspace]));
  const key = JSON.stringify([config, workspaces]);
  // 修改栏 D 的第二个监控根目录：和 index.mjs 同样的办法推出 syncRoot，再取它上一级的「资料」（P0 读回：/opt/solofleet-data）。
  const stateWorkspace = api.config?.agents?.entries?.main?.workspace;
  const ziliaoRoot = crew.paths.dataRoot || null;
  if (recordCollectors.size >= 4 && !recordCollectors.has(key)) recordCollectors.delete(recordCollectors.keys().next().value);
  const existing=recordCollectors.get(key);
  const quotaKey=JSON.stringify([config.quotaSource??'cli',config.credentialProfilePath]);
  let cliQuota;
  // Optional remaining-quota readout (CodexBar CLI): off unless a credential profile path is configured (or quotaSource is 'cache'); when off the card still shows model, route and changed files.
  const quotaOff=config.quotaSource==='off'||(config.quotaSource!=='cache'&&!config.credentialProfilePath);
  if(quotaOff){cliQuota={read:()=>({status:'unknown',reason:'quota_source_off'}),refresh:async()=>({status:'unknown',reason:'quota_source_off'})};}
  else if(config.quotaSource!=='cache'){
    cliQuota=quotaSources.get(quotaKey);
    if(!cliQuota){cliQuota=makeCliQuotaSource(config);quotaSources.set(quotaKey,cliQuota);}
  }
  const sourceKey=createHash('sha256').update(quotaKey).digest('hex');
  const storeOptions={namespace:'execution-record-cli-quota-v1',maxEntries:4};
  const quotaStore=cliQuota?api.runtime?.state?.openKeyedStoreV2?.(storeOptions):undefined;
  let sharedRead;
  const readShared=()=>{
    if(!quotaStore)return Promise.resolve(undefined);
    if(!sharedRead){
      const pending=quotaStore.lookup(sourceKey).catch(()=>undefined);
      sharedRead=pending;void pending.finally(()=>{if(sharedRead===pending)sharedRead=undefined;});
    }
    return sharedRead;
  };
  const card = trailingCard ?? sharedTrailing(api);
  void card.init();   // 幂等：就绪、导入失败过、正在导入都不重复做；服务停用后的重新注册会再试一次
// 英文清理原文存档目录 资料/运行记录/英文清理原文/日期.jsonl（本地日期；只追加；目录在 资料/.gitignore 范围内，不进 Git）。
  const archiveEnglish = ziliaoRoot ? (row) => writeEnglishArchive(ziliaoRoot, row) : null;
  const record = existing?.record ?? createExecutionRecord({
    archive: archiveEnglish,
    logger: row => { try { api.logger?.info?.(`execution-record cleanup: ${JSON.stringify(row)}`); } catch { /* 只是记录 */ } },
    trailing: () => card.isReady() ? { arm: (runId, armed) => card.arm(runId, armed) } : null,
    readQuota: async () => {
      let value=cliQuota?cliQuota.read():await readClaudeQuota(config);
      if(quotaStore){
        let timer;
        try{
          const row=await Promise.race([readShared(),new Promise(resolve=>{timer=setTimeout(resolve,150);})]);
          if(row?.version===1&&row.sourceKey===sourceKey){
            const shared=selectClaudeCliQuota(row.rows);
            if(shared.status==='cached'&&(value.status!=='cached'||Date.parse(shared.measuredAt)>Date.parse(value.measuredAt)))value=shared;
          }
        }catch{}finally{clearTimeout(timer);}
      }
      return value;
    },
    ziliaoRoot,
    workspaceFor(sessionKey, _runId, agentId) {
      const id = agentId ?? /^agent:([^:]+):/.exec(sessionKey ?? '')?.[1];
      return id ? workspaces[id] : null;
    },
  });
  recordCollectors.set(key, {record,cliQuota});
  let unsubscribe, probeOwner;
  // Native plugin instance/generation ownership guards these hooks. A service
  // start flag is not evidence that a valid scoped hook is current or retired.
  api.on('after_tool_call', (event, ctx) => record.afterTool(event, ctx), { registrationId: 'native-execution-record-tools' });
  api.on('before_tool_call', (event, ctx) => record.stripToolMarker(event, ctx), { registrationId: 'native-execution-record-message-marker', matcher: ['message', 'mcp__openclaw__message'] });
  api.on('reply_payload_sending', (event, ctx) => record.payload(event, ctx), { registrationId: 'native-execution-record-footer' });
  // D9：丙（两句系统英文换中文）＋丁兜底，放在新注册的 message_sending 钩子里
  api.on('message_sending', (event, ctx) => record.messageSending(event, ctx), { registrationId: 'native-execution-record-message-sending' });
  // 同一个 message_sent 钩子：先把发送结果记到本轮片段表上（只观察），再交给尾框补发逻辑。
  api.on('message_sent', (event, ctx) => { try { record.sent(event, ctx); } catch {} return card.onSent(event, ctx); }, { registrationId: 'native-execution-record-trailing' });
  // bot 自列名单：提前加载宿主公开的代码区域识别函数（openclaw/plugin-sdk/text-chunking）；没加载好的轮次走保守分支。
  void preloadCodeRegions();
  api.registerService({
    id: 'personal-inbox-execution-record',
    async start() {
      if (probeOwner) return;
      const owner = { controller: new AbortController() }; probeOwner = owner;
      const assertCurrent=()=>{if(probeOwner!==owner||owner.controller.signal.aborted)throw Error('Quota sampler retired');};
      const writer=quotaStore?api.runtime.state.openKeyedStoreV2(storeOptions,{assertCurrent}):undefined;
      const refresh=async()=>{
        const value=await cliQuota.refresh({signal:owner.controller.signal});
        if(writer&&value.status==='cached'&&owner.publishedAt!==value.measuredAt)try{if(await publishCliQuota(writer,sourceKey,value,assertCurrent))owner.publishedAt=value.measuredAt;}catch(error){if(probeOwner===owner)api.logger?.warn?.(`execution-record quota publication unavailable: ${error.name}`);}
        return value;
      };
      unsubscribe = api.runtime.events.onAgentEvent(event => {record.observe(event);if(cliQuota&&probeOwner===owner)owner.promise=refresh();});
      owner.promise = cliQuota?refresh():readClaudeQuota({ ...config, signal: owner.controller.signal, waitForOriginalRead: true });
      void owner.promise.then(value => {
        if (probeOwner !== owner) return;
        try { api.logger?.info?.(`execution-record quota sample: ${JSON.stringify({ status: value.status, source:value.source, reason: value.reason, measuredAt: value.measuredAt, profileMatched: value.profileMatched, session: value.session, week: value.week })}`); } catch {}
      });
    },
    async stop() {
      const owner = probeOwner, stop = unsubscribe; probeOwner = undefined; unsubscribe = undefined;
      const errors = [];
      try { card.disable('service-stop'); } catch {}   // 服务停用：清空补发登记，之后的轮次回到 E；重新注册会再试一次导入
      try { record.retire(); } catch {}   // 修改栏：跨过这个断点的运行记缺口（不清共享表）
      try { stop?.(); } catch (error) { errors.push(error); }
      try { owner?.controller.abort(); await owner?.promise; } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Execution record stop and cache read cleanup failed');
    },
  });
  return { record };
}
