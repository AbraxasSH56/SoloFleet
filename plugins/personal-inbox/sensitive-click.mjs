// Recognises clicks on submit/send/pay/buy/delete/install-type controls from the last screen reading and turns them into approval cards.
// 桌面角色点的这一下是不是“提交／发送／支付／购买／删除／安装”这一类——程序自己认。
// 做法：after_tool_call 里记下她最近“看屏幕”得到的界面元素表（elementRef → 角色、文字、位置），
// 等她点某个 elementRef（或某个坐标）时，反查这一格上写的字；命中词表就当作她刚记了“等确认”（由 desktop-lock.mjs 接线）。
// 元素表放在一个小状态文件里（几份插件拷贝共用，不能只放内存）；不存截图，不存输入框里的字（value）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crew } from './crew-config.mjs';
export const OBSERVATION_KEEP = 3; // 每个线程只留最近 3 次观察
export const OBSERVATION_TTL_MS = 30 * 60 * 1000; // 30 分钟过期
export const ENTER_WINDOW_MS = 60 * 1000; // Return／Enter 只看最近 60 秒的观察
const MAX_ELEMENTS_PER_OBSERVATION = 800;
const MAX_LABEL = 80;
const MAX_WINDOW_TITLE = 30; // 窗口标题只留前 30 字（隐私）
export const MAX_RESULT_TEXT = 8_000_000; // 结果里的 JSON 文本超过它就跳过并记日志（原来是 2MB）
// 退回甲：元素只有坐标、没有编号，且还没做“截图坐标↔元素表屏幕点”换算，所以按坐标反查默认**关闭**——
// 只剩按元素编号、菜单、回车键三条路能认；换算做好后再把它打开（classifyCall 的 coordinateLookup 参数）。
export const COORDINATE_LOOKUP_DEFAULT = false;

// 词表位置：官方会把插件复制到临时目录加载，路径不能从插件文件自己的位置推——正式用时由 desktop-lock.mjs 从锁文件位置拼出
// <项目根>/plugins/personal-inbox/sensitive-words.json 传进来（wordsPathFromLock）。这里的默认值只给离线测试用（和本文件同目录）。
const TEST_DEFAULT_WORDS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sensitive-words.json');
// NOTE: assumes the layout <projectRoot>/runtime/desktop/screen.lock (three folders up from the lock file). The plugin passes the exact path (options.wordsPath) itself; this guess only applies to ad-hoc use.
export const wordsPathFromLock = (lockPath) => (lockPath ? join(dirname(dirname(dirname(lockPath))), 'plugins', 'personal-inbox', 'sensitive-words.json') : null);

export function loadWords(path = TEST_DEFAULT_WORDS_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const norm = (w) => String(w).replace(/\s+/g, '').toLowerCase();
  return {
    words: [...new Set((raw.words ?? []).map(norm).filter(Boolean))],
    excludeWords: [...new Set((raw.excludeWords ?? []).map(norm).filter(Boolean))],
    roles: (raw.clickableRoles ?? []).map((r) => String(r).toLowerCase()),
  };
}

const normLabel = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

export function isClickableRole(role, cfg) {
  const r = String(role ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!r) return false;
  return cfg.roles.some((x) => r.includes(x.replace(/[\s_-]+/g, '')));
}

// 一格的文字是否命中词表（含排除词）。
export function labelHit(label, cfg) {
  const t = normLabel(label);
  if (!t) return null;
  if (cfg.excludeWords.some((x) => t.includes(x))) return null;
  return cfg.words.find((w) => t.includes(w)) ?? null;
}

