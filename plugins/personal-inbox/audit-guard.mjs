// Audit guard: the two audit roles may only read, run an allow-list of read-only commands and write to their own report folders.
// 审计守门。
// 只对 系统审计、task-auditor 生效（S8 测试审批分支除外，它排在角色过滤之前）。
// 官方配置负责“有没有这个工具”，这里负责“这个工具拿来干什么”：
//   exec：按命令文字判断——每个程序只认规则文件里列明的只读用法，不认识的选项一律拒绝；
//   write / edit：只许规则文件列明的位置（先规范化、跟随链接，再比对真实路径）。
// 边界：这是按命令文字守门，不是沙箱；规则文件读不到或格式错时，exec/write/edit 一律挡。
import { locale, lexicon } from './lexicon.mjs';
import { crew } from './crew-config.mjs';
import { tzName } from './tz.mjs';
import { existsSync, mkdirSync, appendFileSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const GUARDED_ROLES = ['system-auditor', 'task-auditor'];
const SAFE_PROGRAM_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
const WRITE_TOOLS = ['write', 'edit'];
const ALWAYS_BLOCKED_TOOLS = ['apply_patch', 'multiedit', 'notebookedit', 'process'];
const EXEC_TOOLS = ['exec', 'bash'];

class Reject extends Error {
  constructor(reason, rule = '命令') { super(reason); this.reason = reason; this.rule = rule; }
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const stripPrefix = (name) => String(name ?? '').replace(/^mcp__openclaw__/, '').toLowerCase();

// ---------- 命令拆解 ----------
// 把一条命令拆成按 | 分开的若干段。每段：{ assigns:[{name,value}], argv:[...], stmt:第几条语句 }。
// allowSemicolon=true（规则文件里该角色写了 allowSemicolon）时，引号外的 ; 把命令分成几条语句，每一段仍然各自过守门；
// 不放：;; 空段、开头的 ;、换行、&&、||、后台 &。结尾单独一个 ; 可以。引号里的 ; 照旧是普通字符。
// 以下任何情况整条拒绝：引号没闭合、> >> < << ; && || & 后台、反引号、$(、$ 变量展开（单引号里除外）、
// 换行（引号里除外）、没转义的括号、# 注释。唯一放行的重定向写法是 2>/dev/null 和 2>&1。
export function parseCommand(cmd, { allowSemicolon = false } = {}) {
  if (typeof cmd !== 'string' || cmd.trim() === '') throw new Reject('命令是空的或不是文字', '命令拆解');
  const segments = [];
  let stmt = 0;
  let afterSemicolon = false; // 刚遇到一个 ; 且后面还没有任何内容
  let cur = { assigns: [], argv: [], stmt: 0 };
  let word = null; // { value, raw, quoted }
  let i = 0;
  const n = cmd.length;

  const endWord = () => {
    if (word === null) return;
    if (cur.argv.length === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.raw);
      if (m) {
        cur.assigns.push({ name: m[1], value: word.value.slice(m[1].length + 1) });
        word = null;
        return;
      }
    }
    cur.argv.push(word.value);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (cur.argv.length === 0) throw new Reject('管道里有一段是空的，或只有变量赋值没有程序', '命令拆解');
    segments.push(cur);
    cur = { assigns: [], argv: [], stmt };
  };
  const startWord = () => { afterSemicolon = false; if (word === null) word = { value: '', raw: '' }; };

  while (i < n) {
    const c = cmd[i];
    if (c === "'") {
      startWord();
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) throw new Reject('单引号没有闭合', '命令拆解');
      word.value += cmd.slice(i + 1, j);
      word.raw += cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const d = cmd[j];
        if (d === '"') { closed = true; break; }
        if (d === '`' || d === '$') throw new Reject('双引号里有 $ 或反引号（会展开），不接受', '命令拆解');
        if (d === '\\') {
          const e = cmd[j + 1];
          if (e === '"' || e === '\\') { out += e; j += 2; continue; }
          out += d; j += 1; continue;
        }
        out += d; j += 1;
      }
      if (!closed) throw new Reject('双引号没有闭合', '命令拆解');
      word.value += out;
      word.raw += cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      const e = cmd[i + 1];
      if (e === undefined || e === '\n') throw new Reject('反斜杠后面没有可转义的字符', '命令拆解');
      startWord();
      word.value += e;
      word.raw += c + e;
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i += 1; continue; }
    if (c === '\n' || c === '\r') throw new Reject('命令里有换行（引号外）', '命令拆解');
    if (c === '|') {
      if (cmd[i + 1] === '|') throw new Reject('不接受 ||', '命令拆解');
      endSegment();
      i += 1;
      continue;
    }
    if (c === ';') {
      if (!allowSemicolon) throw new Reject('不接受 ;', '命令拆解');
      endSegment();          // 空段（开头的 ;、;;）在这里被拒
      stmt += 1; cur.stmt = stmt; afterSemicolon = true;
      i += 1;
      continue;
    }
    if (c === '`') throw new Reject('不接受反引号', '命令拆解');
    if (c === '$') throw new Reject('不接受 $（变量或命令替换）', '命令拆解');
    if (c === '(' || c === ')') throw new Reject('不接受没转义的括号', '命令拆解');
    if (c === '#' && word === null) throw new Reject('不接受 # 注释', '命令拆解');
    if (c === '<') throw new Reject('不接受 < 重定向或进程替换', '命令拆解');
    if (c === '&') throw new Reject('不接受 &、&&（后台或连接）', '命令拆解');
    if (c === '>') {
      // 只放行 2>/dev/null 和 2>&1，必须是独立的一个词
      const isTwo = word !== null && word.raw === '2';
      const rest = cmd.slice(i);
      const m1 = /^>\/dev\/null(?=$|[ \t|])/.exec(rest);
      const m2 = /^>&1(?=$|[ \t|])/.exec(rest);
      if (isTwo && (m1 || m2)) {
        word = null;
        i += (m1 ?? m2)[0].length;
        continue;
      }
      throw new Reject('不接受 > 或 >> 写文件重定向（只放行 2>/dev/null 和 2>&1）', '命令拆解');
    }
    startWord();
    word.value += c;
    word.raw += c;
    i += 1;
  }
  if (afterSemicolon && word === null && cur.argv.length === 0 && cur.assigns.length === 0) return segments; // 结尾单独一个 ;
  endSegment();
  return segments;
}

