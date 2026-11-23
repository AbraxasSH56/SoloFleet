// Core logic for project folders, task records, result registration and the daily file reconciliation.
// 项目文件夹、任务记录、成果登记和每天对账的核心逻辑。
// 原则：
//   · 程序管"必须发生的事"（一次建对、对账），不拦任何 bot 的写入，不改任何工具权限。
//   · 只用 Node 自带库；不调模型、不碰网络、不发消息。
//   · 所有路径由调用方显式传进来（dataRoot、indexPath）。这个文件里**不许**用 import.meta.url 去推资料根：
//     官方会把插件复制到临时目录里加载，按自己位置推路径线上必找不到（index.mjs 里有同样的注释）。
//   · 写文件一律"先写临时文件再换名"，写完读回核对；任何一步不对就整条停下，不留半截，也不删除任何已有文件。
import { tzName } from './tz.mjs';
import { lexicon, locale, labelRe, labelText, escapeRe, colon } from './lexicon.mjs';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';

// Words and folder names follow config "locale" (lexicon.mjs); zh-CN gives exactly the literals this file always used.
const W = lexicon();
const LY = W.layout;
export const PLACEHOLDER = W.placeholderCell;
const PLACEHOLDER_CELLS = new Set(W.placeholderCells);
export const SUBDIRS = [LY.tasks, LY.outputs, LY.history];
export const NOTE_START = W.noteStart;
export const NOTE_END = W.noteEnd;
const FORBIDDEN_CHARS = /[\/\\:*?"<>|\s]/u; // 空白（含全角空格）也不许
const FORBIDDEN_REPLACE = /[\/\\:*?"<>|\s]+/gu;
const SHA = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

// ---------- 小工具 ----------
export function localDay(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function localDayTime(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const fail = (message, extra = {}) => ({ ok: false, message, ...extra });
const cellSafe = (s) => String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '｜').trim();

export function stripTemplateNotes(text) {
  // 去掉成对标记之间的"模板说明"（含标记行本身）；标记不成对就原样不动，由调用方检查
  let out = text;
  for (;;) {
    const a = out.indexOf(NOTE_START);
    if (a < 0) break;
    const b = out.indexOf(NOTE_END, a);
    if (b < 0) break;
    let end = b + NOTE_END.length;
    if (out[end] === '\n') end += 1;
    out = out.slice(0, a) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, '\n\n');
}
function fillTokens(text, tokens) {
  let out = text;
  for (const [k, v] of Object.entries(tokens)) out = out.split(`{{${k}}}`).join(v);
  return out;
}
function leftoverTokens(text) { return [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])]; }

export function atomicWrite(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: mode ?? 0o644 });
  if (existsSync(path)) { try { chmodSync(tmp, statSync(path).mode & 0o777); } catch { /* 保留不了权限也继续 */ } }
  renameSync(tmp, path);
}
function writeNew(path, text) {
  // 只在文件不存在时写（'wx'），避免覆盖
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o644);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}
const readText = (p) => readFileSync(p, 'utf8');
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const listDir = (p) => { try { return readdirSync(p).filter((n) => n !== '.DS_Store'); } catch { return []; } };

// ---------- 名字检查 ----------
export function validateName(name) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, reason: '名字是空的', suggestion: null };
  if (n.length > 60) return { ok: false, reason: '名字太长（最多 60 个字）', suggestion: n.slice(0, 60) };
  const problems = [];
  if (FORBIDDEN_CHARS.test(n)) problems.push('含空格或 / \\ : * ? " < > | 这类符号');
  if (n.includes('__')) problems.push('含双下划线');
  if (/^[_.]/.test(n)) problems.push('开头是下划线或点');
  if (n === '.' || n === '..') problems.push('不能是 . 或 ..');
  if (problems.length === 0) return { ok: true, name: n };
  let sug = n.replace(FORBIDDEN_REPLACE, '').replace(/_{2,}/g, '_').replace(/^[_.]+/, '');
  if (!sug) sug = null;
  return { ok: false, reason: problems.join('；'), suggestion: sug };
}
export function sanitizeTitle(title) {
  const t = String(title ?? '').trim();
  const s = t.replace(FORBIDDEN_REPLACE, '-').replace(/-{2,}/g, '-').replace(/^[-_.]+|[-]+$/g, '');
  const clipped = Array.from(s).slice(0, 80).join('');
  return { name: clipped, changed: clipped !== t };
}