// ───── 记界面 ─────
// 官方 computer 工具的结果里 observation.elements[]；插件钩子拿到的结果可能是原样、也可能套了一层（details／content 里的 JSON 文字），
// 这里几处都找，找不到就当“这次没有元素表”，不报错。
export function extractObservation(result, onSkip = null) {
  const seen = new Set();
  const visit = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 5 || seen.has(v)) return null;
    seen.add(v);
    if (v.observation && Array.isArray(v.observation.elements)) return v.observation;
    if (Array.isArray(v.elements) && v.elements.some((e) => e && typeof e === 'object' && ('elementRef' in e || 'label' in e))) return { observationId: v.observationId, elements: v.elements, window: v.window };
    for (const k of ['details', 'result', 'structuredContent', 'data']) { const o = visit(v[k], depth + 1); if (o) return o; }
    if (Array.isArray(v.content)) {
      for (const c of v.content) {
        // 超过上限的文本一律不解析（不管 "elements" 排在哪）；只有确实含 "elements" 才记一条跳过日志
        if (c && typeof c.text === 'string' && c.text.length >= MAX_RESULT_TEXT) { if (c.text.includes('"elements"')) { try { onSkip?.({ skipped: 'too-large', bytes: c.text.length }); } catch { /* 日志而已 */ } } continue; }
        if (c && typeof c.text === 'string' && /"elements"\s*:/.test(c.text)) {
          try { const o = visit(JSON.parse(c.text), depth + 1); if (o) return o; } catch { /* 不是 JSON 文字 */ }
        }
      }
    }
    return null;
  };
  return visit(result, 0);
}

const cleanBounds = (b) => {
  if (Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(Number(n)))) return b.map(Number);
  if (b && typeof b === 'object') {
    const x = Number(b.x ?? b.left), y = Number(b.y ?? b.top);
    const w = Number(b.width ?? b.w ?? (b.right != null ? b.right - x : NaN)), h = Number(b.height ?? b.h ?? (b.bottom != null ? b.bottom - y : NaN));
    if ([x, y, w, h].every(Number.isFinite)) return [x, y, w, h];
  }
  return null;
};

function readStore(path) {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); if (v && typeof v === 'object' && v.threads && typeof v.threads === 'object') return v; } catch { /* 没有或读不懂：当空 */ }
  return { version: 1, threads: {} };
}
function writeStore(path, v) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, path);
}

// 记一次观察。调用方负责放在现有短互斥保护里。返回记了几格（0＝这次没有元素表）。
export function recordObservation({ path, threadId, result, now = Date.now(), cfg = null, onSkip = null }) {
  if (!path || !threadId) return 0;
  const obs = extractObservation(result, onSkip);
  if (!obs) return 0;
  const elements = {};
  let n = 0, filteredOut = 0, truncated = 0;
  // 先按“能点的角色”筛，再截前 800 格（原来是先截再说，网页里按钮会被前面的文字节点挤掉）。
  // cfg 没收到（词表没读到）：跳过角色过滤，只截前 800 格，并且所有格的文字一律存空（隐私兜底，不退回存链接文字）。
  const all = obs.elements.filter((e) => e && typeof e === 'object');
  const pool = cfg?.roles ? all.filter((e) => isClickableRole(e.role, cfg)) : all;
  filteredOut = all.length - pool.length;
  truncated = Math.max(0, pool.length - MAX_ELEMENTS_PER_OBSERVATION);
  for (const e of pool.slice(0, MAX_ELEMENTS_PER_OBSERVATION)) {
    const ref = e.elementRef ?? e.ref ?? e.id;
    const rawLabel = String(e.label ?? e.name ?? e.title ?? '');
    // 只有命中词表的格才存文字（最多 80 字）；其余只存角色和位置。不存 value（输入框里的字）。
    const label = cfg && labelHit(rawLabel, cfg) ? rawLabel.slice(0, MAX_LABEL) : '';
    const role = String(e.role ?? '').slice(0, 40);
    const bounds = cleanBounds(e.bounds ?? e.frame ?? e.rect);
    if (ref == null && !bounds) continue;
    // 真机实测：官方读树结果里的元素只有 value／role／label／bounds{x,y,width,height}，**没有编号字段**，所以多半落到 b0… 这种自编键
    const key = ref != null ? String(ref) : `b${n}`;
    elements[key] = { role, label, bounds };
    n += 1;
  }
  const store = readStore(path);
  // 顺手清掉所有线程的过期观察
  for (const [tid, rec] of Object.entries(store.threads)) {
    rec.observations = (rec.observations ?? []).filter((o) => now - o.at <= OBSERVATION_TTL_MS);
    if (!rec.observations.length) delete store.threads[tid];
  }
  const rec = store.threads[threadId] ?? { observations: [], seq: 0 };
  rec.seq = (rec.seq ?? 0) + 1;
  const title = obs.window?.title ?? obs.windowTitle;
  rec.observations.push({ seq: rec.seq, observationId: obs.observationId != null ? String(obs.observationId) : null, at: now, window: title ? String(title).slice(0, MAX_WINDOW_TITLE) : null, filteredOut, truncated, elements });
  rec.observations = rec.observations.slice(-OBSERVATION_KEEP);
  store.threads[threadId] = rec;
  writeStore(path, store);
  return n;
}