// ---------- 通用选项解析 ----------
// spec: { flags:'abc', valued:'nk', longs:{'--x':0|1|2}, numericShortcut:bool, patterns:{n:'^\\d+$'}, longPatterns:{'--color':'^never$'} }
function parseOpts(prog, args, spec) {
  const positionals = [];
  const opts = [];
  const need = (i, what) => {
    if (i >= args.length) throw new Reject(`${prog} 的 ${what} 后面缺少值`, prog);
    return args[i];
  };
  let afterDD = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (afterDD || a === '-' || !a.startsWith('-')) { positionals.push(a); continue; }
    if (a === '--') { afterDD = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      const takes = spec.longs?.[name];
      if (takes === undefined) throw new Reject(`${prog} 不认识的选项 ${name}${prog === 'ls' && name === '--time-style' ? '（这台 Mac 的 ls 没有这个选项；看完整时间请用 stat -f，例如 stat -f \'%Sm\' 文件）' : ''}`, prog);
      const values = [];
      if (takes === 0) {
        if (eq >= 0) throw new Reject(`${prog} 的 ${name} 不带值`, prog);
      } else {
        if (eq >= 0) values.push(a.slice(eq + 1));
        while (values.length < takes) { i += 1; values.push(need(i, name)); }
      }
      const pat = spec.longPatterns?.[name];
      if (pat && values.some((v) => !new RegExp(pat).test(v))) throw new Reject(`${prog} 的 ${name} 值不合要求`, prog);
      opts.push([name, ...values]);
      continue;
    }
    if (spec.numericShortcut && /^-\d+$/.test(a)) { opts.push(['-N', a.slice(1)]); continue; }
    const chars = a.slice(1);
    for (let j = 0; j < chars.length; j += 1) {
      const ch = chars[j];
      if ((spec.flags ?? '').includes(ch)) { opts.push(['-' + ch]); continue; }
      if ((spec.valued ?? '').includes(ch)) {
        let v = chars.slice(j + 1);
        if (v === '') { i += 1; v = need(i, '-' + ch); }
        const pat = spec.patterns?.[ch];
        if (pat && !new RegExp(pat).test(v)) throw new Reject(`${prog} 的 -${ch} 值不合要求`, prog);
        opts.push(['-' + ch, v]);
        break;
      }
      throw new Reject(`${prog} 不认识的选项 -${ch}（不在只读名单里）`, prog);
    }
  }
  return { positionals, opts };
}

// ---------- 特殊程序 ----------
function checkDate(args, spec = {}) {
// 规则里写了 onlyFormat 的角色（任务审计），date 后面要么没有参数（只读，显示现在的时间），要么只有一个 +格式 参数；
  // 别的写法一律不接受（macOS 的 date 带数字是改系统时间）。不带参数的 date 以前能用，放回来。
  if (spec?.onlyFormat === true) {
    if (args.length === 0) return;
    if (args.length !== 1 || !args[0].startsWith('+')) throw new Reject('date 后面只许没有参数，或者一个 +格式 参数，例如 date +%F；看别的时间请用 stat', 'date');
    return;
  }
  let i = 0;
  let fmtSeen = false;
  while (i < args.length) {
    const a = args[i];
    if (a === '-u' || a === '-j') { i += 1; continue; }
    if (a === '-f') {
      if (i + 2 >= args.length) throw new Reject('date -f 需要“格式”和“时间字符串”两个参数', 'date');
      i += 3; continue;
    }
    if (a === '-r') {
      if (i + 1 >= args.length) throw new Reject('date -r 缺参数', 'date');
      i += 2; continue;
    }
    if (/^-v[+-]?\d+[ymwdHMS]$/.test(a)) { i += 1; continue; }
    if (a.startsWith('+')) {
      if (fmtSeen) throw new Reject('date 只能有一个 +格式', 'date');
      fmtSeen = true; i += 1; continue;
    }
    throw new Reject(`date 不接受参数 ${a}（不以 + 开头的单独参数可能是设系统时间）`, 'date');
  }
}

function checkSed(args) {
  const { positionals, opts } = parseOpts('sed', args, { flags: 'nE' });
  const hasN = opts.some((o) => o[0] === '-n');
  const script = positionals.shift();
  if (script === undefined) throw new Reject('sed 缺脚本', 'sed');
  if (/\n/.test(script)) throw new Reject('sed 脚本不能含换行', 'sed');
  if (/^(\d+|\$)(,(\d+|\$))?p$/.test(script)) {
    if (!hasN) throw new Reject('sed 的 N,Mp 要配 -n', 'sed');
  } else if (/^\d+(,(\d+|\$))?d$/.test(script)) {
    // B1 G3：删前面几行（Nd、N,Md、N,$d），用来跳过 openclaw message read --json 前面的警告行。只读，输出到标准输出。
  } else if (script.startsWith('/')) {
    // B1 G3：-n 配 /正则/p 或 /正则/,$p。正则里不许有没转义的 /、换行，长度 ≤ 80，不许是空的。
    if (!hasN) throw new Reject('sed 的 /正则/p、/正则/,$p 要配 -n', 'sed');
    let k = 1;
    let re = '';
    let closed = false;
    for (; k < script.length; k += 1) {
      const ch = script[k];
      if (ch === '\\') {
        if (k + 1 >= script.length) throw new Reject('sed 的正则以反斜杠结尾', 'sed');
        re += ch + script[k + 1]; k += 1; continue;
      }
      if (ch === '/') { closed = true; break; }
      re += ch;
    }
    if (!closed) throw new Reject('sed 的 /正则/ 没有闭合', 'sed');
    if (re === '') throw new Reject('sed 的正则不能是空的', 'sed');
    if (re.length > 80) throw new Reject('sed 的正则太长（最多 80 个字符）', 'sed');
    const tailPart = script.slice(k + 1);
    if (tailPart !== 'p' && tailPart !== ',$p') throw new Reject('sed 的 /正则/ 后面只认 p 或 ,$p', 'sed');
  } else if (script.startsWith('s/')) {
    // s/正则/替换/标志：按没转义的 / 切，正好三段
    const parts = [];
    let buf = '';
    for (let k = 2; k < script.length; k += 1) {
      const ch = script[k];
      if (ch === '\\') { buf += ch + (script[k + 1] ?? ''); k += 1; continue; }
      if (ch === '/') { parts.push(buf); buf = ''; if (parts.length === 2) { parts.push(script.slice(k + 1)); buf = null; break; } continue; }
      buf += ch;
    }
    if (parts.length !== 3 || buf !== null) throw new Reject('sed 的 s 命令格式不对（只认 s/…/…/标志）', 'sed');
    if (!/^[gpI0-9]*$/.test(parts[2])) throw new Reject('sed 的 s 命令标志只许 g、p、I 和数字（w、e 不许）', 'sed');
  } else {
    throw new Reject('sed 脚本只认 N,Mp（配 -n）、Nd／N,Md／N,$d、-n 配 /正则/p 或 /正则/,$p，和 s/…/…/标志', 'sed');
  }
}