// ---------- 日期 ----------
// 认 2026-11-22 和 20261122（8 位）；后面带时间也行；只取日期，不比较时分
export function dayOf(text) {
  const s = String(text ?? '');
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) m = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// ---------- 总索引 ----------
function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
// 解析 INDEX.md 的项目表：第一个第一格是"项目"的表；表头下的分隔行之后到第一个不以 | 开头的行之前，每行一个项目。
export function parseIndex(text) {
  const lines = String(text).split('\n');
  let head = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('|') && splitCells(lines[i])[0] === W.indexProjectHeader) { head = i; break; }
  }
  if (head < 0) return { ok: false, message: `总索引里找不到项目表（第一格写"${W.indexProjectHeader}"的表）`, rows: [], lines };
  const sepIdx = head + 1;
  if (!lines[sepIdx] || !/^\s*\|[\s:|-]+\|?\s*$/.test(lines[sepIdx])) return { ok: false, message: '项目表表头下面不是分隔行', rows: [], lines };
  const rows = [];
  let last = sepIdx;
  for (let i = sepIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) break;
    last = i;
    const c = splitCells(lines[i]);
    const idm = new RegExp(`${locale() === 'en' ? '(?<![A-Za-z])' : ''}${escapeRe(W.idLabel)}\\s*(\\d{15,})`).exec(c[1] ?? '');
    const lm = /\]\(([^)\s]+)\)/.exec(c[3] ?? '');
    let entryPath = null;
    if (lm) { try { entryPath = decodeURIComponent(lm[1]); } catch { entryPath = lm[1]; } }
    // 总索引里的项目名是给人看的（可能有空格），文件夹以入口链接里的为准
    const fm = entryPath ? new RegExp(`^${escapeRe(LY.projects)}\\/([^/]+)\\/`).exec(entryPath) : null;
    rows.push({ lineNo: i, name: c[0] ?? '', folder: fm ? fm[1] : (c[0] ?? ''), channelId: idm ? idm[1] : null, entryPath, cells: c });
  }
  return { ok: true, rows, lines, headIdx: head, lastRowIdx: last };
}
export function readIndex(indexPath) {
  if (!indexPath || !isFile(indexPath)) return { ok: false, message: `总索引读不到：${indexPath ?? '（没给路径）'}` };
  const text = readText(indexPath);
  const p = parseIndex(text);
  return { ...p, text };
}
export function findProjectByChannel({ dataRoot, indexPath, channelId }) {
  if (!dataRoot || !indexPath || !channelId) return null;
  const idx = readIndex(indexPath);
  if (!idx.ok) return null;
  const hits = idx.rows.filter((r) => r.channelId === String(channelId));
  if (hits.length !== 1) return null;
  const r = hits[0];
  return { name: r.folder, displayName: r.name, entryPath: r.entryPath ? resolve(dataRoot, r.entryPath) : null };
}
// 判断 a 是不是 b 的子序列（b 中按顺序包含 a 的全部行）
function isSubsequence(a, b) {
  let j = 0;
  for (let i = 0; i < b.length && j < a.length; i += 1) if (b[i] === a[j]) j += 1;
  return j === a.length;
}
// 在项目表末尾插入一行：读 → 比对指纹 → 换名写入 → 读回核对"原来每一行没变、只多了这一行"。变了就重来（最多 3 次）。
export function appendIndexRow(indexPath, row, { onBeforeWrite = null } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const idx = readIndex(indexPath);
    if (!idx.ok) return fail(idx.message);
    const sha0 = SHA(idx.text);
    const lines = [...idx.lines];
    lines.splice(idx.lastRowIdx + 1, 0, row);
    const next = lines.join('\n');
    if (typeof onBeforeWrite === 'function') onBeforeWrite(attempt);
    const again = readText(indexPath);
    if (SHA(again) !== sha0) continue; // 写之前被别人改了，重读重来
    atomicWrite(indexPath, next);
    const back = readText(indexPath);
    const backLines = back.split('\n');
    if (back === next) return { ok: true, attempts: attempt, lineNo: idx.lastRowIdx + 1 };
    // 写完这一瞬间别人又改了：只要原来的每一行还在、我的行也在，就算成功；否则报错
    if (backLines.includes(row) && isSubsequence(idx.lines, backLines)) return { ok: true, attempts: attempt, lineNo: backLines.indexOf(row), note: '写完时有别人同时改了文件，已核对原有各行都在' };
    return fail('写完读回发现总索引和预期不一致，请手工核对 INDEX.md（命令没有删除任何东西）', { attempts: attempt });
  }
  return fail('总索引在 3 次尝试里都被别人同时改动，没有写入；请稍后重试');
}

