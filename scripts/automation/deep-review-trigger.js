// Condition script for the anomaly deep review (read-only check, writes nothing). OpenClaw trigger script: exec({command}) returns command output, json({...}) returns the result.
// Two tool calls in total (official budget: 5 calls, 30 seconds).
// EDIT THE CONSTANTS to match config/crew.json: this runs inside OpenClaw's script sandbox and cannot import local modules.
const DATA_ROOT = "/opt/solofleet-data";
const TIMEZONE = "UTC"; // config timezone (IANA name)
const CUT_HOUR = 19; // scheduled time 19:00 local (config jobs.deepReview.time)
const LOCALE = "en"; // config "locale": "en" or "zh-CN". This trigger cannot import lexicon.mjs, so the words it needs are in the table below (keep it in step with lexicon.mjs: tests/trigger-literals-consistency.test.mjs checks it).
const LX = ({
  "zh-CN": { audit: "审计", flags: "异常标记", deep: "异常深审" },
  "en": { audit: "audit", flags: "anomaly-flags", deep: "deep-review" },
})[LOCALE];
const MARK_DIR = DATA_ROOT + "/" + LX.audit + "/" + LX.flags;
const RUN_DIR = DATA_ROOT + "/" + LX.audit + "/" + LX.deep;
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// 业务日期和截止点：往前最近的一个 19:00（含当刻）所在的本地日期
const now = typeof FAKE_NOW === "undefined" ? new Date() : new Date(FAKE_NOW); // FAKE_NOW 只在测试台里定义
const tzParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const tzOffset = (ms) => { const p = tzParts(ms); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000; };
const dayOf = (ms) => { const p = tzParts(ms); return { y: +p.year, m: +p.month, d: +p.day }; };
const localMs = (y, m, d, h, mi) => { const g = Date.UTC(y, m - 1, d, h, mi, 0); let ms = g - tzOffset(g); ms = g - tzOffset(ms); return ms; };
const t0 = dayOf(now.getTime());
let cutMs = localMs(t0.y, t0.m, t0.d, CUT_HOUR, 0);
if (cutMs > now.getTime()) { const prev = dayOf(cutMs - 86400000); cutMs = localMs(prev.y, prev.m, prev.d, CUT_HOUR, 0); }
const bd = dayOf(cutMs);
const pad = (n) => String(n).padStart(2, "0");
const bizDate = `${bd.y}-${pad(bd.m)}-${pad(bd.d)}`;
const offMin = Math.round(tzOffset(cutMs) / 60000);
const offSuffix = `${offMin < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
const cutoff = `${bizDate}T${pad(CUT_HOUR)}:00:00${offSuffix}`;
const head = `业务日期=${bizDate}；截止点=${cutoff}`;
const incomplete = (why) => json({ fire: true, message: `条件检查读取不完整：${why}；${head}；请自己去查标记目录 ${MARK_DIR}` });

const main = async () => {
try {
  // 第 1 次工具调用：只读状态不是"已深审"的标记（允许冒号前后有空格），连同文件名、总数和未完成数
  const cmd1 = [
    `cd ${q(MARK_DIR)} 2>/dev/null || { echo 'ERR=cd'; exit 0; }`,
    `ls -1 -- *.json >/dev/null 2>&1 || { echo 'TOTAL=0'; echo 'NONDONE=0'; echo '=====END'; exit 0; }`,
    `echo "TOTAL=$(ls -1 -- *.json | wc -l | tr -d ' ')"`,
    `LIST=$(grep -L -E '"状态"[[:space:]]*:[[:space:]]*"已深审' -- *.json 2>/dev/null)`,
    `if [ -z "$LIST" ]; then echo 'NONDONE=0'; else echo "NONDONE=$(printf '%s\\n' "$LIST" | wc -l | tr -d ' ')"; printf '%s\\n' "$LIST" | while IFS= read -r f; do echo "=====FILE $f"; cat -- "$f"; echo; done; fi`,
    `echo '=====END'`,
  ].join("\n");
  const r1 = await exec({ command: cmd1 });
  if (!r1 || r1.isError) return incomplete("读取标记目录的命令失败");
  const out = String(r1.aggregated ?? "");
  if (/^ERR=cd/m.test(out)) return incomplete("进不了标记目录");
  if (!/^=====END\s*$/m.test(out)) return incomplete("输出被截断（没有读到结尾标记）");
  const total = +((out.match(/^TOTAL=(\d+)/m) || [])[1] ?? NaN);
  const nondone = +((out.match(/^NONDONE=(\d+)/m) || [])[1] ?? NaN);
  if (!Number.isInteger(total) || !Number.isInteger(nondone)) return incomplete("读不到文件总数");
  const blocks = out.split(/^=====FILE /m).slice(1).map((b) => {
    const nl = b.indexOf("\n");
    return { name: b.slice(0, nl).trim(), body: b.slice(nl + 1).replace(/^=====END\s*$/m, "").trim() };
  });
  if (blocks.length !== nondone) return incomplete(`读到 ${blocks.length} 个文件，应有 ${nondone} 个（总数 ${total}）`);

  const pending = [], carry = [];
  for (const b of blocks) {
    let j;
    try { j = JSON.parse(b.body); } catch { return incomplete(`文件 ${b.name} 解析不了`); }
    const st = String(j["状态"] ?? "");
    if (st === "待深审") {
      const t = Date.parse(String(j["发现时间"] ?? ""));
      if (Number.isNaN(t)) return incomplete(`文件 ${b.name} 的发现时间读不出`);
      if (t < Date.parse(cutoff)) pending.push(b.name);
    } else if (st.startsWith("深审中")) {
      const m = st.match(/(\d{4}-\d{2}-\d{2})/);
      carry.push({ name: b.name, date: m ? m[1] : null });
    } else {
      return incomplete(`文件 ${b.name} 的状态读不出（${st.slice(0, 20)}）`);
    }
  }

  // 第 2 次工具调用（只有存在"深审中"的标记才做）：读那一天的本轮记录，判断只补收尾还是接着审
  const carryTxt = [];
  if (carry.length) {
    const dates = [...new Set(carry.map((c) => c.date).filter(Boolean))];
    const cmd2 = dates.map((d) => `echo "=====REC ${d}"; cat -- ${q(RUN_DIR + "/" + d + ".json")} 2>/dev/null && echo || echo '=====MISSING'`).join("\n") + "\necho '=====END'";
    const r2 = dates.length ? await exec({ command: cmd2 }) : null;
    const o2 = r2 && !r2.isError ? String(r2.aggregated ?? "") : "";
    for (const c of carry) {
      let how = "未能判断（读不到那一天的本轮记录，请深审自己查）";
      if (c.date && /^=====END\s*$/m.test(o2)) {
        const seg = o2.split(new RegExp(`^=====REC ${c.date}\\s*$`, "m"))[1];
        if (seg !== undefined) {
          const body = seg.split(/^=====(?:REC|END)/m)[0];
          if (!/=====MISSING/.test(body)) {
            try { how = JSON.parse(body.trim())["执行"] === "完成" ? "只补收尾（本轮已完成，不重审内容）" : "接着审（本轮记录不是完成）"; } catch { /* 保持"未能判断" */ }
          }
        }
      }
      carryTxt.push(`${c.name}（${how}）`);
    }
  }

  if (!pending.length && !carry.length) return json({ fire: false });
  return json({ fire: true, message: `${head}；待审=${pending.join("，") || "无"}；待接=${carryTxt.join("，") || "无"}` });
} catch (e) {
  return incomplete(`脚本出错：${String(e && e.message || e).slice(0, 80)}`);
}
};
await main(); // 用函数包一层，里面的 return 不依赖官方怎样包装脚本