// 旧观察作废：点击、滚动、打字、切窗等可能改变页面的动作放行之后，把该线程已有的观察标成“已作废”（只当认不出放行，不拿旧位置乱对）。
// 由 desktop-lock.mjs 的 after_tool_call 在“放行过、没出错、且不是只读动作”之后调用。返回被标记的个数。
export function invalidateObservations({ path, threadId, now = Date.now() }) {
  if (!path || !threadId || !existsSync(path)) return 0;
  const store = readStore(path);
  const rec = store.threads[threadId];
  if (!rec?.observations?.length) return 0;
  let n = 0;
  for (const o of rec.observations) if (!o.staleAt) { o.staleAt = now; n += 1; }
  if (n) writeStore(path, store);
  return n;
}

export function loadObservations({ path, threadId, now = Date.now() }) {
  if (!path || !threadId || !existsSync(path)) return [];
  const rec = readStore(path).threads[threadId];
  return (rec?.observations ?? []).filter((o) => now - o.at <= OBSERVATION_TTL_MS).map((o) => ({ ...o, stale: Boolean(o.staleAt) }));
}

// ───── 判点击 ─────
// 只读／不会提交的 browser 动作（其余没认出来的 browser 动作一律记“未识别”，免得悄悄漏掉）
const BROWSER_QUIET = new Set(['screenshot', 'zoom', 'list_apps', 'list_windows', 'get_accessibility_tree', 'get_window_state', 'get_cursor_position', 'get_browser_state', 'get_recording_state', 'wait', 'bring_to_front', 'snapshot', 'status', 'tabs', 'scroll', 'mouse_move']);
const ENTER_KEYS = new Set(['return', 'enter', 'kp_enter', 'numpadenter', 'keypadenter']);
const SUBMIT_MODS = new Set(['cmd', 'command', 'meta', 'super', 'ctrl', 'control']); // cmd+Return、ctrl+Enter 常是“发送”；shift／alt+Return 多是换行，不算
// 回车类按键：Return／Enter，或只带 cmd／ctrl 的组合；空格不算。
export function isEnterKey(raw) {
  const parts = norm(raw).replace(/\s+/g, '').split('+').filter(Boolean);
  if (!parts.length || !ENTER_KEYS.has(parts.at(-1))) return false;
  return parts.slice(0, -1).every((m) => SUBMIT_MODS.has(m));
}
const CLICK_ACTIONS = new Set(['left_click', 'double_click', 'triple_click', 'middle_click', 'left_mouse_up', 'browser_click', 'click']);
const norm = (s) => String(s ?? '').trim().toLowerCase();

const pointOf = (p) => {
  const x = p.x ?? p.coordinate?.[0] ?? p.position?.x, y = p.y ?? p.coordinate?.[1] ?? p.position?.y;
  return Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x != null && y != null ? [Number(x), Number(y)] : null;
};
const contains = (b, [px, py]) => px >= b[0] && px <= b[0] + b[2] && py >= b[1] && py <= b[1] + b[3];