// B1 G2：system-auditor 的 jq。选项沿用 generic 的检查，再对过滤式（第一个位置参数）做禁词检查。
// 禁词表在规则文件 roles['system-auditor'].programs.jq.forbidFilter（正则），挡明显的，不是证明 jq 过滤式绝对安全。
function checkJq(args, spec) {
  const { positionals } = parseOpts('jq', args, spec);
  if (typeof spec.forbidFilter !== 'string' || spec.forbidFilter === '') throw new Reject('规则文件缺 jq 的禁词表', '规则文件');
  // 没写过滤式（jq 管道末尾单独一个 jq，等于 jq .）：没有可查的，和改前一样放行
  const m = positionals.length > 0 ? new RegExp(spec.forbidFilter).exec(positionals[0]) : null;
  if (m) throw new Reject(`jq 过滤式里不许出现 ${m[0]}（会读环境变量或别的文件、往错误输出打印、提前结束；字段名或字符串里出现这个词也会被挡）`, 'jq');
}

const FIND_VALUED = ['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-newer', '-size', '-perm', '-user', '-newermt'];
const FIND_BARE = ['-empty', '-print', '-print0', '-prune', '-not', '!', '(', ')', '-o', '-a'];
function checkFind(args, rules) {
  let i = 0;
  while (i < args.length && !(args[i].startsWith('-') || args[i] === '!' || args[i] === '(')) i += 1;
  if (i === 0) throw new Reject('find 必须先写起点路径', 'find');
  const allowedValued = rules?.valued ?? FIND_VALUED;
  const allowedBare = rules?.bare ?? FIND_BARE;
  for (; i < args.length; i += 1) {
    const a = args[i];
    if (allowedBare.includes(a)) continue;
    if (allowedValued.includes(a)) {
      i += 1;
      if (i >= args.length) throw new Reject(`find 的 ${a} 缺值`, 'find');
      if (a === '-newermt' && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(args[i])) {
        throw new Reject('find -newermt 只认“YYYY-MM-DD HH:MM:SS”写法的一个时间（配置时区的本地时间）', 'find');
      }
      continue;
    }
    throw new Reject(`find 不认识的选项 ${a}（-exec、-delete、-fprint 等一律不许）`, 'find');
  }
}

function checkOpenclaw(args, rules) {
  if (args.length === 0 || args[0].startsWith('-')) throw new Reject('openclaw 只认列明的只读子命令（不接受全局选项）', 'openclaw');
  const table = rules?.subcommands ?? {};
  // 找最长匹配的子命令
  let best = null;
  for (const key of Object.keys(table)) {
    const words = key.split(' ');
    if (words.every((w, k) => args[k] === w) && (!best || words.length > best.words.length)) best = { key, words };
  }
  if (!best) throw new Reject(`openclaw ${args.slice(0, 2).join(' ')} 不在只读子命令名单里`, 'openclaw');
  const spec = table[best.key];
  const { positionals } = parseOpts(`openclaw ${best.key}`, args.slice(best.words.length), {
    flags: '', valued: '',
    longs: Object.fromEntries([...(spec.flags ?? []).map((f) => [f, 0]), ...(spec.valued ?? []).map((f) => [f, 1])]),
  });
  const max = spec.maxPositional ?? 0;
  if (positionals.length > max) throw new Reject(`openclaw ${best.key} 多出了不认识的参数`, 'openclaw');
}