// ---------- new-project ----------
export function newProject({ dataRoot, indexPath, name, channelId, channelName, lead, goal, now = Date.now() }) {
  if (!dataRoot || !indexPath) return fail('没有给资料根或总索引路径');
  const v = validateName(name);
  if (!v.ok) return fail(`项目名不合规：${v.reason}${v.suggestion ? `；建议改成：${v.suggestion}` : ''}`, { code: 'bad-name' });
  if (!/^\d{15,}$/.test(String(channelId ?? ''))) return fail('频道编号要是 15 位以上的数字', { code: 'bad-channel-id' });
  for (const [k, val] of [['频道名', channelName], ['主责 bot', lead], ['一句话目标', goal]]) if (!String(val ?? '').trim()) return fail(`缺少${k}`, { code: 'missing-arg' });
  const idx = readIndex(indexPath);
  if (!idx.ok) return fail(idx.message);
  const nm = v.name;
  const dir = join(dataRoot, LY.projects, nm);
  const entry = join(dir, 'PROJECT.md');
  const sameChannel = idx.rows.filter((r) => r.channelId === String(channelId));
  const sameName = idx.rows.filter((r) => r.name === nm || r.folder === nm);
  if (sameChannel.length > 1) return fail(`总索引里有 ${sameChannel.length} 行用了同一个频道编号 ${channelId}，请先手工理清`, { code: 'dup-channel' });
  if (sameChannel.length === 1 && sameChannel[0].name !== nm && sameChannel[0].folder !== nm) return fail(`这个频道编号已经登记给了项目《${sameChannel[0].name}》，不重复建`, { code: 'channel-taken' });
  if (sameName.length > 0 && !(sameChannel.length === 1 && (sameChannel[0].name === nm || sameChannel[0].folder === nm))) return fail(`总索引里已有项目《${nm}》，但频道编号不是 ${channelId}，不重复建`, { code: 'name-taken' });
  if (sameChannel.length === 1) {
    return { ok: true, existed: true, message: `项目《${nm}》已经建好并登记，没有重建`, project: nm, path: dir, entry };
  }
  const folderExists = isDir(dir);
  const entryExists = isFile(entry);
  if (folderExists && !entryExists) return fail(`文件夹 ${dir} 已存在但里面没有 PROJECT.md，不覆盖；请换个项目名或手工处理`, { code: 'folder-no-entry' });
  const created = [];
  if (!folderExists || !entryExists) {
    const tplPath = join(dataRoot, LY.templates, LY.projectEntryTemplate);
    if (!isFile(tplPath)) return fail(`模板读不到：${tplPath}`);
    let tpl = readText(tplPath);
    if ((tpl.includes(NOTE_START) ? 1 : 0) !== (tpl.includes(NOTE_END) ? 1 : 0)) return fail('项目入口模板里的"模板说明"标记不成对');
    tpl = stripTemplateNotes(tpl);
    const PE = W.placeholders.projectEntry;
    if (!tpl.includes(`{{${PE.projectName}}}`)) return fail(`项目入口模板还是旧格式（没有 {{${PE.projectName}}} 占位符），请先更新模板`);
    const filled = fillTokens(tpl, {
      [PE.projectName]: nm,
      [PE.goal]: cellSafe(goal),
      [PE.channel]: W.channelCell(cellSafe(channelName), channelId),
      [PE.leadBot]: cellSafe(lead),
      [PE.date]: localDay(now),
    });
    const left = leftoverTokens(filled);
    if (left.length) return fail(`模板里有没填的占位符：${left.join('、')}`);
    mkdirSync(dir, { recursive: true });
    for (const s of SUBDIRS) mkdirSync(join(dir, s), { recursive: true });
    try { writeNew(entry, filled); created.push('PROJECT.md'); } catch (e) { return fail(`PROJECT.md 没写成：${e.message}`); }
    created.push(...SUBDIRS.map((s) => `${s}/`));
  } else {
    for (const s of SUBDIRS) if (!isDir(join(dir, s))) { mkdirSync(join(dir, s), { recursive: true }); created.push(`${s}/`); }
  }
  const row = `| ${cellSafe(nm)} | ${W.channelCell(cellSafe(channelName), channelId)} | ${cellSafe(lead)} | [${W.projectEntryLinkText}](${LY.projects}/${nm}/PROJECT.md) | ${W.indexLocationsCell(nm)} |`;
  const r = appendIndexRow(indexPath, row);
  if (!r.ok) return fail(`文件夹和入口已建好，但总索引没登记成功：${r.message}。重跑同一条命令会补登（不会重建）`, { code: 'index-failed', created, path: dir });
  return { ok: true, existed: false, message: `已建项目《${nm}》：文件夹、入口、总索引一行都好了`, project: nm, path: dir, entry, created, indexLine: r.lineNo + 1, indexAttempts: r.attempts };
}