function findElement(observations, p, coordinateLookup = COORDINATE_LOOKUP_DEFAULT) {
  const ref = p.elementRef ?? p.ref ?? p.element;
  const fresh = observations.filter((o) => !o.stale); // 已作废的观察不用来对任何东西
  const newestFirst = [...fresh].reverse();
  if (ref != null) {
    const wantObs = p.observationId != null ? String(p.observationId) : null;
    for (const o of newestFirst) {
      if (wantObs && o.observationId && o.observationId !== wantObs) continue;
      const el = o.elements[String(ref)];
      if (el) return { el, obs: o };
    }
    return null;
  }
  if (!coordinateLookup) return null; // 坐标反查关闭：一律当“认不出”放行并记日志
  const pt = pointOf(p);
  if (!pt) return null;
  // 坐标：只看最近一次（未作废的）观察，找包含该点的最小的一格
  const o = newestFirst[0];
  if (!o) return null;
  let best = null, bestArea = Infinity;
  for (const el of Object.values(o.elements)) {
    if (!el.bounds || !contains(el.bounds, pt)) continue;
    const area = el.bounds[2] * el.bounds[3];
    if (area < bestArea) { best = el; bestArea = area; }
  }
  return best ? { el: best, obs: o } : null;
}

const shorten = (s, n = 40) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

// 返回 { hit:boolean, always?:boolean, unrecognized?:boolean, word?, label?, what?, window? }
//   hit：该卡；unrecognized：普通点击认不出（没观察记录、坐标不在任何一格）——放行并记日志。
export function classifyCall({ toolName, params, observations = [], cfg, now = Date.now(), coordinateLookup = COORDINATE_LOOKUP_DEFAULT }) {
  const p = params && typeof params === 'object' ? params : {};
  const action = norm(p.action);
  // browser 工具的参数形状还没读过：没有 action 字段就记“未识别”（放行但写日志），免得悄悄漏掉
  if (!action) return String(toolName ?? '').toLowerCase() === 'browser' ? { hit: false, unrecognized: true } : { hit: false };
  const isBrowser = String(toolName ?? '').toLowerCase() === 'browser';
  // 一律要卡：上传文件、点掉“确定要……吗”的确认框
  if (action === 'browser_set_input_files') return { hit: true, always: true, via: 'upload', word: '上传文件', what: '（程序认出）选择要上传的文件' };
  if (action === 'browser_dialog') {
    const accept = p.accept === true || ['accept', 'decision', 'response', 'dialogAction', 'mode', 'result'].some((k) => /^(accept|ok|yes|confirm|true)$/i.test(String(p[k] ?? '')));
    if (accept) return { hit: true, always: true, via: 'dialog', word: '确认框', what: '（程序认出）在网页弹出的确认框里点“确定”' };
    return { hit: false };
  }
  if (CLICK_ACTIONS.has(action)) {
    const found = findElement(observations, p, coordinateLookup);
    if (!found) return { hit: false, unrecognized: true };
    const { el, obs } = found;
    if (!isClickableRole(el.role, cfg)) return { hit: false };
    const word = labelHit(el.label, cfg);
    if (!word) return { hit: false };
    return { hit: true, via: 'click', word, label: el.label, window: obs.window ?? null, what: `（程序认出）点击「${shorten(el.label)}」${el.role ? `（${shorten(el.role, 12)}）` : ''}${obs.window ? `，窗口《${shorten(obs.window, 30)}》` : ''}` };
  }
  if (action === 'invoke_menu') {
    const path = Array.isArray(p.path) ? p.path : [];
    const last = String(path.at(-1) ?? '');
    const word = labelHit(last, cfg);
    return word ? { hit: true, via: 'menu', word, label: last, what: `（程序认出）选择菜单「${shorten(path.join(' ▸ '), 50)}」` } : { hit: false };
  }
  // 回车类：key 的 Return／Enter（含 cmd／ctrl 组合）、browser 的按键动作、type／browser_type 的文字以换行结尾或带 submit
  const keyed = action === 'key' || (isBrowser && /^browser_(press_key|key|press)$/.test(action));
  const typed = action === 'type' || (isBrowser && /^browser_type$/.test(action));
  const enterLike = (keyed && isEnterKey(p.keys ?? p.text ?? p.key)) || (typed && (/[\r\n]\s*$/.test(String(p.text ?? p.value ?? '')) || p.submit === true));
  if (enterLike) {
    const recent = observations.filter((o) => now - o.at <= ENTER_WINDOW_MS);
    for (const o of [...recent].reverse()) {
      for (const el of Object.values(o.elements)) {
        if (isClickableRole(el.role, cfg) && labelHit(el.label, cfg)) {
          return { hit: true, via: 'enter', word: labelHit(el.label, cfg), label: el.label, window: o.window ?? null, what: `（程序认出）按回车键（或带换行的输入）；屏幕上有「${shorten(el.label)}」按钮，可能就是在点它${o.window ? `，窗口《${shorten(o.window, 30)}》` : ''}` };
        }
      }
    }
    return { hit: false };
  }
  if (isBrowser && !BROWSER_QUIET.has(action) && !CLICK_ACTIONS.has(action) && !['invoke_menu', 'key', 'type', 'browser_dialog', 'browser_set_input_files'].includes(action)) return { hit: false, unrecognized: true };
  return { hit: false };
}

