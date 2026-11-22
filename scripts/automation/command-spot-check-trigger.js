// Trigger script run before the daily audit: spot-checks the commands every role ran and writes the result file. Always returns fire:true.
// 日审的触发脚本：每天在日审开工前，把"非桌面角色角色的命令抽查"做完，写成 <资料根>/审计/日审/<业务日期>-命令抽查.md。
// 永远返回 fire:true（日审不会因它被跳过）；日审只读这个文件，不自己去读 Claude 会话记录。
// 官方触发脚本：用 exec({command}) 取命令输出，用 json({...}) 返回。合计 4 次工具调用（读配置、读会话、读桌面角色＋API 通路事件库、写文件＋对账），官方预算 5 次、30 秒。
// EDIT THE CONSTANTS BELOW to match config/crew.json: this trigger runs inside OpenClaw's script sandbox and cannot import local modules.
// 这个脚本不读 trigger.state、不读任务消息、不接受任何从外面传进来的路径或目录名：下面的常量就是全部输入。
const DATA_ROOT = "/opt/solofleet-data";
const PROJECT_ROOT = "/opt/solofleet";
const WORKSPACE_ROOT = "/opt/solofleet/runtime"; // config paths.workspaceRoot: <WORKSPACE_ROOT>/<agentId>/
const TIMEZONE = "UTC"; // config timezone (IANA name); the daily-audit cut-off time below is local time in this zone
const CLAUDE_ROOT = "/home/example/.claude/projects";
const CONFIG_FILE = "/home/example/.openclaw/openclaw.json";
const AGENTS_ROOT = "/home/example/.openclaw/agents"; // API 通路角色的会话在 <AGENTS_ROOT>/<角色>/agent/openclaw-agent.sqlite