// B1 G1：system-auditor 的窄 git。只在规则文件里该程序带 requireC 时走这里；任务审计（task-auditor）没有 requireC，走下面原来的 checkGit，一个字不变。
// 格式只许 git -C <资料根或项目根> [--no-pager] log …；不开 show（show <对象编号> --stat 能吐出文件全文）。
function checkGitNarrow(args, spec, paths) {
  if (args[0] !== '-C' || args.length < 3) throw new Reject('git 必须写成 git -C <资料根或项目根> --no-pager log …（-C 不能省）', 'git');
  const strip = (s) => String(s).replace(/\/+$/, '');
  const allowedDirs = (spec.repos ?? []).map((k) => paths?.[k]).filter((s) => typeof s === 'string' && s !== '').map(strip);
  if (allowedDirs.length === 0) throw new Reject('规则文件没有给 git 列允许的仓库目录', '规则文件');
  if (!allowedDirs.includes(strip(args[1]))) throw new Reject('git -C 只许指到资料根或项目根（原样写，不带 .. 或别的写法）', 'git');
  let rest = args.slice(2);
  if (rest[0] === '--no-pager') rest = rest.slice(1);
  const sub = rest[0];
  if (sub === 'show') throw new Reject('git show 不开，看某个提交改了哪些文件请用 git -C <项目根> --no-pager log -n 1 --stat <提交>', 'git');
  const table = spec.subcommands ?? {};
  if (sub === undefined || !Object.hasOwn(table, sub)) throw new Reject(`git ${sub ?? ''} 不在只读子命令名单里（只开 log）`, 'git');
  const sspec = table[sub];
  let tail = rest.slice(1);
  let pathspecs = [];
  const dd = tail.indexOf('--');
  if (dd >= 0) { pathspecs = tail.slice(dd + 1); tail = tail.slice(0, dd); }
  if (pathspecs.length > (sspec.maxPathspec ?? 0)) throw new Reject(`git ${sub} 的 -- 后面路径太多`, 'git');
  const longs = Object.fromEntries([...(sspec.flags ?? []).filter((f) => f.startsWith('--')).map((f) => [f, 0]), ...(sspec.valued ?? []).filter((f) => f.startsWith('--')).map((f) => [f, 1])]);
  const eqValued = sspec.eqValued ?? [];
  const cleaned = [];
  for (const a of tail) {
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && eqValued.includes(a.slice(0, eq))) continue;
    if (/^-\d+$/.test(a) && sspec.numeric) continue;
    cleaned.push(a);
  }
  const shortFlags = (sspec.flags ?? []).filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]).join('');
  const shortValued = (sspec.valued ?? []).filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]).join('');
  const { positionals } = parseOpts(`git ${sub}`, cleaned, { flags: shortFlags, valued: shortValued, longs, patterns: sspec.patterns, longPatterns: sspec.longPatterns });
  for (const a of tail) {
    if (a.startsWith('-') && /output|ext-diff|textconv|exec-path|config/.test(a)) throw new Reject('git 参数里出现了会写文件或调外部程序的选项', 'git');
  }
  if (positionals.length > (sspec.maxPositional ?? 0)) throw new Reject(`git ${sub} 最多写一个提交，别的不认识`, 'git');
  for (const p of positionals) {
    if (!/^[0-9A-Za-z._\/^~@-]+$/.test(p) || p.startsWith('-')) throw new Reject('git log 的提交只认字母数字和 . _ / ^ ~ @ -（不许 : 这类 提交:路径 写法）', 'git');
  }
}

function checkGit(args, rules, paths) {
  if (rules?.requireC) { checkGitNarrow(args, rules, paths); return; }
  let rest = [...args];
  if (rest[0] === '-C') {
    if (rest.length < 3) throw new Reject('git -C 缺目录或子命令', 'git');
    rest = rest.slice(2);
  }
  const sub = rest[0];
  const table = rules?.subcommands ?? {};
  if (sub === undefined || !(sub in table)) throw new Reject(`git ${sub ?? ''} 不在只读子命令名单里`, 'git');
  const spec = table[sub];
  const tail = rest.slice(1);
  if (sub === 'cat-file') {
    if (tail.length !== 2 || !['-p', '-t'].includes(tail[0]) || tail[1].startsWith('-')) throw new Reject('git cat-file 只认 -p 或 -t 加一个对象', 'git');
    return;
  }
  const longs = Object.fromEntries([...(spec.flags ?? []).filter((f) => f.startsWith('--')).map((f) => [f, 0]), ...(spec.valued ?? []).filter((f) => f.startsWith('--')).map((f) => [f, 1])]);
  const eqValued = spec.eqValued ?? [];
  const cleaned = [];
  for (const a of tail) {
    // --format=… 这类“选项=值”
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0 && eqValued.includes(a.slice(0, eq))) continue;
    if (/^-U\d+$/.test(a) && (spec.flags ?? []).includes('-U')) continue;
    if (/^-\d+$/.test(a) && spec.numeric) continue;
    cleaned.push(a);
  }
  const shortFlags = (spec.flags ?? []).filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]).join('');
  const shortValued = (spec.valued ?? []).filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]).join('');
  parseOpts(`git ${sub}`, cleaned, { flags: shortFlags, valued: shortValued, longs });
  for (const a of tail) {
    if (a.startsWith('-') && /output|ext-diff|textconv|exec-path|config/.test(a)) throw new Reject('git 参数里出现了会写文件或调外部程序的选项', 'git');
  }
}

function checkDiff(args, env) {
  const { positionals, opts } = parseOpts('diff', args, { flags: 'uq' });
  void opts;
  if (positionals.length !== 2) throw new Reject('diff 只认比较两个现有的普通文件', 'diff');
  for (const p of positionals) {
    if (p === '-') throw new Reject('diff 不接受标准输入 -', 'diff');
    let real;
    try { real = realpathSync(resolve(env?.cwd ?? '/', p)); } catch { throw new Reject(`diff 的文件不存在或读不到：${p}`, 'diff'); }
    let st;
    try { st = statSync(real); } catch { throw new Reject(`diff 的文件读不到：${p}`, 'diff'); }
    if (!st.isFile()) throw new Reject(`diff 只比较普通文件（目录、设备、管道文件不行）：${p}`, 'diff');
  }
}

function checkPublish(argv, rules, paths = {}) {
  const [prog, flag, script, task, date] = argv;
  if (prog !== '/usr/bin/python3' || flag !== '-I' || argv.length !== 5) throw new Reject('python3 只认固定发布脚本', 'python3');
  if (script !== expandPaths(rules.script, paths)) throw new Reject('python3 只能跑固定发布脚本', 'python3');
  if (!rules.tasks.includes(task)) throw new Reject(`发布脚本的任务名不在 ${rules.tasks.join('／')} 之内`, 'python3');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Reject('发布脚本的业务日期格式不对', 'python3');
}

function checkExact(argv, expected, label) {
  if (argv.length !== expected.length || argv.some((a, k) => a !== expected[k])) throw new Reject(`${label} 只认规则文件里写明的那一条命令原样`, label);
}