export const PROGRAM_NOTE = '这一项是程序认出来的，不是桌面角色自己报的。';

// 只描述结构（键名和类型），不带任何值：用来在真机上抓一次 after_tool_call 里 result 的真实形状。
export const SHAPE_MAX_DEPTH = 7; // 只读形状诊断把深度从 4 提到 7，才看得到 elements[0] 里面的键名
export function shapeOf(v, depth = 0, maxDepth = SHAPE_MAX_DEPTH) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > maxDepth ? 'array' : [`array(${v.length})`, v.length ? shapeOf(v[0], depth + 1, maxDepth) : null];
  if (typeof v === 'object') {
    if (depth > maxDepth) return 'object';
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[k] = shapeOf(v[k], depth + 1, maxDepth);
    return o;
  }
  return typeof v;
}

// 找 result 里最像"界面元素表"的数组（键名叫 elements），只读，不动 result。
function findElementsHolder(v, depth = 0, seen = new Set()) {
  if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return null;
  seen.add(v);
  if (Array.isArray(v.elements)) return v;
  for (const k of Object.keys(v)) { const r = findElementsHolder(v[k], depth + 1, seen); if (r) return r; }
  return null;
}

// 只读形状诊断（只在 capture-shape.flag 存在时被 desktop-lock.mjs 调用）：只记键名、类型、个数、字节数、耗时数值；
// **不记任何页面里的字符串值**（shapeOf 对字符串只记 "string"）；只有动作名（action，最多 40 字）会原样记，它不是页面内容。不改变 recordObservation／闸门的任何行为。
export function describeDiagnostics(event, { tool, now = Date.now() } = {}) {
  const result = event?.result;
  let resultBytes = null;
  try { resultBytes = JSON.stringify(result)?.length ?? null; } catch { /* 太大或有环：不记 */ }
  const holder = findElementsHolder(result);
  const first = holder?.elements?.[0];
  const typeOfVal = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  const out = {
    at: now, tool, action: String(event?.params?.action ?? '').slice(0, 40), paramKeys: Object.keys(event?.params ?? {}),
    resultBytes, durationMs: typeof event?.durationMs === 'number' ? event.durationMs : (typeof event?.elapsedMs === 'number' ? event.elapsedMs : null),
    eventKeys: Object.keys(event ?? {}).slice(0, 30),
    shape: shapeOf(result),
  };
  if (holder) {
    out.elements = {
      length: holder.elements.length,
      totalElementCount: typeof holder.totalElementCount === 'number' ? holder.totalElementCount : null,
      firstKeys: first && typeof first === 'object' ? Object.fromEntries(Object.keys(first).slice(0, 40).map((k) => [k, typeOfVal(first[k])])) : null,
    };
  }
  return out;
}