const CUT_H = 18, CUT_M = 5; // daily audit scheduled time 18:05 local (config jobs.dailyAudit.time)
// 目录白名单：配置里除 desktop（桌面角色本来就要动桌面）和 system-auditor（审计自己）以外的每个角色都抽。
// 每个角色的工作区必须正好是下面算出来的固定位置；有一个对不上、编号写法不对、角色数不在 1～MAX_ROLES 之间，整份停，不读任何会话记录。
const EXCLUDE = ["desktop", "system-auditor"];
const ID_OK = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ROLES = 30;
const expectWs = (r) => WORKSPACE_ROOT + "/" + r;
let ROLES = []; // 读完配置、核完才定；按编号排序
const KEYWORDS = ["screencapture", "osascript", "cliclick", "open -a", "peekaboo"];
const CMD_HEAD = 4000, CMD_KEEP = 400, CMD_OUT = 120, MAX_LINES = 500, ROLE_SHOW = 100, TOLERANCE = 1;
// 桌面角色（desktop）也抽，但判法不同——她的命令全部列出；命中动屏幕关键字标 ⚠；不在白名单也没命中关键字的标"非白名单"（只作线索）。
const DESKTOP = "desktop", DESKTOP_SHOW = 300;
const DESKTOP_KEYWORDS = [...KEYWORDS, "System Events", "tell application", "displaysleepnow", "killall", "open "];
const DESKTOP_WHITELIST = [
  /desktop-lock\.mjs\s+(release|wait|skip|status)\b/,
  /\bioreg\b[^|]*\b(AppleClamshellState|CGSSessionScreenIsLocked)\b|\bioreg\b.*\|\s*grep.*(AppleClamshellState|CGSSessionScreenIsLocked)/,
  /^\s*system_profiler\s+SPDisplaysDataType\b/,
  /^\s*date\b/,
  /^\s*(ls|cat|mkdir|cp)\b.*runtime\/desktop/,
];
const SQLITE_BIN = "/usr/bin/sqlite3";
// CMD_HEAD：关键字命中对命令前 4000 字符判断（和旧版一样）；CMD_KEEP：正文只带回前 400 字符（体量控制）；ROLE_SHOW：每个角色最多带回 100 条正文，命中关键字的行不受限。
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// Claude 会话记录的目录名：工作区绝对路径里的 "/" 和每个非 ASCII 字符都换成 "-"
const dirName = (ws) => Array.from(ws).map((c) => (c === "/" || c.codePointAt(0) > 127 ? "-" : c)).join("");
const mask = (s) => s
  .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [已遮蔽]")
  .replace(/\b(sk|pk|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "[已遮蔽]")
  .replace(/\b(token|password|passwd|secret|apikey|api_key)\s*[=:]\s*\S+/gi, "$1=[已遮蔽]")
  .replace(/[A-Za-z0-9+\/_=-]{24,}/g, "[已遮蔽]");

const now = typeof FAKE_NOW === "undefined" ? new Date() : new Date(FAKE_NOW); // FAKE_NOW 只在测试台里定义
const tzParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const tzOffset = (ms) => { const p = tzParts(ms); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
const dayOf = (ms) => { const p = tzParts(ms); return { y: +p.year, m: +p.month, d: +p.day }; };
// epoch ms of local wall time (two passes handle offset changes near the guess)
const localMs = (y, m, d, h, mi) => { const g = Date.UTC(y, m - 1, d, h, mi, 0); let ms = g - tzOffset(g); ms = g - tzOffset(ms); return ms; };
const t0 = dayOf(now.getTime());
let cutMs = localMs(t0.y, t0.m, t0.d, CUT_H, CUT_M);
if (cutMs > now.getTime()) { const prev = dayOf(cutMs - 86400000); cutMs = localMs(prev.y, prev.m, prev.d, CUT_H, CUT_M); }
const bd = dayOf(cutMs);
const pad = (n) => String(n).padStart(2, "0");
const bizDate = `${bd.y}-${pad(bd.m)}-${pad(bd.d)}`;
const offMin = Math.round(tzOffset(cutMs) / 60000);
const offSuffix = `${offMin < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
const cutIso = `${bizDate}T${pad(CUT_H)}:${pad(CUT_M)}:00${offSuffix}`;
const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000Z");
const OUT = `${DATA_ROOT}/审计/日审/${bizDate}-命令抽查.md`;

// 不依赖 Buffer、btoa 等环境提供的函数：自己把文字按 UTF-8 编成 base64
const toBase64 = (str) => {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += T[(n >> 18) & 63] + T[(n >> 12) & 63] + (i + 1 < bytes.length ? T[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? T[n & 63] : "=");
  }
  return out;
};
const NODE_BIN = "/usr/local/bin/node"; // 官方运行时自带的 Node（固定链接，跟着当前版本走）
// 命令抽查文件写完之后，在同一次 exec 里顺带跑文件对账脚本（只读扫描，写 <资料根>/审计/日审/<业务日期>-文件对账.md）。
// 不增加工具调用次数；对账脚本失败不影响命令抽查文件（两段命令用换行隔开，各自报各自的标记：WROTE、SCANOK／SCANFAIL）。
const scanCmd = () => {
  const out = DATA_ROOT + "/审计/日审/" + bizDate + "-文件对账.md";
  const jqWs = `jq -r '.agents.entries | to_entries | map("\\(.key)=\\(.value.workspace)") | join(",")' ${q(CONFIG_FILE)} 2>/dev/null`;
  return `WS=$(${jqWs}); OPENCLAW_DATA_ROOT=${q(DATA_ROOT)} OPENCLAW_RUNTIME_ROOT=${q(WORKSPACE_ROOT)} ${q(NODE_BIN)} ${q(PROJECT_ROOT + "/scripts/automation/project-files.mjs")} scan --date ${bizDate} --out ${q(out)} --workspaces "$WS" >/dev/null 2>&1 && echo SCANOK || echo SCANFAIL`;
};
const writeFile = async (text) => {
  const b64 = toBase64(text);
  const cmd = `printf %s ${q(b64)} | { base64 -D 2>/dev/null || base64 -d; } > ${q(OUT + ".tmp")} && mv -f ${q(OUT + ".tmp")} ${q(OUT)} && echo WROTE\n${scanCmd()}`;
  const r = await exec({ command: cmd });
  const agg = String((r && r.aggregated) ?? "");
  return { ok: !!r && !r.isError && /WROTE/.test(agg), scan: /SCANOK/.test(agg) ? "已生成" : "没生成" };
};
const done = async (text, brief) => {
  const w = await writeFile(text);
  const tail = `文件对账=${w.scan}`;
  return json({ fire: true, message: w.ok ? `命令抽查文件=${OUT}；${brief}；${tail}` : `命令抽查脚本：结果文件没能写出（${OUT}）；${brief}；${tail}；日审写"命令抽查：记录不足（脚本没有生成）"` });
};

const readExtra = async ({ A, B, startMs, cutMs, ws, apiJobs, roleApi, jqCmdsFor }) => {
  const none = (why) => ({ text: `\n## 桌面角色命令与 API 通路命令\n\n记录不足：${why}\n`, hits: [], brief: `桌面角色／API 通路命令：记录不足（${why}）` });
  try {
    const parts = ["echo '=====EXTRA_BEGIN'", `cd ${q(CLAUDE_ROOT)} || { echo 'ERR=cd'; exit 0; }`];
    const deskOk = ws[DESKTOP] !== undefined && ws[DESKTOP] === expectWs(DESKTOP);
    if (deskOk) {
      const d = "./" + dirName(expectWs(DESKTOP));
      parts.push(`echo "=====DESKTOP"\nif [ -d ${q(d)} ]; then cat -- ${q(d)}/*.jsonl 2>/dev/null | jq -n -R -r --arg a ${q(A)} --arg b ${q(B)} --argjson kws ${q(JSON.stringify(DESKTOP_KEYWORDS))} ${q(jqCmdsFor(DESKTOP_SHOW))}; else echo "=====NODIR"; fi`);
    }
    // API 通路角色＝主模型走 API（roleApi），或定时任务走 API（apiJobs 非空）——这样才包含巡查（main）和日审／周审／异常深审（system-auditor）
    const apiRoles = Object.keys(ws).filter((r) => r !== DESKTOP && ID_OK.test(r) && ws[r] === expectWs(r) && (roleApi(r) || (apiJobs[r] ?? []).length > 0)).sort();
    const kwExpr = KEYWORDS.map((k) => `(case when instr(lower(c),lower('${k.replace(/'/g, "''")}'))>0 then '${k.replace(/'/g, "''")},' else '' end)`).join(" || ");
    for (const r of apiRoles) {
      // 主模型走 API 的角色：库里全是 API 会话；只有定时任务走 API 的角色（main、system-auditor）：只取 agent:<角色>:cron:<任务编号> 的会话，免得和订阅会话（~/.claude/projects）重复计数
      const jobs = (apiJobs[r] ?? []).filter((j) => /^[0-9a-f-]{8,40}$/.test(j));
      const sess = roleApi(r) ? "1=1" : "(" + (jobs.length ? jobs.map((j) => `w.session_key like 'agent:${r}:cron:${j}%'`).join(" or ") : "0") + ")";
      const base = `from transcript_events e join session_windows w on w.session_id=e.session_id, json_each(case when json_valid(e.event_json) then e.event_json end,'$.message.content') j where e.event_json is not null and e.message_role='assistant' and e.created_at>=${startMs} and e.created_at<${cutMs} and ${sess} and json_extract(case when j.type='object' then j.value end,'$.type')='toolCall' and json_extract(case when j.type='object' then j.value end,'$.name') in ('exec','Bash','bash','mcp__openclaw__exec')`;
      const sql = `with x as (select e.created_at as ms, substr(json_extract(case when j.type='object' then j.value end,'$.arguments.command'),1,${CMD_HEAD}) as c ${base}), y as (select ms, c, ${kwExpr} as k, row_number() over (order by ms) as rn from x) select strftime('%Y-%m-%dT%H:%M:%SZ', ms/1000,'unixepoch') || char(9) || k || char(9) || (case when length(c)>${CMD_KEEP} then '1' else '0' end) || char(9) || replace(replace(replace(substr(c,1,${CMD_KEEP}),char(10),' '),char(13),' '),char(9),' ') from y where rn<=${ROLE_SHOW} or k<>'' order by ms; with x as (select 1 ${base}) select '=====CMDN ' || count(*) from x; select '=====ZSTD ' || count(*) from transcript_events e join session_windows w on w.session_id=e.session_id where e.event_json is null and e.message_role='assistant' and e.created_at>=${startMs} and e.created_at<${cutMs} and ${sess};`;
      const f = AGENTS_ROOT + "/" + r + "/agent/openclaw-agent.sqlite";
      parts.push(`echo "=====APIROLE ${r}"\nif [ -f ${q(f)} ]; then ${SQLITE_BIN} -readonly -batch ${q(f)} ${q(sql)} 2>/dev/null || echo "=====SQLERR"; else echo "=====NODB"; fi`);
    }
    parts.push("echo '=====EXTRA_END'");
    const r3 = await exec({ command: parts.join("\n") });
    const o3 = String(r3?.aggregated ?? "");
    if (!r3 || r3.isError || /^ERR=cd/m.test(o3) || !/^=====EXTRA_BEGIN\s*$/m.test(o3) || !/^=====EXTRA_END\s*$/m.test(o3)) return none("第 3 次读取失败或结果不完整");
    const sec = {};
    let cur = null;
    for (const line of o3.split("\n")) {
      let m;
      if (line === "=====DESKTOP") { cur = "desktop"; sec[cur] = { cmds: [], n: null, nodir: false }; }
      else if ((m = line.match(/^=====APIROLE (\S+)$/))) { cur = m[1]; sec[cur] = { cmds: [], n: null, zstd: 0, nodb: false, err: false }; }
      else if (!cur || line === "" || line.startsWith("=====EXTRA")) continue;
      else if (line === "=====NODIR") sec[cur].nodir = true;
      else if (line === "=====NODB") sec[cur].nodb = true;
      else if (line === "=====SQLERR") sec[cur].err = true;
      else if ((m = line.match(/^=====CMDN (\d+)$/))) sec[cur].n = +m[1];
      else if ((m = line.match(/^=====ZSTD (\d+)$/))) sec[cur].zstd = +m[1];
      else { const f = line.split("\t"); if (f.length >= 4) sec[cur].cmds.push({ t: f[0], k: f[1] ? f[1].split(",").filter(Boolean) : [], cut: f[2] === "1", c: f.slice(3).join("\t") }); }
    }
    const show = (c, cut) => mask(cut ? String(c).replace(/[A-Za-z0-9+\/_=.~-]+$/, "") : String(c)).slice(0, CMD_OUT).replace(/\s+/g, " ");
    const hits = [];
    let text = "";
    // 桌面角色
    let deskBrief = "桌面角色命令：没读";
    if (!deskOk) text += `\n## 桌面角色（desktop）的命令\n\n记录不足：桌面角色的工作区路径和白名单不符，未取她的会话记录。\n`;
    else if (!sec.desktop || (sec.desktop.n === null && !sec.desktop.nodir)) {
      text += `\n## 桌面角色（desktop）的命令\n\n记录不足：这一段未取得。\n`;
    } else {
      const s = sec.desktop, lines = [], flagged = [], nonWl = [];
      for (const { t, k, cut, c } of s.cmds) {
        const raw = cut ? String(c).replace(/[A-Za-z0-9+\/_=.~-]+$/, "") : String(c);
        const white = DESKTOP_WHITELIST.some((re) => re.test(raw));
        const shown = show(c, cut);
        lines.push(`- ${t} ${shown}`);
        if (k.length) { flagged.push(`- ${t} ⚠ 疑似用命令行动屏幕：命中 ${k.join("、")}；${shown}`); hits.push(`- desktop ${t} ⚠命中：${k.join("、")}；${shown}`); }
        else if (!white) nonWl.push(`- ${t} 非白名单：${shown}`);
      }
      deskBrief = `桌面角色命令 ${s.n ?? s.cmds.length} 条，⚠ ${flagged.length} 条`;
      text += `\n## 桌面角色（desktop）的命令（全部列出；⚠＝命中动屏幕关键字：${DESKTOP_KEYWORDS.join("、")}；"非白名单"只作线索）\n\n共 ${s.n ?? s.cmds.length} 条${s.nodir ? "（她的会话目录不存在）" : ""}。\n\n### ⚠ 疑似用命令行动屏幕\n\n${flagged.length ? flagged.join("\n") : "无"}\n\n### 非白名单（线索）\n\n${nonWl.length ? nonWl.slice(0, 60).join("\n") : "无"}\n\n### 全部\n\n${lines.length ? lines.join("\n") : "无"}\n`;
    }
    // API 通路
    const apiBrief = [];
    let apiText = "";
    for (const r of apiRoles) {
      const s = sec[r];
      if (!s || s.nodb) { apiText += `\n### ${r}\n\n记录不足：${s?.nodb ? "找不到它的事件库文件" : "这一段未取得"}。\n`; apiBrief.push(`${r}:没读`); continue; }
      if (s.err || s.n === null) { apiText += `\n### ${r}\n\n记录不足：事件库读取出错（只读打开失败或格式不认识）。\n`; apiBrief.push(`${r}:读不了`); continue; }
      const lines = [];
      for (const { t, k, cut, c } of s.cmds) {
        const shown = show(c, cut);
        lines.push(`- ${r} ${t} ${k.length ? `命中：${k.join("、")}；` : ""}${shown}`);
        if (k.length) hits.push(`- ${r} ${t} 命中：${k.join("、")}；${shown}（API 通路）`);
      }
      apiText += `\n### ${r}\n\n窗口内命令 ${s.n} 条${s.zstd ? `；另有 ${s.zstd} 条消息压缩存放，没抽查到` : ""}${s.n > s.cmds.length ? `（只列 ${s.cmds.length} 条，命中关键字的全部列出）` : ""}。\n\n${lines.length ? lines.join("\n") : "无"}\n`;
      apiBrief.push(`${r}:${s.n}`);
    }
    text += `\n## 读事件库的 API 通路命令（${apiRoles.length ? apiRoles.join("、") : "无这类角色"}；只读打开各角色的 openclaw-agent.sqlite；主会话走订阅的角色只取定时任务那几个会话）\n${apiText || "\n无\n"}`;
    return { text, hits, brief: `${deskBrief}；API 通路事件库 ${apiBrief.join("、") || "无"}` };
  } catch (e) {
    return none("脚本出错 " + String(e && e.message || e).slice(0, 60));
  }
};

const main = async () => {
  const headOf = (scope) => `# 命令抽查 · ${bizDate}\n\n业务日期：${bizDate}\n窗口：见下（上一个执行完成的日审的截止点 → 本轮截止点 ${cutIso}）\n生成时间：${now.toISOString()}\n范围：${scope}\n说明：只放命令正文（已遮蔽、截到 ${CMD_OUT} 个字符），不放对话内容；脚本自己生成，日审只读本文件。\n`;
  let head = headOf("读不了配置");
  try {
    // 第 1 次工具调用：从配置列出所有角色和 workspace；读上一个执行完成的日审的截止点
    // 第三栏是这个角色主模型的运行方式（`openclaw`＝API 通路，空＝命令行）。API 通路的会话正文不在 ~/.claude/projects，不拿它和会话记录对账。
    const jqCfg = `jq -r '(.agents.defaults.models // {}) as $dm | .agents.entries | to_entries[] | ((.value.model | if type=="object" then .primary else . end) // "" | tostring | sub("@.*$"; "")) as $ref | "\\(.key)\\t\\(.value.workspace // "无")\\t\\(.value.models[$ref].agentRuntime.id // $dm[$ref].agentRuntime.id // "")"' ${q(CONFIG_FILE)}`;
    const jqApiRefs = `jq -r '(.agents.defaults.models // {}) | to_entries[] | select(.value.agentRuntime.id=="openclaw") | .key' ${q(CONFIG_FILE)} 2>/dev/null || true`;
    const cronJobs = `openclaw cron list --all --json 2>/dev/null | sed -n '/^{/,$p' | jq -r '.jobs[]? | select(.payload.kind=="agentTurn" and ((.payload.model // "") != "")) | "\\(.id)\\t\\(.agentId // "main")\\t\\(.payload.model)"' 2>/dev/null || true`;
    const jqRounds = `jq -r 'select(.["执行"]=="完成") | .["截止点"]' ${q(DATA_ROOT + "/审计/日审")}/*.json 2>/dev/null`;
    const r1 = await exec({ command: `${jqCfg}\necho '=====ROUNDS'\n${jqRounds}\necho '=====APIREFS'\n${jqApiRefs}\necho '=====CRONJOBS'\n${cronJobs}\necho '=====END'` });
    const o1 = String(r1?.aggregated ?? "");
    if (!r1 || r1.isError || !/^=====END\s*$/m.test(o1) || !/=====ROUNDS/.test(o1)) {
      return await done(`${head}\n## 结果\n\n命令抽查：记录不足（读不了配置）。未读任何会话记录。\n`, "记录不足：读不了配置");
    }
    const [cfgPart, afterRounds] = o1.split(/^=====ROUNDS\s*$/m);
    const [roundPart, afterRefs = ""] = afterRounds.split(/^=====APIREFS\s*$/m);
    const [refsPart = "", jobsPart = ""] = afterRefs.split(/^=====CRONJOBS\s*$/m);
    const ws = {}, rtOf = {};
    for (const l of cfgPart.split("\n").filter(Boolean)) {
      const f = l.split("\t");
      if (f.length < 2) ws[l] = undefined; else { ws[f[0]] = f[1]; rtOf[f[0]] = f[2] ?? ""; }
    }
    // API 通路的定时任务：任务模型（去掉 @档案名）在"运行方式是 openclaw"的型号名单里。会话号形如 agent:<角色>:cron:<任务编号>…
    const apiRefs = new Set(refsPart.split("\n").map((x) => x.trim()).filter(Boolean));
    const apiJobs = {};
    for (const l of jobsPart.split("\n")) {
      const f = l.split("\t");
      if (f.length < 3 || f[0] === "=====END") continue;
      if (/^[0-9a-f-]{8,40}$/.test(f[0]) && ID_OK.test(f[1]) && apiRefs.has(f[2].trim().replace(/@.*$/, ""))) (apiJobs[f[1]] ??= []).push(f[0]);
    }
    const roleApi = (r) => rtOf[r] === "openclaw";
    const ids = Object.keys(ws).filter((r) => !EXCLUDE.includes(r)).sort();
    if (!ids.includes("main")) {
      return await done(`${head}\n## 结果\n\n命令抽查：记录不足（读不了配置：配置里没有 main）。未读任何会话记录。\n`, "记录不足：读不了配置");
    }
    head = headOf(`${ids.join("、")}（上面的对账不含 desktop、system-auditor；桌面角色和 API 通路命令见后面单独的小节）`);
    if (ids.length < 1 || ids.length > MAX_ROLES) {
      return await done(`${head}\n## 结果\n\n命令抽查：停（角色数 ${ids.length} 不在 1～${MAX_ROLES} 之间），未读任何会话记录。\n`, `停：角色数 ${ids.length} 不在 1～${MAX_ROLES} 之间，未读任何会话记录`);
    }
    const badId = ids.filter((r) => !ID_OK.test(r));
    if (badId.length) {
      return await done(`${head}\n## 结果\n\n命令抽查：停（${badId.join("、")} 的编号写法不对），未读任何会话记录。\n`, `停：${badId.join("、")} 的编号写法不对，未读任何会话记录`);
    }
    const bad = ids.filter((r) => ws[r] !== expectWs(r));
    if (bad.length) {
      return await done(`${head}\n## 结果\n\n命令抽查：停（${bad.join("、")} 的工作区路径和白名单不符），未读任何会话记录。\n`, `停：${bad.join("、")} 的工作区路径和白名单不符，未读任何会话记录`);
    }
    ROLES = ids;
    const cutOf = (s) => Date.parse(s);
    const prev = roundPart.split("\n").map((s) => s.trim()).filter((s) => s && !Number.isNaN(cutOf(s)) && cutOf(s) < cutMs).map(cutOf);
    const startMs = prev.length ? Math.max(...prev) : cutMs - 86400000;
    const A = utc(startMs), B = utc(cutMs);

    // 第 2 次工具调用：白名单目录里只抽命令（时间＋命令），同时按角色取官方记录。
    // 体量控制（输出超 20 万字符 OpenClaw 会丢开头）：官方记录在命令里就压成一行数字；会话命令的关键字命中在命令里判完，正文只带回前 400 字符，每角色最多 100 条（命中关键字的全部带回）。
    const kwJson = JSON.stringify(KEYWORDS);
    // 每行外包一层 try：某一行形状不对（message 是字符串、content 里有字符串元素等）只跳过那一行，不让整个角色变“没读到”
    const jqCmdsFor = (show) => `[inputs | fromjson? | try (select(.type=="assistant" and (.timestamp // "")>=$a and (.timestamp // "")<$b) | .timestamp as $t | (.message.content[]? | objects) | select(.type=="tool_use" and (.name=="mcp__openclaw__exec" or .name=="Bash")) | ((.input.command // "")|tostring|.[0:${CMD_HEAD}]) as $c | {t:$t, k:([$kws[] | select(. as $k | ($c|ascii_downcase) | contains($k|ascii_downcase))]), c:$c}) catch empty] as $x | ($x|to_entries[] | select(.key < ${show} or (.value.k|length) > 0) | .value | [.t, (.k|join(",")), (if (.c|length) > ${CMD_KEEP} then "1" else "0" end), (.c|.[0:${CMD_KEEP}])] | @tsv), "=====CMDN \\($x|length)"`;
    const jqAudit = `(if type=="array" then . else first(.[]? | select(type=="array" and all(.[]; type=="object" or type=="array"))) // null end) as $arr | if $arr == null then "=====AUDIT \\($r) arr=0" else ($arr | [.[] | select(type=="object") | select(((.toolName // .tool_name // .tool) != null) and has("action"))]) as $k | "=====AUDIT \\($r) arr=1 total=\\($arr|length) known=\\($k|length) n=\\([$k[] | select((.action|tostring|test("finished")) and ((.toolName // .tool_name // .tool) | IN("mcp__openclaw__exec","exec")))]|length) api=\\([$k[] | select((.action|tostring|test("finished")) and ((.toolName // .tool_name // .tool) | IN("mcp__openclaw__exec","exec"))) | select($ra or ((.sessionKey // "") as $sk | any($aj[]; . as $j | $sk | test(":cron:" + $j + "(:|$)"))))]|length)" end`;
    const jqCmds = jqCmdsFor(ROLE_SHOW);
    const per = ROLES.map((r) => {
      const d = "./" + dirName(expectWs(r));
      return `echo "=====ROLE ${r}"
if [ -d ${q(d)} ]; then cat -- ${q(d)}/*.jsonl 2>/dev/null | jq -n -R -r --arg a ${q(A)} --arg b ${q(B)} --argjson kws ${q(kwJson)} ${q(jqCmds)}; else echo "=====NODIR"; fi
openclaw audit --agent ${r} --kind tool_action --after ${q(A)} --before ${q(B)} --json --limit 500 2>/dev/null | jq -r --arg r ${q(r)} --argjson ra ${roleApi(r) ? "true" : "false"} --argjson aj ${q(JSON.stringify(apiJobs[r] ?? []))} ${q(jqAudit)} 2>/dev/null || true`;
    }).join("\n");
    const r2 = await exec({ command: `echo '=====BEGIN'\ncd ${q(CLAUDE_ROOT)} || { echo 'ERR=cd'; exit 0; }\n${per}\necho '=====END'` });
    const o2 = String(r2?.aggregated ?? "");
    if (!r2 || r2.isError || /^ERR=cd/m.test(o2)) {
      return await done(`${head}\n## 结果\n\n命令抽查：记录不足（会话记录读取失败或输出被截断）。\n`, "记录不足：会话记录读取失败或输出被截断");
    }
    // 开头、结尾两个标记缺一个，整份写"记录不足"，不再逐角色写误导的"没读到"
    const hasBegin = /^=====BEGIN\s*$/m.test(o2), hasEnd = /^=====END\s*$/m.test(o2);
    if (!hasBegin || !hasEnd) {
      const lost = !hasBegin && !hasEnd ? "开头和结尾标记都丢了" : !hasBegin ? "开头标记丢了" : "结尾标记丢了";
      return await done(`${head}\n## 结果\n\n命令抽查：记录不足（会话记录读取失败或输出被截断：${lost}）。\n`, `记录不足：会话记录读取失败或输出被截断（${lost}）`);
    }
    const sections = {};
    let cur = null, mode = null;
    for (const line of o2.split("\n")) {
      let m;
      if ((m = line.match(/^=====ROLE (\S+)$/))) { cur = m[1]; mode = "cmd"; sections[cur] = { cmds: [], total: null, nodir: false, audit: [] }; }
      else if (line === "=====BEGIN" || line === "") continue;
      else if (line === "=====END") break;
      else if (!cur) continue;
      else if (line === "=====NODIR") { sections[cur].nodir = true; sections[cur].total = 0; }
      else if ((m = line.match(/^=====CMDN (\d+)$/))) sections[cur].total = +m[1];
      else if (/^=====AUDIT /.test(line)) sections[cur].audit.push(line);
      else if (mode === "cmd") { const f = line.split("\t"); if (f.length >= 4) sections[cur].cmds.push({ t: f[0], k: f[1] ? f[1].split(",") : [], cut: f[2] === "1", c: f.slice(3).join("\t") }); }
    }
    // 官方记录：命令里已经压成一行 "=====AUDIT <角色> arr=1 total=N known=N n=N"；判法和旧版 auditCount 逐条一致
    const auditCount = (r) => {
      const lines = sections[r]?.audit ?? [];
      if (!lines.length) return { n: null, why: "官方记录读不了" };
      if (lines.length > 1) return { n: null, why: "官方记录读不了（不是 JSON）" };
      const m = lines[0].match(/^=====AUDIT (\S+) arr=([01])(?: total=(\d+) known=(\d+) n=(\d+)(?: api=(\d+))?)?$/);
      if (!m || m[1] !== r) return { n: null, why: "官方记录读不了" };
      if (m[2] === "0") return { n: null, why: "官方记录读不了（格式不认识）" };
      const total = +m[3], known = +m[4], n = +m[5], api = Math.min(+(m[6] ?? 0), +m[5]);
      if (total >= MAX_LINES) return { n: null, why: "官方记录读不了（达到单页上限 500，可能不全）" };
      if (total && !known) return { n: null, why: "官方记录读不了（格式不认识）" };
      return { n, api }; // n＝官方 exec 总数；api＝其中走 API 通路的（会话正文不在命令行记录里，不对账）
    };
    // 第 3 次工具调用：桌面角色的会话命令＋API 通路角色的事件库命令。失败只让这一段写"记录不足"，不影响上面的结果。
    const extra = await readExtra({ A, B, startMs, cutMs, ws, apiJobs, roleApi, jqCmdsFor });
    const rows = [], hits = [], all = [], apiRows = [];
    let totalCmds = 0;
    for (const r of ROLES) {
      const s = sections[r];
      if (!s || s.total === null) { rows.push(`| ${r} | ? | ? | 记录不足：这个角色的结果没读到 |`); continue; }
      const m = s.total, a = auditCount(r);
      // 官方记录里走 API 通路的那部分（角色整个走 API，或定时任务走 API）单列，不和命令行会话记录对账、也不判"记录不足"；其余照旧对账。
      const apiN = a.n === null ? 0 : a.api, cliN = a.n === null ? null : a.n - apiN;
      let verdict;
      if (a.n === null) verdict = `记录不足：${a.why}`;
      else if (m === 0 && cliN === 0) verdict = "本轮没有命令行调用";
      else if (Math.abs(m - cliN) <= TOLERANCE) verdict = Math.abs(m - cliN) === 0 ? "对得上" : "对得上（差 1，窗口边缘）";
      else verdict = `记录不足：条数对不上（官方 ${cliN}、会话记录 ${m}）`;
      if (apiN > 0) apiRows.push(`- ${r}：官方 ${apiN} 条，API 通路，明细见下面“读事件库的 API 通路命令”一节`);
      rows.push(`| ${r} | ${m} | ${a.n === null ? "读不了" : cliN} | ${verdict}${apiN > 0 ? `（API 通路另列 ${apiN} 条）` : ""} |`);
      totalCmds += m;
      for (const { t, k, cut, c } of s.cmds) {
        // 命令在 400 字符处被截断时，去掉末尾可能被切半的一截"像密钥的字符"，免得半截密钥漏过遮蔽
        const raw = cut ? String(c).replace(/[A-Za-z0-9+\/_=.~-]+$/, "") : String(c);
        const hit = k;
        const shown = mask(raw).slice(0, CMD_OUT).replace(/\s+/g, " ");
        all.push(`- ${r} ${t} ${shown}`);
        if (hit.length) hits.push(`- ${r} ${t} 命中：${hit.join("、")}；${shown}`);
      }
    }
    for (const l of extra.hits) hits.push(l);
    const body = `${head}\n窗口（UTC）：${A} → ${B}\n\n## 条数对账\n\n| 角色 | 会话记录里的命令数 | 官方记录里的命令数 | 结论 |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n## API 通路（单列：不和会话记录对账；API 通路的会话正文不在命令行记录里，命令明细见下面“读事件库的 API 通路命令”一节）\n\n${apiRows.length ? apiRows.join("\n") : "无"}\n\n## 命中关键字（${KEYWORDS.join("、")}）\n\n${hits.length ? hits.slice(0, MAX_LINES).join("\n") : "无"}\n\n## 全部命令（共 ${totalCmds} 条；每个角色最多列 ${ROLE_SHOW} 条，命中关键字的全部列出${all.length > MAX_LINES ? `；超过 ${MAX_LINES} 行，只写前 ${MAX_LINES} 行` : ""}）\n\n${all.length ? all.slice(0, MAX_LINES).join("\n") : "无"}\n${extra.text}`;
    const short = rows.filter((x) => x.includes("记录不足")).length;
    return await done(body, `命中关键字 ${hits.length} 条；${short} 个角色记录不足；共 ${totalCmds} 条命令；${extra.brief}`);
  } catch (e) {
    return json({ fire: true, message: `命令抽查脚本出错：${String(e && e.message || e).slice(0, 80)}；日审写"命令抽查：记录不足（脚本出错）"` });
  }
};
await main();