// ---------- 固定片段 ----------
// 片段比对用“规范化原文”：去掉整行注释（以 # 开头的行）、空行和行尾空白，其余代码行逐字保留（缩进也要一致）。
// 原因（真实测试 S5，09:06）：模型照指令运行片段时习惯把开头的注释行（“# 业务日期片段开始”“# 用法…”）和结尾标记去掉，
// 要求连注释都逐字一致会把现行任务要用的片段全挡掉。注释行不执行，忽略它们不放宽任何可执行内容。
// 前提（守门小修，主人批）：忽略注释行和空行，只在片段里没有把“# 开头的行”或“空行”当数据用的块时才等价，
// 比如 cat <<EOF 数据块、三引号字符串；三段现有片段满足这个前提，tests/audit-guard.test.mjs 里有前提扫描，改片段时先过它。
// 不做任何引号替换：片段里已经没有单引号，模型整段放进 sh -c '…' 即可，改引号一律不放行。
export function canonicalSnippet(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .join('\n');
}

// 从指令文件里取“开始标记行”到“结束标记行”（含两行），整行相等，各正好 1 次，否则该片段不可用。
export function extractSnippet(fileText, startMarker, endMarker) {
  const lines = fileText.replace(/\r\n/g, '\n').split('\n');
  const starts = lines.flatMap((l, k) => (l === startMarker ? [k] : []));
  const ends = lines.flatMap((l, k) => (l === endMarker ? [k] : []));
  if (starts.length !== 1 || ends.length !== 1) throw new Error(`标记行出现次数不对（开始 ${starts.length}、结束 ${ends.length}）`);
  if (ends[0] <= starts[0]) throw new Error('结束标记在开始标记之前');
  return lines.slice(starts[0], ends[0] + 1).join('\n');
}

// A snippet field may be a plain string or an object keyed by locale ({ "zh-CN": ..., "en": ... }).
// A relative "file" is resolved against rules.paths.projectRoot. "${dataRoot}" / "${projectRoot}" inside enum values are expanded from rules.paths.
const pickLocale = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v[locale()] ?? v['zh-CN']) : v);
const expandPaths = (v, paths) => (typeof v === 'string' ? v.replace(/\$\{(dataRoot|projectRoot)\}/g, (_, k) => paths?.[k] ?? '') : Array.isArray(v) ? v.map((x) => expandPaths(x, paths)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandPaths(x, paths)])) : v);
// Deploy-time placeholders inside snippets are filled from config/crew.json (timezone, paths); unknown or empty ones stay as written.
const fillPlaceholders = (text, paths = {}) => text
  .replace(/<TIMEZONE>/g, crew.timezone || '<TIMEZONE>')
  .replace(/<DATA_ROOT>/g, paths.dataRoot || '<DATA_ROOT>')
  .replace(/<PROJECT_ROOT>/g, paths.projectRoot || '<PROJECT_ROOT>')
  .replace(/<OPENCLAW_INSTALL_DIR>/g, crew.paths.openclawInstallDir || '<OPENCLAW_INSTALL_DIR>');
export function loadSnippets(rules, readText = (p) => readFileSync(p, 'utf8')) {
  const out = [];
  const problems = [];
  for (const s of rules.snippets ?? []) {
    try {
      const file = pickLocale(s.file);
      const abs = isAbsolute(file) ? file : join(rules.paths?.projectRoot ?? '', file);
      const text = fillPlaceholders(extractSnippet(readText(abs), pickLocale(s.start), pickLocale(s.end)), rules.paths);
      out.push({ name: s.name, text, fingerprint: sha256(canonicalSnippet(text)), vars: expandPaths(s.vars ?? {}, rules.paths) });
    } catch (e) {
      problems.push(`${s.name}：${e.message}`);
    }
  }
  return { snippets: out, problems };
}

function matchSnippet(segments, snippets) {
  if (segments.length !== 1) return null;
  const seg = segments[0];
  if (seg.argv.length !== 3 || !['sh', '/bin/sh'].includes(seg.argv[0]) || seg.argv[1] !== '-c') return null;
  const fp = sha256(canonicalSnippet(seg.argv[2]));
  const hit = snippets.find((s) => s.fingerprint === fp);
  if (!hit) return null;
  const seen = new Set();
  for (const { name, value } of seg.assigns) {
    const rule = hit.vars[name];
    if (!rule || seen.has(name)) throw new Reject(`片段“${hit.name}”不接受变量 ${name}（或重复设置）`, '固定片段');
    seen.add(name);
    if (rule.enum) {
      if (!rule.enum.includes(value)) throw new Reject(`片段变量 ${name} 的值不在允许范围`, '固定片段');
    } else if (!new RegExp(rule.re).test(value)) {
      throw new Reject(`片段变量 ${name} 的值格式不对`, '固定片段');
    }
  }
  for (const [name, rule] of Object.entries(hit.vars)) {
    if (rule.required && !seen.has(name)) throw new Reject(`片段“${hit.name}”缺少变量 ${name}`, '固定片段');
  }
  return hit;
}

const SNIPPET_HINT = "如果你是要跑固定片段，请按指令里的原文整段放进 sh -c '…'，片段已经没有单引号，不要改引号、不要增删代码行";

// ---------- 第二种例外：触发脚本自己的调用 ----------
// 认法（四样同时成立才算，缺一样、格式变了都按原规则判，只会多挡不会多放）：
//   1. 角色是 system-auditor；
//   2. 会话键正好是 agent:system-auditor:cron:<任务编号>:trigger；
//   3. 运行编号以 cron-trigger:<同一个任务编号>: 开头（后面还要有内容）；
//   4. 任务编号在规则文件 triggerJobs 白名单里。
// 会话键和运行编号都是官方在调用上下文里给的，模型的工具参数改不了。
// 认出后只跳过“命令文字”的逐项检查；exec 的额外参数检查、一律挡的工具、write／edit 的写入规则都照旧。
const TRIGGER_SESSION_RE = /^agent:system-auditor:cron:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):trigger$/;
export function identifyTrigger({ role, sessionKey, runId, rules }) {
  if (role !== 'system-auditor') return null;
  if (typeof sessionKey !== 'string' || typeof runId !== 'string') return null;
  const m = TRIGGER_SESSION_RE.exec(sessionKey);
  if (!m) return null;
  const jobId = m[1];
  const prefix = `cron-trigger:${jobId}:`;
  if (!runId.startsWith(prefix) || runId.length <= prefix.length) return null;
  const jobs = rules?.triggerJobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs) || !Object.hasOwn(jobs, jobId)) return null;
  return { jobId, name: String(jobs[jobId]) };
}