// ---------- new-task ----------
export function newTask({ dataRoot, project, title, threadLink, executor, quote, quoteDate, cardId, goal, now = Date.now() }) {
  if (!dataRoot) return fail('没有给资料根');
  const v = validateName(project);
  if (!v.ok) return fail(`项目名不合规：${v.reason}`);
  const dir = join(dataRoot, LY.projects, v.name);
  if (!isFile(join(dir, 'PROJECT.md'))) return fail(`项目《${v.name}》还不存在（没有 ${join(dir, 'PROJECT.md')}）。新项目请总控先用 new-project 建；这里不凭空造项目文件夹`, { code: 'no-project' });
  for (const [k, val] of [['任务标题', title], ['线程链接', threadLink], ['执行者', executor], ['主人原话', quote]]) if (!String(val ?? '').trim()) return fail(`缺少${k}`, { code: 'missing-arg' });
  const s = sanitizeTitle(title);
  if (!s.name) return fail('任务标题处理后是空的，请换个标题');
  const tplPath = join(dataRoot, LY.templates, LY.taskRecordTemplate);
  if (!isFile(tplPath)) return fail(`模板读不到：${tplPath}`);
  let tpl = readText(tplPath);
  const a = tpl.split(NOTE_START).length - 1; const b = tpl.split(NOTE_END).length - 1;
  if (a !== b) return fail('任务记录模板里的"模板说明"标记不成对');
  tpl = stripTemplateNotes(tpl);
  const PT = W.placeholders.taskRecord;
  if (!tpl.includes(`{{${PT.taskTitle}}}`)) return fail(`任务记录模板还是旧格式（没有 {{${PT.taskTitle}}} 占位符），请先更新模板`);
  const when = localDayTime(now);
  const day = String(quoteDate ?? '').trim() || localDay(now);
  const q = String(quote).trim();
  const quoteBlock = q.split('\n').map((l) => `> ${l}`).join('\n');
  const filled = fillTokens(tpl, {
    [PT.taskTitle]: String(title).trim(),
    [PT.projectName]: v.name,
    [PT.goal]: String(goal ?? '').trim() || W.defaultGoalHint,
    [PT.quote]: `${day}${colon()}\n${quoteBlock}`,
    [PT.datetime]: when,
    [PT.executor]: cellSafe(executor),
    [PT.cardId]: String(cardId ?? '').trim() || W.placeholderNone,
    [PT.threadLink]: String(threadLink).trim(),
  });
  const left = leftoverTokens(filled);
  if (left.length) return fail(`模板里有没填的占位符：${left.join('、')}`);
  const file = join(dir, LY.tasks, `${s.name}.md`);
  if (isFile(file)) return { ok: true, existed: true, message: `任务记录已经存在，没有覆盖，请继续用它：${file}`, path: file, file: `${s.name}.md`, renamed: s.changed };
  try { writeNew(file, filled); } catch (e) { return fail(`任务记录没写成：${e.message}`); }
  return { ok: true, existed: false, message: `已建任务记录：${file}${s.changed ? `（标题里的特殊符号已换成短横线，实际文件名是 ${s.name}.md）` : ''}`, path: file, file: `${s.name}.md`, renamed: s.changed };
}

// ---------- PROJECT.md 区块工具 ----------
function sectionRange(lines, title) {
  const h = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (h < 0) return null;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i += 1) if (/^##\s/.test(lines[i])) { end = i; break; }
  return { head: h, start: h + 1, end };
}
function tableIn(lines, range) {
  let head = -1;
  for (let i = range.start; i < range.end; i += 1) if (lines[i].trim().startsWith('|')) { head = i; break; }
  if (head < 0) return null;
  const sepIdx = head + 1;
  if (sepIdx >= range.end || !/^\s*\|[\s:|-]+\|?\s*$/.test(lines[sepIdx])) return null;
  let last = sepIdx;
  const rows = [];
  for (let i = sepIdx + 1; i < range.end; i += 1) {
    if (!lines[i].trim().startsWith('|')) break;
    rows.push({ idx: i, cells: splitCells(lines[i]) });
    last = i;
  }
  return { head, sepIdx, rows, last };
}
const isPlaceholderRow = (cells) => [cells[0], cells[1]].some((c) => PLACEHOLDER_CELLS.has(String(c ?? '').trim()));

// ---------- add-result ----------
export function addResult({ dataRoot, project, name, path, outside, note, now = Date.now() }) {
  if (!dataRoot) return fail('没有给资料根');
  const v = validateName(project);
  if (!v.ok) return fail(`项目名不合规：${v.reason}`);
  const dir = join(dataRoot, LY.projects, v.name);
  const entry = join(dir, 'PROJECT.md');
  if (!isFile(entry)) return fail(`项目《${v.name}》的入口不存在：${entry}`, { code: 'no-project' });
  if (!String(name ?? '').trim()) return fail('缺少成果名');
  if (!String(note ?? '').trim()) return fail('缺少一句话说明（--note）');
  if (Boolean(path) === Boolean(outside)) return fail('--path 和 --outside 要二选一（成果在项目文件夹里用 --path，不在就用 --outside）', { code: 'path-or-outside' });
  let position;
  if (path) {
    const rel = String(path).trim();
    if (rel.startsWith('/') || rel.split('/').includes('..')) return fail('--path 要写相对项目文件夹的路径（如 ${LY.outputs}/xxx.md），不能以 / 开头，也不能含 ..', { code: 'bad-path' });
    const abs = resolve(dir, rel);
    if (!abs.startsWith(dir + sep)) return fail('--path 指到了项目文件夹外面', { code: 'bad-path' });
    if (!isFile(abs)) return fail(`成果文件不存在：${abs}。先把文件放进项目文件夹再登记；成果不在项目里就改用 --outside`, { code: 'no-file' });
    position = `\`${rel}\``;
  } else {
    position = cellSafe(outside);
    if (!position) return fail('--outside 的说明是空的');
  }
  const text0 = readText(entry);
  const sha0 = SHA(text0);
  const lines = text0.split('\n');
  const resSec = sectionRange(lines, W.sectionResults);
  if (!resSec) return fail(`入口里找不到"## ${W.sectionResults}"一节，没有改动；请手工登记`, { code: 'no-section' });
  const tbl = tableIn(lines, resSec);
  if (!tbl) return fail(`"${W.sectionResults}"一节里找不到表格，没有改动；请手工登记`, { code: 'no-table' });
  const nm = cellSafe(name);
  const newRow = `| ${nm} | ${position} | ${cellSafe(note)} |`;
  // 先找同名成果行（再次登记同一成果就更新它），再找整格是占位写法的行，都没有就追加
  let target = tbl.rows.find((r) => r.cells[0] === nm);
  if (!target) target = tbl.rows.find((r) => isPlaceholderRow(r.cells));
  let replaced = null;
  if (target) { replaced = lines[target.idx]; lines[target.idx] = newRow; } else lines.splice(tbl.last + 1, 0, newRow);
  // 当前状态：只有一行就换掉；有多行就在最前面插一行日期句，别的不动
  const stSec = sectionRange(lines, W.sectionCurrentStatus);
  const statusLine = W.resultStatusLine(localDay(now), nm);
  let statusMode = 'none';
  if (stSec) {
    const idxs = [];
    for (let i = stSec.start; i < stSec.end; i += 1) if (lines[i].trim() !== '') idxs.push(i);
    if (idxs.length <= 1) {
      if (idxs.length === 1) lines[idxs[0]] = statusLine; else lines.splice(stSec.start, 0, '', statusLine);
      statusMode = 'replaced';
    } else {
      lines.splice(idxs[0], 0, statusLine, '');
      statusMode = 'inserted';
    }
  }
  const next = lines.join('\n');
  if (SHA(readText(entry)) !== sha0) return fail('入口刚被别人改动，没有写入，请重试', { code: 'changed' });
  atomicWrite(entry, next);
  if (readText(entry) !== next) return fail('写完读回和预期不一致，请手工核对入口（命令没有删除任何东西）');
  return { ok: true, message: `已登记成果《${nm}》到项目《${v.name}》的入口${stSec ? `，并更新了"${W.sectionCurrentStatus}"` : `（入口里没有"${W.sectionCurrentStatus}"一节，状态未改）`}`, project: v.name, entry, replacedPlaceholder: replaced, statusMode };
}

// ---------- check-project ----------
const taskDoneDates = (dir) => {
  const out = [];
  for (const f of listDir(join(dir, LY.tasks))) {
    if (!f.endsWith('.md')) continue;
    let t = '';
    try { t = readText(join(dir, LY.tasks, f)); } catch { continue; }
    const m = new RegExp(`${labelRe(W.statusLabel)}${escapeRe(W.statusHeads[0])}[^\\n]*`).exec(t);
    if (m) { const d = dayOf(m[0]); if (d) out.push({ file: f, day: d }); }
  }
  return out;
};
// 返回 { skipped } 或 { problems:[{code, where, message, suggest}] }
export function checkProject({ dataRoot, indexPath, name }) {
  if (!dataRoot || !indexPath) return { skipped: true, reason: '没给资料根或总索引路径，不检查' };
  const dir = join(dataRoot, LY.projects, name);
  const problems = [];
  const P = (code, where, message, suggest) => problems.push({ code, where, message, suggest });
  if (!isDir(dir)) { P('no-folder', `${LY.projects}/${name}`, '总索引里有这个项目，但项目文件夹不存在', '用 new-project 补建，或手工建好文件夹'); return { problems }; }
  const entry = join(dir, 'PROJECT.md');
  for (const s of SUBDIRS) if (!isDir(join(dir, s))) P('missing-subdir', `${LY.projects}/${name}/${s}/`, `缺少子文件夹 ${s}/`, `建一个空的 ${s}/ 文件夹`);
  if (!isFile(entry)) { P('no-entry', `${LY.projects}/${name}/PROJECT.md`, '没有项目入口 PROJECT.md', '按模板补一份入口'); return { problems }; }
  const text = readText(entry);
  const lines = text.split('\n');
  const resSec = sectionRange(lines, W.sectionResults);
  // ① 成果表还有"待写"
  if (resSec) {
    const seg = lines.slice(resSec.start, resSec.end).join('\n');
    if (seg.includes(W.placeholderFragment)) P('entry-placeholder', `${LY.projects}/${name}/PROJECT.md`, `"${W.sectionResults}"表里还写着"${W.placeholderFragment}"`, '成果做完后用 add-result 登记；任务根本没有成果就把这一行改成实际情况');
  }
  // ② 成果/ 顶层文件没出现在入口里
  for (const f of listDir(join(dir, LY.outputs))) {
    if (f.startsWith('.')) continue;
    if (!isFile(join(dir, LY.outputs, f))) continue;
    if (DIARY_OK.test(f)) continue; // 每日日记（日记_YYYYMMDD.md 及其补跑副本）入口里只写样式，不逐个登记
    if (!text.includes(f)) P('result-unlisted', `${LY.projects}/${name}/${LY.outputs}/${f}`, `成果文件 ${f} 没有登记进项目入口`, '用 add-result 登记');
  }
  // ③ 状态日期落后于任务记录里"完成"的日期
  const stSec = sectionRange(lines, W.sectionCurrentStatus);
  if (stSec) {
    const sd = dayOf(lines.slice(stSec.start, stSec.end).join('\n'));
    const done = taskDoneDates(dir).sort((a, b) => (a.day < b.day ? 1 : -1));
    if (sd && done.length && done[0].day > sd) P('status-behind', `${LY.projects}/${name}/PROJECT.md`, `入口"${W.sectionCurrentStatus}"日期 ${sd} 早于任务记录《${done[0].file}》的完成日期 ${done[0].day}`, `更新入口的"${W.sectionCurrentStatus}"（add-result 会一并更新）`);
  }
  // ⑤ 项目根上散放的文件
  for (const f of listDir(dir)) {
    if (f.startsWith('.') || f === 'PROJECT.md') continue;
    if (isFile(join(dir, f))) P('loose-file', `${LY.projects}/${name}/${f}`, `项目根上散放了文件 ${f}`, '成果放 成果/，旧版和证据放 历史/，任务记录放 任务/');
  }
  // ⑥ 像任务记录却不在 任务/ 里的
  for (const sub of [LY.outputs, LY.history]) {
    for (const f of listDir(join(dir, sub))) {
      if (!f.endsWith('.md')) continue;
      let head = '';
      try { head = readText(join(dir, sub, f)).split('\n').find((l) => l.trim() !== '') ?? ''; } catch { continue; }
      if (new RegExp(`^#\\s*${labelRe(W.taskRecordTitle, '')}`).test(head)) P('taskrecord-misplaced', `${LY.projects}/${name}/${sub}/${f}`, '看着是任务记录，却不在 任务/ 里', '移到 任务/');
    }
  }
  return { problems };
}
// 结案提醒用：根据频道找项目，只看"入口没跟上"三条（①②③）；有就返回一句话，没有返回 null；任何读不到都返回 null
export function entryHintFor({ dataRoot, indexPath, channelId }) {
  if (!dataRoot || !indexPath || !channelId) return null;
  const hit = findProjectByChannel({ dataRoot, indexPath, channelId });
  if (!hit?.name) return null;
  const r = checkProject({ dataRoot, indexPath, name: hit.name });
  if (r.skipped) return null;
  const codes = new Set(r.problems.map((p) => p.code));
  const parts = [];
  if (codes.has('entry-placeholder') || codes.has('result-unlisted')) parts.push(W.entryHintParts.results);
  if (codes.has('status-behind')) parts.push(W.entryHintParts.status);
  if (!parts.length) return null;
  return W.entryHint(parts.join(W.listSep));
}