// ---------- 总判断 ----------
// Per-locale overlay: rules.localeOverrides.<locale> replaces the data-root folder lists and the publish task names.
// Returns a NEW object and never changes the rules object it is given (tests and the plugin share one rules object).
// zh-CN (and any rules object without an overlay) is returned as it is.
export function effectiveRules(rules) {
  const o = rules?.localeOverrides?.[locale()];
  if (!o || typeof o !== 'object') return rules;
  const out = { ...rules };
  for (const k of ['writeDirs', 'denyWriteDirs', 'editExtra']) if (Array.isArray(o[k])) out[k] = o[k];
  if (Array.isArray(o.publishTasks) && rules.roles) {
    out.roles = Object.fromEntries(Object.entries(rules.roles).map(([r, v]) => [r, v?.publish ? { ...v, publish: { ...v.publish, tasks: o.publishTasks } } : v]));
  }
  return out;
}

export function judgeCommand({ role, command, params = {}, rules, snippets = [], env = {}, trigger = null }) {
  rules = effectiveRules(rules);
  try {
    // exec 的额外参数：只拦会改变执行环境或位置的几个（env、elevated、background、node、host 不是 auto／gateway）；
    // title、description、timeoutSeconds、yieldMs、workdir、pty、ask 这类只影响显示或时限，不拦（07:5x 真实测试里任务审计带 title 被误挡，已改）。
    if (params.env != null && typeof params.env === 'object' && Object.keys(params.env).length > 0) throw new Reject('exec 的 env 参数不许用（可能改变执行环境）；固定片段要用的变量请写在命令前面，如 HM=18:05 DOW= sh -c \'…\'', 'exec 参数');
    if (params.elevated === true) throw new Reject('exec 的 elevated 参数不许用', 'exec 参数');
    if (params.background === true) throw new Reject('exec 的 background 参数不许用', 'exec 参数');
    if (params.node != null) throw new Reject('exec 的 node 参数不许用', 'exec 参数');
    if (params.host != null && !['auto', 'gateway'].includes(params.host)) throw new Reject('exec 的 host 只许 auto 或 gateway', 'exec 参数');
    // 触发脚本自己的调用：参数检查已过，跳过命令文字的逐项检查（见上面“第二种例外”）
    if (trigger && role === 'system-auditor') {
      if (typeof command !== 'string' || command.trim() === '') throw new Reject('读不到要执行的命令', '命令拆解');
      return { allow: true, via: `触发脚本：${trigger.name}`, trigger };
    }
    const roleRules0 = rules.roles?.[role];
    const segments = parseCommand(command, { allowSemicolon: roleRules0?.allowSemicolon === true });
// 固定片段：整条命令就是一条片段调用（原来的认法）； 连起来时，每条语句各自认——
    // 一条语句只有一段（不是管道的一部分）且正好是片段调用，才按固定片段放行；其余语句、其余段照常逐段检查。
    const byStmt = new Map();
    for (const seg of segments) byStmt.set(seg.stmt ?? 0, [...(byStmt.get(seg.stmt ?? 0) ?? []), seg]);
    let snippetVia = null;
    const snippetStmts = new Set();
    if (role === 'system-auditor') {
      for (const [k, group] of byStmt) {
        const h = matchSnippet(group, snippets);
        if (h) { snippetStmts.add(k); snippetVia = snippetVia ?? h; }
      }
      if (snippetStmts.size === byStmt.size && snippetVia) return { allow: true, via: `固定片段：${snippetVia.name}` };
    }
    const roleRules = rules.roles?.[role];
    if (!roleRules) throw new Reject('这个角色没有命令名单', '角色');
    for (const seg of segments) {
      if (snippetStmts.has(seg.stmt ?? 0)) continue;
// 只对规则里写了 allowTzDate 的 date 放开 `TZ=<configured timezone> date …` 这一个写法，别的变量赋值一律不许。
      const isTzDate = roleRules.programs?.date?.allowTzDate === true && seg.assigns.length === 1 && seg.assigns[0].name === 'TZ'
        && seg.assigns[0].value === tzName() && ['date', '/bin/date'].includes(seg.argv[0]);
      if (seg.assigns.length > 0 && !isTzDate) throw new Reject(`命令前不能带变量赋值（只有固定片段可以）；${SNIPPET_HINT}`, '命令拆解');
      const [rawProg, ...args] = seg.argv;
      let prog = rawProg;
      if (rawProg.includes('/')) {
        const dir = dirname(rawProg);
        if (!SAFE_PROGRAM_DIRS.includes(dir) && rawProg !== roleRules.publish?.python && rawProg !== roleRules.codexbar?.[0]) {
          throw new Reject(`程序路径 ${rawProg} 不在标准位置`, '程序名单');
        }
        prog = basename(rawProg);
      }
      if (['env', 'xargs', 'sh', 'bash', 'zsh', 'command', 'exec', 'nohup', 'time', 'eval', 'source', '.'].includes(prog)) {
        throw new Reject(`${prog} 会再起别的程序，不接受（固定片段除外）；${SNIPPET_HINT}`, '程序名单');
      }
      if (rawProg === roleRules.codexbar?.[0]) { checkExact(seg.argv, roleRules.codexbar, '额度读数命令'); continue; }
      if (prog === 'python3' || rawProg === roleRules.publish?.python) {
        if (!roleRules.publish) throw new Reject('这个角色不能跑 python3', 'python3');
        checkPublish(seg.argv, roleRules.publish, rules.paths);
        continue;
      }
      const spec = roleRules.programs?.[prog];
      if (!spec) throw new Reject(`程序 ${prog} 不在这个角色的名单里`, '程序名单');
      switch (spec.kind) {
        case 'generic': {
          const { positionals } = parseOpts(prog, args, spec);
          if (spec.exactPositional !== undefined && positionals.length !== spec.exactPositional) throw new Reject(`${prog} 的参数个数不对`, prog);
          if (spec.maxPositional !== undefined && positionals.length > spec.maxPositional) throw new Reject(`${prog} 的参数太多`, prog);
          break;
        }
        case 'date': checkDate(args, spec); break;
        case 'sed': checkSed(args); break;
        case 'find': checkFind(args, spec); break;
        case 'openclaw': checkOpenclaw(args, spec); break;
        case 'git': checkGit(args, spec, rules.paths); break;
        case 'jq': checkJq(args, spec); break;
        case 'diff': checkDiff(args, env); break;
        default: throw new Reject(`程序 ${prog} 的规则类型不认识`, '规则文件');
      }
    }
    return { allow: true, via: '逐程序只读名单' };
  } catch (e) {
    if (e instanceof Reject) return { allow: false, reason: e.reason, rule: e.rule };
    return { allow: false, reason: `守门检查出错：${e.message}`, rule: '内部错误' };
  }
}

// ---------- 写入位置 ----------
function realTarget(p) {
  const norm = resolve(p);
  if (existsSync(norm)) return realpathSync(norm);
  let dangling = false;
  try { lstatSync(norm); dangling = true; } catch { /* 不存在 */ }
  if (dangling) throw new Reject('目标是指向不存在位置的链接，不允许经它写', '写入位置');
  const dir = dirname(norm);
  if (!existsSync(dir)) throw new Reject('目标文件所在的目录不存在', '写入位置');
  return join(realpathSync(dir), basename(norm));
}

const under = (target, dir) => target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep);
const safeReal = (p) => { try { return realpathSync(p); } catch { return null; } };

export function judgeWrite({ role, toolName, params, rules }) {
  rules = effectiveRules(rules);
  try {
    if (role !== 'system-auditor') throw new Reject('这个角色没有任何写入权限', '写入位置');
    const raw = params?.path ?? params?.file_path ?? params?.filePath ?? params?.file;
    if (typeof raw !== 'string' || raw === '') throw new Reject('读不到要写的文件路径', '写入位置');
    if (!raw.startsWith('/')) throw new Reject('写入路径必须是绝对路径', '写入位置');
    const target = realTarget(raw);
    const dataRoot = safeReal(rules.paths.dataRoot);
    if (!dataRoot) throw new Reject('读不到资料根', '写入位置');
    for (const d of rules.denyWriteDirs ?? []) {
      const dir = safeReal(join(dataRoot, d));
      if (dir && under(target, dir)) throw new Reject(`${d} 只由发布脚本写，明确禁止`, '写入位置');
    }
    for (const d of rules.writeDirs ?? []) {
      const dir = safeReal(join(dataRoot, d));
      if (dir && under(target, dir)) return { allow: true };
    }
    if (toolName === 'edit') {
      const rel = target.startsWith(dataRoot + sep) ? target.slice(dataRoot.length + 1) : null;
      if (rel) {
        for (const pattern of rules.editExtra ?? []) {
          const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
          if (re.test(rel)) return { allow: true };
        }
      }
    }
    throw new Reject(toolName === 'write' ? '整份写入只许审计目录（日审、额度读数、异常深审、周审、异常标记）' : '精确替换只许审计目录、PROJECT.md 和任务记录', '写入位置');
  } catch (e) {
    if (e instanceof Reject) return { allow: false, reason: e.reason, rule: e.rule };
    return { allow: false, reason: `守门检查出错：${e.message}`, rule: '内部错误' };
  }
}

// ---------- 记录 ----------
const MASK = [
  [/Bearer\s+\S+/g, '[已遮蔽]'],
  [/sk-[A-Za-z0-9_-]+/g, '[已遮蔽]'],
  [/(token|password|secret|key)=\S+/gi, '$1=[已遮蔽]'],
  [/[A-Za-z0-9]{24,}/g, '[已遮蔽]'],
];
// 被挡命令写进守门日志的最大字符数
export const EXEC_LOG_CHARS = 2000;
// 指令里三段固定片段的调用写法：开头若干个变量赋值（值可以加引号，如 A="2026-11-10 18:05:00"），接着是 sh -c ' 或 /bin/sh -c '。只用来决定要不要加提示，不参与任何放行判断
export const SNIPPET_CALL_HEAD = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'`$;|&<>()\\]*)\s+)*(?:\/bin\/)?sh\s+-c\s+'/;
export const SEMICOLON_SNIPPET_HINT = '（如果你是在用指令里的固定片段：片段整段原样放进 sh -c \'…\' 的一对单引号里，单引号一关这条命令就结束，后面不要再接任何命令，也不要把片段拆开写；注释行和空行可以不抄。）';
export function maskSecrets(text) {
  let s = String(text ?? '');
  for (const [re, to] of MASK) s = s.replace(re, to);
  return s;
}

function localDateOf(ms) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tzName() }).format(new Date(ms));
}

export function logGuard(dir, entry, now = Date.now) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const row = { 时间: new Date(now()).toISOString(), ...entry };
    appendFileSync(join(dir, `${localDateOf(now())}.jsonl`), JSON.stringify(row) + '\n');
  } catch { /* 记不上也不能影响判断；判断本身已经挡了 */ }
}

// ---------- S8：测试审批分支（默认关；每次调用时读开关）----------
function p4Flag(rulesPath, readText) {
  try { return JSON.parse(readText(rulesPath)).p4ApprovalTest === true; } catch { return false; }
}

export function judgeP4(event, ctx, rules, flagOn, now = Date.now) {
  const cfg = rules?.p4Test;
  if (!cfg) return null;
  if ((ctx?.agentId ?? '') !== cfg.agentId) return null;
  if (!String(ctx?.sessionKey ?? '').includes(cfg.channelId)) return null;
  if (!EXEC_TOOLS.includes(stripPrefix(event?.toolName ?? ctx?.toolName))) return null;
  const command = event?.params?.command;
  if (command !== cfg.command) return null;
  return { matched: true, on: flagOn };
}