// ---------- scan ----------
const ROOT_OK = new Set(['INDEX.md', LY.ledgerFile, LY.ownerStatusFile, LY.projects, LY.audit, LY.templates, LY.trash, LY.runLogs, '.git', '.gitignore', '.ignore']);
const RLD = LY.runLogDirs;
const RUNLOG_OK = new Set([RLD.cardThreads, RLD.gate, RLD.watch, RLD.closing, RLD.englishCleanupRaw, RLD.catchup, RLD.quota, RLD.publish, RLD.fileReconcile, RLD.apiQuota, RLD.reminders, RLD.ledgerBacklog, RLD.formatCheck, RLD.requestWatch, RLD.blindspot]);
const WS_FIXED = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'DREAMS.md', 'MEMORY.md', 'memory', 'skills', LY.scratch]);
const WS_EXTRA = {
  desktop: ['screen.lock', 'screen.lock.guard', 'screen-lock.log', 'screen-queue.json', 'screen-queue-history.jsonl', 'screen-queue-settings.json', 'stuck-count.json', 'approval-notice-dedup.json', 'refused-threads.json', 'ui-elements.json'],
  main: ['docs', 'persona-roster', '.inbox', 'FOLLOWUPS.md'],
};
const SYSTEM_DIRS = new Set(['_shared', 'auth-recovery', 'power-observer', 'session-rotation']);
const VERSION_SUFFIX = new RegExp(`[_-](${W.fileNameLint.versionWords.map(escapeRe).join('|')})$`);
const VERSION_MARK = /[_-]v\d+(\.\d+)*(?=$|[_-])/i;
const VERSION_N = new RegExp(`[_-]${W.fileNameLint.versionNumberRe}$`);
const DIARY_OK = new RegExp(`^${escapeRe(LY.diaryFilePrefix)}\\d{8}(-(${LY.diaryRerunSuffixes.map(escapeRe).join('|')})-.+?)?(-\\d+)?\\.md$`);
export function nameProblems(fileName) {
  const out = [];
  if (/[:*?"<>|]/.test(fileName) || /\s/u.test(fileName)) out.push('名字里有空格或 : * ? " < > |');
  if (fileName.includes('__')) out.push('名字里有双下划线');
  if (/^[_.]/.test(fileName)) out.push('名字开头是下划线或点');
  if (/\d{4}-\d{2}-\d{2}/.test(fileName)) out.push('日期写成了带短横线的样子（应写 8 位数字）');
  const stem = fileName.replace(/\.[^.]+$/, '');
  if (VERSION_SUFFIX.test(stem) || VERSION_MARK.test(stem) || VERSION_N.test(stem)) out.push('名字尾部带版本词或版本号');
  return out;
}
function walk(dir, depth, fn, rel = '') {
  if (depth < 0) return;
  for (const n of listDir(dir)) {
    const p = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    fn(p, r, n);
    if (isDir(p)) walk(p, depth - 1, fn, r);
  }
}
const loadJson = (p, fb) => { try { return JSON.parse(readText(p)); } catch { return fb; } };

// scan：只读（唯一写的是状态.json、基线.json 和 out）。workspaces: [{id, dir}]；runtimeRoot 用来核"在 runtime 里面"。
export function scan({ dataRoot, indexPath, runtimeRoot = null, workspaces = null, stateDir = null, date = null, write = true }) {
  if (!dataRoot || !indexPath) return fail('没给资料根或总索引路径');
  const today = date || localDay();
  const sdir = stateDir || join(dataRoot, LY.runLogs, RLD.fileReconcile);
  const statePath = join(sdir, '状态.json');
  const basePath = join(sdir, '基线.json');
  const findings = [];
  const F = (area, where, problem, suggest, keyExtra = '') => findings.push({ key: `${area}|${where}|${problem}${keyExtra}`, area, where, problem, suggest });
  const notes = [];
  // S1 资料根
  for (const n of listDir(dataRoot)) {
    if (ROOT_OK.has(n)) continue;
    if (n.startsWith('.')) continue; // 其他隐藏文件（.DS_Store 已在 listDir 里去掉）
    const testLike = new RegExp(W.fileNameLint.testLike.map(escapeRe).join('|'), 'i').test(n);
    F('S1', n, '资料根下出现了不在规定清单里的东西', testLike ? `看名字像测试遗留：请主人批准后进${LY.trash}并登记` : `若是某项目的成果→移到 ${LY.projects}/<项目名>/${LY.outputs}/；不知道该放哪就问总控，不要留在资料根`);
  }
  // S5 运行记录
  for (const n of listDir(join(dataRoot, LY.runLogs))) {
    if (RUNLOG_OK.has(n) || n.startsWith('.')) continue;
    if (!isDir(join(dataRoot, LY.runLogs, n))) { F('S5', `${LY.runLogs}/${n}`, '运行记录顶层出现了零散文件', '运行记录是程序自己写日志的位置；若不是程序写的，请移走'); continue; }
    F('S5', `${LY.runLogs}/${n}`, '运行记录下出现了不认识的子文件夹', '若是新程序的日志位置，请登记进对账脚本的清单；否则移走');
  }
  // S2 项目对账
  const idx = readIndex(indexPath);
  const projDir = join(dataRoot, LY.projects);
  const folders = listDir(projDir).filter((n) => isDir(join(projDir, n)) && !n.startsWith('.'));
  if (!idx.ok) F('S2', 'INDEX.md', idx.message, '修好总索引项目表');
  else {
    const seen = new Map();
    for (const r of idx.rows) {
      if (!r.channelId) F('S2', `INDEX.md:${r.name}`, '总索引这一行读不出频道编号（解析不了）', `频道栏写成"${W.channelCell('…', '数字')}"的样子`);
      else { if (seen.has(r.channelId)) F('S2', `INDEX.md:${r.name}`, `频道编号 ${r.channelId} 和《${seen.get(r.channelId)}》重复`, '一个频道只对应一个项目'); seen.set(r.channelId, r.name); }
      if (!r.entryPath) F('S2', `INDEX.md:${r.name}`, '总索引这一行没有项目入口链接（解析不了）', `入口栏写成 [${W.projectEntryLinkText}](${LY.projects}/…/PROJECT.md)`);
      else if (!isFile(resolve(dataRoot, r.entryPath))) F('S2', `INDEX.md:${r.name}`, `入口文件不存在：${r.entryPath}`, '补入口，或改正链接');
      if (isDir(join(projDir, r.folder))) {
        for (const p of checkProject({ dataRoot, indexPath, name: r.folder }).problems) F('S2', p.where, p.message, p.suggest, `|${p.code}`);
      } else F('S2', `${LY.projects}/${r.folder}`, '总索引有这个项目，但项目文件夹不存在', '补建文件夹，或改正索引');
    }
    const indexed = new Set(idx.rows.map((r) => r.folder));
    for (const f of folders) if (!indexed.has(f)) F('S2', `${LY.projects}/${f}`, '项目文件夹在，但总索引里没有它的一行', '总控用 new-project 补登，或把这个文件夹移走');
  }
  // S3 命名（只查 项目/** ）
  const frozen = (rel) => rel.split('/')[1] === LY.history; // 项目/<名>/历史/ 下是冻结的旧版和证据（含 Discord 旧线程导出），不查名字
  walk(projDir, 4, (p, rel, n) => {
    if (DIARY_OK.test(n) || frozen(rel)) return;
    for (const pr of nameProblems(n)) F('S3', `${LY.projects}/${rel}`, pr, '改成合规的名字（提示级，不算异常）');
  });
  // S4 bot 工作区新增
  const baseExisted = existsSync(basePath);
  const base = loadJson(basePath, { workspaces: {} });
  const newBase = { workspaces: { ...(base.workspaces ?? {}) } };
  let wsList = [];
  if (Array.isArray(workspaces) && workspaces.length > 0) { // 空名单（比如读配置失败）当作没给，走下面的退路
    for (const w of workspaces) {
      const dir = resolve(String(w.dir ?? ''));
      if (!w.id || !w.dir || !isDir(dir) || (runtimeRoot && !dir.startsWith(resolve(runtimeRoot) + sep))) { F('S4', `工作区名单:${w.id ?? '?'}`, '工作区名单有误（目录不存在或不在 runtime 里面）', '核对 openclaw.json 里这个角色的 workspace'); continue; }
      wsList.push({ id: String(w.id), dir });
    }
  } else if (runtimeRoot) {
    wsList = listDir(runtimeRoot).filter((n) => !SYSTEM_DIRS.has(n) && !n.startsWith('_') && !n.startsWith('.') && isDir(join(runtimeRoot, n))).map((n) => ({ id: n === 'controller' ? 'main' : n, dir: join(runtimeRoot, n) }));
    notes.push('没有收到"角色=目录"对应表，退而扫 runtime/ 下的目录（已排除 4 个系统目录）');
  }
  for (const w of wsList) {
    const known = new Set(base.workspaces?.[w.id] ?? []);
    const fixed = new Set([...WS_FIXED, ...(WS_EXTRA[w.id] ?? [])]);
    const names = listDir(w.dir);
    newBase.workspaces[w.id] = [...new Set([...known, ...names])].sort();
    if (!baseExisted) continue; // 第一次运行只建基线
    for (const n of names) {
      if (fixed.has(n) || known.has(n)) continue;
      F('S4', `${basename(dirname(w.dir)) === 'runtime' ? 'runtime/' : ''}${basename(w.dir)}/${n}`, `${w.id} 的工作区顶层新出现了 ${n}`, `若是某项目的成果→移到 ${LY.projects}/<名>/${LY.outputs}/；若是临时材料→放进 ${LY.scratch}/<任务标题>/；没人用→进${LY.trash}并登记`);
    }
  }
  // 状态：新增 / 满 3 天 / 存量
  const stateExisted = existsSync(statePath);
  const state = loadJson(statePath, { items: {} });
  const items = {};
  const rows = [];
  for (const f of findings) {
    const old = state.items?.[f.key];
    let rec;
    if (!stateExisted) rec = { firstSeen: today, legacy: true };
    else if (old) rec = old;
    else rec = { firstSeen: today, legacy: false };
    items[f.key] = rec;
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${rec.firstSeen}T00:00:00Z`)) / 86400000) + 1;
    const FR = W.fileReconcile;
    let kind = FR.kinds.existing;
    if (!rec.legacy && days === 1) kind = FR.kinds.new;
    else if (!rec.legacy && days === 3) kind = FR.kinds.day3;
    rows.push({ ...f, kind, days, firstSeen: rec.firstSeen });
  }
  const count = (k) => rows.filter((r) => r.kind === k).length;
  const FR = W.fileReconcile;
  const header = FR.header(count(FR.kinds.new), count(FR.kinds.day3), count(FR.kinds.existing));
  const out = [];
  out.push(`# ${FR.title}`, `${labelText(W.businessDateLabel)}${today}`, header, '');
  if (!stateExisted) out.push('（这是对账脚本第一次运行：当时已经存在的发现都记成"存量"，不算新增；之后才出现的才算新增。）', '');
  if (!baseExisted && wsList.length) out.push('（bot 工作区基线也是这次建的：现有文件都记为已知，之后新出现的才报。）', '');
  for (const n of notes) out.push(`（${n}）`, '');
  const section = (title, list) => {
    if (!list.length) return;
    out.push(`## ${title}（${list.length}）`);
    for (const r of list) out.push(`- [${r.area}] ${r.where}：${r.problem}。建议：${r.suggest}。（首次发现 ${r.firstSeen}，第 ${r.days} 天）`);
    out.push('');
  };
  section(FR.sections.new, rows.filter((r) => r.kind === FR.kinds.new));
  section(FR.sections.day3, rows.filter((r) => r.kind === FR.kinds.day3));
  section(FR.sections.existing, rows.filter((r) => r.kind === FR.kinds.existing));
  if (!rows.length) out.push('没有发现。');
  const report = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  if (write) {
    mkdirSync(sdir, { recursive: true });
    atomicWrite(statePath, `${JSON.stringify({ version: 1, items }, null, 1)}\n`, 0o644);
    atomicWrite(basePath, `${JSON.stringify(newBase, null, 1)}\n`, 0o644);
  }
  return { ok: true, header, counts: { 新增: count(FR.kinds.new), 满3天: count(FR.kinds.day3), 存量: count(FR.kinds.existing) }, rows, report, firstRun: !stateExisted, notes };
}