// ---------- 注册 ----------
export function createAuditGuard({ rulesPath, logDir, readText = (p) => readFileSync(p, 'utf8'), now = Date.now, pathsOverride = null } = {}) {
  let rules = null;
  let snippets = [];
  let failure = null;
  const startupNotes = []; // 启动时发现的问题先记着，等第一次真正处理两个受管角色的调用时才写守门记录（启动时就写会在测试里乱建目录）
  try {
    rules = JSON.parse(readText(rulesPath));
    if (pathsOverride) rules.paths = { ...(rules.paths ?? {}), ...Object.fromEntries(Object.entries(pathsOverride).filter(([, v]) => v)) }; // config/crew.json wins over the defaults in the rules file
    if (!rules?.paths?.dataRoot || !rules.roles) throw new Error('规则文件缺必要项');
    const loaded = loadSnippets(rules, readText);
    snippets = loaded.snippets;
    if (loaded.problems.length) startupNotes.push({ 事件: '固定片段不可用', 说明: loaded.problems });
  } catch (e) {
    failure = `规则文件读不到或格式错：${e.message}`;
    startupNotes.push({ 事件: '规则文件不可用', 说明: failure });
  }

  // 每一行记录都带会话键和运行编号（官方给的调用身份，缺了记 null），事后能分清是触发脚本还是模型发的
  const idsOf = (ctx) => ({
    会话键: typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : null,
    运行编号: typeof ctx?.runId === 'string' ? ctx.runId : null,
  });
  const blockWith = (role, toolName, summary, verdict, ids) => {
    // 日志的“内容”：命令（exec）记最多 EXEC_LOG_CHARS 字符，其余操作仍是 200；先遮蔽密钥再截断（先截断会在截断处留下一截不到 24 字符、没被遮住的密钥片段）
    const content = maskSecrets(String(summary ?? '')).slice(0, toolName === 'exec' ? EXEC_LOG_CHARS : 200);
    logGuard(logDir, { 角色: role, 工具: toolName, ...ids, 结果: '挡', 规则: verdict.rule, 原因: verdict.reason, 内容: content }, now);
    // 只加提示文字，不改判定：以“变量赋值 + sh -c '”开头的命令（指令里三段固定片段的调用写法）因“不接受 ;”被挡时，告诉模型怎么写
    const hint = toolName === 'exec' && verdict.reason === '不接受 ;' && SNIPPET_CALL_HEAD.test(String(summary ?? '')) ? SEMICOLON_SNIPPET_HINT : '';
    return { block: true, blockReason: `审计守门：这条${toolName === 'exec' ? '命令' : '操作'}不在允许范围（规则：${verdict.rule}）。${verdict.reason}${hint}` };
  };

  function handler(event, ctx) {
    const role = ctx?.agentId;
    const toolName = stripPrefix(event?.toolName ?? ctx?.toolName);
    const ids = idsOf(ctx);
    // S8 分支排在角色过滤之前
    if (rules?.p4Test && role === rules.p4Test.agentId) {
      const m = judgeP4(event, ctx, rules, null, now);
      if (m) {
        const on = p4Flag(rulesPath, readText);
        logGuard(logDir, { 角色: role, 工具: toolName, ...ids, 事件: `P4 测试分支：${on ? '开' : '关'}` }, now);
        if (on) {
          return {
            requireApproval: {
              title: lexicon().notices.auditGuard.p4Title,
              description: lexicon().notices.auditGuard.p4Description,
              severity: 'info',
              timeoutMs: 120000,
              allowedDecisions: ['allow-once', 'deny'],
              onResolution: (decision) => logGuard(logDir, { 角色: role, ...ids, 事件: `P4 测试分支：审批结果 ${decision}` }, now),
            },
          };
        }
        return undefined;
      }
    }
    if (!GUARDED_ROLES.includes(role)) return undefined;
    while (startupNotes.length) logGuard(logDir, { ...ids, ...startupNotes.shift() }, now);
    if (ALWAYS_BLOCKED_TOOLS.includes(toolName)) {
      return blockWith(role, toolName, toolName, { rule: '工具名单', reason: `${toolName} 对审计角色一律不开放。` }, ids);
    }
    const isExec = EXEC_TOOLS.includes(toolName);
    const isWrite = WRITE_TOOLS.includes(toolName);
    if (!isExec && !isWrite) return undefined;
    if (failure) return blockWith(role, toolName, '', { rule: '规则文件', reason: `${failure}。为安全起见一律挡。` }, ids);
    if (isExec) {
      const trigger = identifyTrigger({ role, sessionKey: ctx?.sessionKey, runId: ctx?.runId, rules });
      const verdict = judgeCommand({ role, command: event?.params?.command, params: event?.params ?? {}, rules, snippets, env: { cwd: event?.params?.workdir }, trigger });
      if (!verdict.allow) return blockWith(role, 'exec', event?.params?.command, verdict, ids);
      if (verdict.trigger) {
        const cmd = String(event?.params?.command ?? '');
        logGuard(logDir, { 角色: role, 工具: 'exec', ...ids, 结果: '放行（触发脚本）', 任务编号: verdict.trigger.jobId, 任务: verdict.trigger.name, 内容: maskSecrets(cmd.slice(0, 200)), 命令sha256: sha256(cmd) }, now);
      }
      return undefined;
    }
    const verdict = judgeWrite({ role, toolName, params: event?.params, rules });
    if (!verdict.allow) return blockWith(role, toolName, event?.params?.path ?? event?.params?.file_path, verdict, ids);
    return undefined;
  }
  return { handler, get failure() { return failure; }, get snippets() { return snippets; }, get rules() { return rules; } };
}

export function registerAuditGuard(api, options = {}) {
  if (!options.rulesPath) return null;
  const guard = createAuditGuard({ pathsOverride: { dataRoot: crew.paths.dataRoot, projectRoot: crew.paths.projectRoot }, ...options });
  api.on('before_tool_call', guard.handler, { registrationId: 'audit-guard' });
  return guard;
}
