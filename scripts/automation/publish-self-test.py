# -*- coding: utf-8 -*-
# Offline test bench for publish-self.py (fake sender, never touches Discord).
# B1 自发正式版 · 离线测试台。不碰官方、不发消息。
# 用法：/usr/bin/python3 -I publish-self-test.py [正式脚本路径] [运行目录]；默认测同目录的 publish-self.py，运行目录默认在 /tmp 下新建。
# 加 --slow 才跑 170 秒／200 秒两例（约 6 分钟）。
import hashlib, json, os, re, shutil, signal, subprocess, sys, threading, time

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
SLOW = "--slow" in sys.argv
REAL = ARGS[0] if ARGS else os.path.join(os.path.dirname(os.path.abspath(__file__)), "publish-self.py")
import tempfile
BASE = ARGS[1] if len(ARGS) > 1 else tempfile.mkdtemp(prefix="publish-self-test-")
RUNS = os.path.join(BASE, "runs")
PY = "/usr/bin/python3"
results = []
# the target the script derives from config/crew.json (channels.workshop)
import importlib.util
_spec = importlib.util.spec_from_file_location('publish_self_real', REAL)
_mod = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(_mod)
EXPECT_TARGET = _mod.TARGET

FAKE = r'''# -*- coding: utf-8 -*-
import json, os, sys, time
H = HOOKDIR
mode = open(os.path.join(H, "mode")).read().strip()
a = sys.argv[1:]
msg = a[a.index("--message") + 1]
def count():
    fd = os.open(os.path.join(H, "count"), os.O_CREAT | os.O_WRONLY | os.O_APPEND)
    os.write(fd, b"x\n"); os.close(fd)
    n = len(open(os.path.join(H, "count")).read().splitlines())
    open(os.path.join(H, "msg-%d.bin" % n), "wb").write(msg.encode("utf-8"))
    open(os.path.join(H, "argv-%d.json" % n), "w").write(json.dumps(a, ensure_ascii=False))
MID = "100000000000000102"
def ok(payload, hb="core", extra=None):
    o = {"action": "send", "channel": "discord", "dryRun": False, "handledBy": hb}
    if extra: o.update(extra)
    mid = payload.get("messageId") or (payload.get("result") or {}).get("messageId")
    if mid: o["messageId"] = mid
    o["payload"] = payload
    return json.dumps(o, indent=2)
if mode == "sleep":
    time.sleep(10)
if mode == "sleep170_ok":
    time.sleep(170); mode = "ok_core"
if mode == "sleep200":
    count(); time.sleep(200)
count()
out, rc = None, 0
if mode == "ok_core": out = ok({"messageId": MID, "channelId": "100000000000000100"})
elif mode == "ok_result": out = ok({"result": {"messageId": MID}}, hb="plugin")
elif mode == "fail_okfalse": out = json.dumps({"ok": False, "error": {"type": "cli_error", "message": "x"}, "action": "send", "channel": "discord", "dryRun": False, "handledBy": "core", "payload": {}}); rc = 1
elif mode == "fail_delivery": out = json.dumps({"ok": False, "error": {"type": "cli_error", "message": "x"}, "deliveryStatus": "failed", "action": "send", "channel": "discord", "dryRun": False, "handledBy": "core", "payload": {}}); rc = 1
elif mode == "partial": out = json.dumps({"ok": False, "error": {"type": "cli_error", "message": "x"}, "deliveryStatus": "partial_failed", "sentBeforeError": True, "action": "send", "channel": "discord", "dryRun": False, "handledBy": "core", "messageId": MID, "payload": {"messageId": MID}}); rc = 1
elif mode == "dryrun": out = json.dumps({"action": "send", "channel": "discord", "dryRun": True, "handledBy": "core", "payload": {"messageId": MID}, "messageId": MID})
elif mode == "wrong_action": out = ok({"messageId": MID}).replace('"send"', '"poll"')
elif mode == "wrong_channel": out = ok({"messageId": MID}).replace('"discord"', '"telegram"')
elif mode == "no_msgid": out = ok({"channelId": "100000000000000100"})
elif mode == "bad_msgid": out = ok({"messageId": "abc123"})
elif mode == "short_msgid": out = ok({"messageId": "1234567890123456"})
elif mode == "mismatch": out = json.dumps({"action": "send", "channel": "discord", "dryRun": False, "handledBy": "core", "messageId": MID, "payload": {"messageId": "100000000000000103"}})
elif mode == "payload_okfalse": out = ok({"ok": False, "messageId": MID})
elif mode == "extra_text": out = "Sending...\n" + ok({"messageId": MID})
elif mode == "two_json": out = ok({"messageId": MID}) + "\n" + ok({"messageId": MID})
elif mode == "exit1_success": out = ok({"messageId": MID}); rc = 1
elif mode == "exit0_okfalse": out = json.dumps({"ok": False, "error": {"message": "x"}, "action": "send", "channel": "discord", "dryRun": False, "handledBy": "core", "payload": {"messageId": MID}, "messageId": MID})
elif mode == "unknown_hb": out = ok({"messageId": MID}, hb="internal-source")
elif mode == "garbage": out = "%%%garbage%%%"
elif mode == "nonzero": out = ""; rc = 2
else: out = "unknown mode"; rc = 9
sys.stdout.write(out + "\n"); sys.exit(rc)
'''

LABEL = {"巡查": "【巡查 · {d}】", "异常深审": "【审计 · 异常深审 · {d}】", "周审": "【审计 · 周审 · {d}】"}
RLINE = {"巡查": "完整报告：资料/审计/巡查/{d}-报告.md", "异常深审": "完整报告：资料/审计/异常深审/{d}.md", "周审": "完整报告：资料/审计/周审/{d}.md"}
DIR = {"巡查": "审计/巡查", "异常深审": "审计/异常深审", "周审": "审计/周审"}
RFILE = {"巡查": "{d}-报告.md", "异常深审": "{d}.md", "周审": "{d}.md"}
CUT = {"巡查": "18:30", "异常深审": "19:00", "周审": "19:00"}


def summary(task, d, mid_lines):
    return "\n".join([LABEL[task].format(d=d)] + mid_lines + [RLINE[task].format(d=d)]) + "\n"


class Env:
    def __init__(self, name, eff=None, timeout=3):
        self.dir = os.path.join(RUNS, name)
        shutil.rmtree(self.dir, ignore_errors=True)
        self.root = os.path.join(self.dir, "资料根")
        self.cred = os.path.join(self.root, "审计/发布/凭据")
        self.hook = os.path.join(self.dir, "hook")
        os.makedirs(self.hook)
        fake = os.path.join(self.dir, "fake_sender.py")
        open(fake, "w").write(FAKE.replace("HOOKDIR", repr(self.hook)))
        src = open(REAL, encoding="utf-8").read()
        a = src.index("离线副本只改这一段）=====") - len("# ===== 常量（正式版；")
        b = src.index("# ===== 常量结束 =====")
        consts = src[a:b]
        consts = re.sub(r'^DATA_ROOT = .*$', 'DATA_ROOT = %r' % self.root, consts, flags=re.M)
        consts = re.sub(r'^CRED_DIR = .*$', 'CRED_DIR = %r' % self.cred, consts, flags=re.M)
        consts = re.sub(r'^NODE = .*$', 'NODE = %r' % PY, consts, flags=re.M)
        consts = re.sub(r'^OPENCLAW_ENTRY = .*$', 'OPENCLAW_ENTRY = %r' % fake, consts, flags=re.M)
        consts = re.sub(r'^SEND_TIMEOUT_SECONDS = .*$', 'SEND_TIMEOUT_SECONDS = %d' % timeout, consts, flags=re.M)
        if eff is None: eff = {"巡查": "2026-01-01", "异常深审": "2026-01-01", "周审": "2026-01-01"}
        consts = re.sub(r'^EFFECTIVE_FROM = .*$', 'EFFECTIVE_FROM = %r' % (eff if eff != 'NONE' else {"巡查": None, "异常深审": None, "周审": None}), consts, flags=re.M)
        consts = re.sub(r'^TARGET = .*$', 'TARGET = %r' % EXPECT_TARGET, consts, flags=re.M)
        consts = re.sub(r'^TIMEZONE = .*$', 'TIMEZONE = %r' % 'Asia/Kolkata', consts, flags=re.M)
        consts = re.sub(r'^TEST_HOOK_DIR = .*$', 'TEST_HOOK_DIR = %r' % self.hook, consts, flags=re.M)
        self.script = os.path.join(self.dir, "publish-offline.py")
        open(self.script, "w", encoding="utf-8").write(src[:a] + consts + src[b:])
        self.mode("ok_core")

    def mode(self, m):
        open(os.path.join(self.hook, "mode"), "w").write(m)

    def touch(self, name):
        open(os.path.join(self.hook, name), "w").write("1")

    def rm(self, name):
        try: os.remove(os.path.join(self.hook, name))
        except FileNotFoundError: pass

    def round(self, task, d, text=None, complete=True, report=True, cutoff=None, raw=None):
        base = os.path.join(self.root, DIR[task]); os.makedirs(base, exist_ok=True)
        rec = {"任务": task, "业务日期": d, "截止点": cutoff or "%sT%s:00+05:30" % (d, CUT[task]),
               "执行": "完成" if complete else "进行中"}
        json.dump(rec, open(os.path.join(base, d + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
        rp = os.path.join(base, RFILE[task].format(d=d))
        if report: open(rp, "w").write("假报告\n")
        elif os.path.exists(rp): os.remove(rp)
        sp = os.path.join(base, d + "-摘要.txt")
        if raw is not None: open(sp, "wb").write(raw)
        else: open(sp, "w", encoding="utf-8").write(text if text is not None else summary(task, d, ["这是 B1 发布实测，不是真实摘要。", "离线样例。"]))
        return sp

    def run(self, *args):
        cp = subprocess.run([PY, "-I", self.script] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
        return cp.returncode, cp.stdout.decode("utf-8", "replace").strip(), cp.stderr.decode("utf-8", "replace").strip()

    def popen(self, *args):
        return subprocess.Popen([PY, "-I", self.script] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)

    def count(self):
        p = os.path.join(self.hook, "count")
        return len(open(p).read().splitlines()) if os.path.exists(p) else 0

    def credp(self, task, d): return os.path.join(self.cred, "%s-%s.json" % (task, d))

    def credraw(self, task, d):
        p = self.credp(task, d)
        return open(p, "rb").read() if os.path.exists(p) else None

    def cred_json(self, task, d):
        r = self.credraw(task, d)
        try: return json.loads(r.decode("utf-8"))
        except Exception: return None

    def wait_reached(self, name, t=20):
        end = time.time() + t
        while time.time() < end:
            if os.path.exists(os.path.join(self.hook, "reached-" + name)): return True
            time.sleep(0.02)
        return False


def check(case, cond, detail):
    results.append({"例": case, "通过": bool(cond), "细节": detail})
    print(("PASS " if cond else "FAIL ") + case + " | " + detail)


def main():
    shutil.rmtree(RUNS, ignore_errors=True); os.makedirs(RUNS)
    T, D = "异常深审", "2026-10-01"

    # A 参数
    e = Env("A")
    e.round(T, D)
    for args, nm in [((), "无参数"), ((T, D, "x"), "多一个参数"), ((T, "2026-1-01"), "日期格式不对"),
                     ((T, "2026-02-30"), "不存在的日期"), (("周审", "2026-10-01"), "周审不是周日"), (("日审", D), "任务名不认识")]:
        rc, out, err = e.run(*args)
        check("A 参数-" + nm, rc == 2 and out.startswith("未发：参数不对") and e.count() == 0 and not os.path.exists(e.cred) and err == "", "rc=%s out=%s" % (rc, out))

    # B 校验不通过，修好后再发
    bad = {
        "13行": dict(text=summary(T, D, ["第%d行" % i for i in range(11)])),
        "1201字": dict(text=summary(T, D, ["字" * (1201 - len(LABEL[T].format(d=D)) - len(RLINE[T].format(d=D)) - 2)])),
        "标签不对": dict(text=summary(T, D, ["x"]).replace("异常深审 · ", "深审 · ")),
        "末行不对": dict(text=summary(T, D, ["x"]).replace(".md", "-报告.md")),
        "本轮记录不是完成": dict(complete=False),
        "截止点不对": dict(cutoff="2026-10-01T18:30:00+05:30"),
        "报告缺失": dict(report=False),
        "不是UTF-8": dict(raw=summary(T, D, ["中文"]).encode("gbk")),
        "含三个反引号": dict(text=summary(T, D, ["```代码```"])),
    }
    for nm, kw in bad.items():
        e = Env("B-" + nm)
        e.round(T, D, **kw)
        rc, out, err = e.run(T, D)
        fr = os.path.join(e.cred, "%s-%s.校验失败.json" % (T, D))
        check("B 校验不通过-" + nm, rc == 2 and out.startswith("未发：校验不通过") and e.count() == 0 and e.credraw(T, D) is None and os.path.exists(fr), "rc=%s out=%s" % (rc, out))
        e.round(T, D)
        rc, out, err = e.run(T, D)
        c = e.cred_json(T, D)
        check("B 修好后再发-" + nm, rc == 0 and out.startswith("已发送") and e.count() == 1 and c and c["状态"] == "已送达", "rc=%s out=%s" % (rc, out))
    # 1200 字正好合格（边界）
    e = Env("B-1200字正好")
    body_fill = 1200 - len(LABEL[T].format(d=D)) - len(RLINE[T].format(d=D)) - 2
    e.round(T, D, text=summary(T, D, ["字" * body_fill]))
    rc, out, err = e.run(T, D)
    check("B 正好1200字、3行可发", rc == 0 and e.count() == 1, "rc=%s out=%s" % (rc, out))
    e = Env("B-12行正好")
    e.round(T, D, text=summary(T, D, ["第%d行" % i for i in range(10)]))
    rc, out, err = e.run(T, D)
    check("B 正好12行可发", rc == 0 and e.count() == 1, "rc=%s out=%s" % (rc, out))

    # C 回执样例
    for m in ["ok_core", "ok_result"]:
        e = Env("C-" + m); e.round(T, D); e.mode(m)
        rc, out, err = e.run(T, D); c = e.cred_json(T, D)
        check("C 成功回执-" + m, rc == 0 and out == "已发送（消息编号 100000000000000102）" and c["状态"] == "已送达" and c["消息编号"] == "100000000000000102" and c["handledBy"] == ("core" if m == "ok_core" else "plugin"), "rc=%s out=%s" % (rc, out))
        rc, out, err = e.run(T, D)
        check("C 成功后重跑不重发-" + m, rc == 0 and out.startswith("已送达（消息编号") and e.count() == 1, "rc=%s out=%s" % (rc, out))
    for m in ["fail_okfalse", "fail_delivery", "partial", "dryrun", "wrong_action", "wrong_channel", "no_msgid", "bad_msgid", "short_msgid",
              "mismatch", "payload_okfalse", "extra_text", "two_json", "exit1_success", "exit0_okfalse", "unknown_hb", "garbage", "nonzero", "sleep"]:
        e = Env("C-" + m); e.round(T, D); e.mode(m)
        rc, out, err = e.run(T, D); c = e.cred_json(T, D)
        rp = os.path.join(e.cred, "%s-%s.回执.txt" % (T, D))
        n1 = e.count()
        check("C 不合格回执判待核-" + m, rc == 3 and out.startswith("待核：发送结果不确定") and c and c["状态"] == "待核" and os.path.exists(rp) and "消息编号" not in c,
              "rc=%s out=%s 原因=%s" % (rc, out, c and c.get("原因")))
        rc, out, err = e.run(T, D)
        check("C 待核后重跑不重试-" + m, rc == 3 and out.startswith("待核：已有发布凭据") and e.count() == n1, "rc=%s out=%s 计数=%d" % (rc, out, e.count()))

    # D 20 个进程同时
    e = Env("D"); e.round(T, D)
    ps = [e.popen(T, D) for _ in range(20)]
    outs = [p.communicate(timeout=120) for p in ps]
    lines = [o[0].decode("utf-8").strip() for o in outs]
    sent = [l for l in lines if l.startswith("已发送")]
    others_ok = all(l.startswith("已发送") or l.startswith("已送达") or l.startswith("待核") for l in lines)
    check("D 20进程同时", e.count() == 1 and len(sent) == 1 and others_ok, "发送计数=%d 已发送=%d 其余：%s" % (e.count(), len(sent), sorted(set(l[:14] for l in lines))))

    # E 确定停点
    def stop_case(name, point, expect_count, check_file):
        e = Env("E-" + name); e.round(T, D); e.touch("arm-" + point)
        p = e.popen(T, D)
        reached = e.wait_reached(point)
        os.killpg(p.pid, signal.SIGKILL); p.wait()
        raw = e.credraw(T, D); cnt = e.count()
        ok1 = reached and cnt == expect_count and check_file(raw)
        e.rm("arm-" + point)
        rc, out, err = e.run(T, D)
        check("E 停点-" + name, ok1 and rc == 3 and out.startswith("待核：已有发布凭据") and e.count() == expect_count,
              "到达=%s 杀后计数=%d 凭据=%s 再调用 rc=%s out=%s 计数=%d" % (reached, cnt, (raw[:40] if raw else raw), rc, out, e.count()))
    def is_sending(raw):
        try: return json.loads(raw.decode("utf-8"))["状态"] == "发送中"
        except Exception: return False
    stop_case("凭据已写盘还没发送", "after_cred_fsync", 0, is_sending)
    stop_case("已发送还没存回执", "after_send", 1, is_sending)
    stop_case("凭据建了还没写", "after_create", 0, lambda r: r == b"")
    def half(r):
        try: json.loads(r.decode("utf-8")); return False
        except Exception: return r is not None and len(r) > 0
    stop_case("凭据写到一半", "mid_write", 0, half)
    for pt, nm in [("write", "写入出错"), ("fsync", "刷盘出错")]:
        e = Env("E-" + nm); e.round(T, D); e.touch("fail-" + pt)
        rc, out, err = e.run(T, D); raw = e.credraw(T, D)
        e.rm("fail-" + pt)
        rc2, out2, err2 = e.run(T, D)
        check("E 注入-" + nm, rc == 3 and out == "待核：发布凭据没写完整，不发" and e.count() == 0 and raw is not None and rc2 == 3 and out2.startswith("待核：已有发布凭据") and e.count() == 0,
              "rc=%s out=%s 凭据长度=%s 再调用=%s" % (rc, out, len(raw) if raw is not None else None, out2))

    # F 发出后写凭据出事
    e = Env("F-替换凭据出错"); e.round(T, D); e.touch("fail-replace")
    rc, out, err = e.run(T, D); c = e.cred_json(T, D)
    rtxt = open(os.path.join(e.cred, "%s-%s.回执.txt" % (T, D)), encoding="utf-8").read()
    e.rm("fail-replace"); rc2, out2, _ = e.run(T, D)
    check("F 替换凭据出错（目录只读等）", rc == 3 and out.startswith("待核：已调用发送，凭据没能完整更新") and c["状态"] == "发送中" and "出错后回读凭据" in rtxt and e.count() == 1 and rc2 == 3 and e.count() == 1,
          "rc=%s out=%s 状态=%s 再调用=%s" % (rc, out, c["状态"], out2))
    e = Env("F-替换后目录刷盘出错"); e.round(T, D); e.touch("fail-replace_dirfsync")
    rc, out, err = e.run(T, D); c = e.cred_json(T, D)
    rtxt = open(os.path.join(e.cred, "%s-%s.回执.txt" % (T, D)), encoding="utf-8").read()
    e.rm("fail-replace_dirfsync"); rc2, out2, _ = e.run(T, D)
    check("F replace成功后目录刷盘出错：保留新内容不覆盖回去", rc == 3 and c["状态"] == "已送达" and "出错后回读凭据" in rtxt and '"状态": "已送达"' in rtxt and e.count() == 1 and rc2 == 0 and out2.startswith("已送达") and e.count() == 1,
          "rc=%s out=%s 状态=%s 再调用=%s" % (rc, out, c["状态"], out2))
    e = Env("F-回执写不进"); e.round(T, D); e.touch("fail-receipt")
    rc, out, err = e.run(T, D); c = e.cred_json(T, D)
    check("F 回执写不进判待核", rc == 3 and c["状态"] == "待核" and c.get("回执里的编号_未确认") == "100000000000000102" and e.count() == 1, "rc=%s out=%s" % (rc, out))

    # G 已送达后改摘要
    e = Env("G"); e.round(T, D); e.run(T, D)
    e.round(T, D, text=summary(T, D, ["这是 B1 发布实测，不是真实摘要。", "换了一份仍合格的摘要。"]))
    rc, out, _ = e.run(T, D)
    check("G 改成另一份合格摘要", rc == 0 and out.startswith("已送达（消息编号") and "摘要内容已变，不当新消息发" in out and "也不合格" not in out and e.count() == 1, out)
    e.round(T, D, text=summary(T, D, ["第%d行" % i for i in range(11)]))
    rc, out, _ = e.run(T, D)
    check("G 改成不合格摘要", rc == 0 and "摘要内容已变" in out and "现在的摘要也不合格：摘要超过 12 行" in out and e.count() == 1, out)

    # H 凭据被改坏
    for nm, mut in [("缺字段", lambda c: c.pop("账号")), ("账号不对", lambda c: c.update({"账号": "other-account"})),
                    ("编号不合格", lambda c: c.update({"消息编号": "12ab"})), ("状态不认识", lambda c: c.update({"状态": "完成"}))]:
        e = Env("H-" + nm); e.round(T, D); e.run(T, D)
        c = e.cred_json(T, D); mut(c)
        open(e.credp(T, D), "w", encoding="utf-8").write(json.dumps(c, ensure_ascii=False))
        h1 = hashlib.sha256(e.credraw(T, D)).hexdigest()
        rc, out, _ = e.run(T, D)
        h2 = hashlib.sha256(e.credraw(T, D)).hexdigest()
        check("H 凭据被改坏-" + nm, rc == 3 and out.startswith("待核：已有发布凭据") and h1 == h2 and e.count() == 1, out)

    # I 正文原样
    e = Env("I-特殊字符")
    txt = summary(T, D, ['引号 "双" \'单\'', "命令 $(rm -rf /tmp/x) 和 `反引号` 和 ${HOME}", "    行首四个空格", "\t行首一个制表符", "请visit https://example.invalid/guide"])
    sp = e.round(T, D, text=txt)
    rc, out, _ = e.run(T, D)
    got = open(os.path.join(e.hook, "msg-1.bin"), "rb").read()
    check("I 特殊字符逐字相同", rc == 0 and got == open(sp, "rb").read(), "rc=%s 相同=%s" % (rc, got == open(sp, "rb").read()))
    e = Env("I-发送中改文件"); sp = e.round(T, D); orig = open(sp, "rb").read()
    e.touch("arm-after_cred_fsync"); p = e.popen(T, D); e.wait_reached("after_cred_fsync")
    e.round(T, D, text=summary(T, D, ["中途被改掉的内容"])); e.touch("release-after_cred_fsync"); p.communicate(timeout=60)
    got = open(os.path.join(e.hook, "msg-1.bin"), "rb").read(); c = e.cred_json(T, D)
    check("I 发送前改摘要，发出的仍是读到的那份", got == orig and c["摘要指纹"] == hashlib.sha256(orig).hexdigest(), "相同=%s" % (got == orig))

    # J 替换不留空档
    e = Env("J"); e.round(T, D); e.touch("arm-after_send")
    p = e.popen(T, D); e.wait_reached("after_send")
    seen = {"bad": 0, "n": 0, "states": set()}
    stop = threading.Event()
    def reader():
        while not stop.is_set():
            r = e.credraw(T, D); seen["n"] += 1
            try: seen["states"].add(json.loads(r.decode("utf-8"))["状态"])
            except Exception: seen["bad"] += 1
    th = threading.Thread(target=reader); th.start(); time.sleep(0.2)
    e.touch("release-after_send"); p.communicate(timeout=60); time.sleep(0.2); stop.set(); th.join()
    check("J 替换凭据时随时读得到完整凭据", seen["bad"] == 0 and seen["states"] == {"发送中", "已送达"}, "读了%d次 坏%d 见到状态%s" % (seen["n"], seen["bad"], sorted(seen["states"])))

    # K 周审周日可发；巡查路径
    e = Env("K-周审"); e.round("周审", "2026-10-04")
    rc, out, _ = e.run("周审", "2026-10-04")
    check("K 周审周日可发", rc == 0 and e.count() == 1, out)
    e = Env("K-巡查"); e.round("巡查", "2026-10-04")
    rc, out, _ = e.run("巡查", "2026-10-04")
    check("K 巡查可发、参数清单正确", rc == 0 and json.load(open(os.path.join(e.hook, "argv-1.json")))[:8] == ["message", "send", "--channel", "discord", "--account", "default", "--target", EXPECT_TARGET], out)

    npass = sum(r["通过"] for r in results)
    print("合计 %d 例，通过 %d，失败 %d" % (len(results), npass, len(results) - npass))
    extra()
    npass = sum(r["通过"] for r in results)
    print("含新增合计 %d 例，通过 %d，失败 %d" % (len(results), npass, len(results) - npass))
    json.dump({"时间": time.strftime("%F %T %z"), "被测脚本": REAL, "运行目录": BASE, "被测脚本指纹": hashlib.sha256(open(REAL, "rb").read()).hexdigest(), "结果": results},
              open(os.path.join(BASE, "离线结果.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)



def extra():
    T, D = "巡查", "2026-10-05"
    # G1 生效轮次未设：三个任务都拒发，不写任何文件
    e = Env("X-生效未设", eff="NONE")
    for task, d in [("巡查", "2026-10-05"), ("异常深审", "2026-10-05"), ("周审", "2026-10-04")]:
        e.round(task, d)
        rc, out, err = e.run(task, d)
        check("X 生效轮次未设-" + task, rc == 2 and out == "未发：生效轮次未设" and e.count() == 0 and not os.path.exists(e.cred), out)
    # G2 早于／等于／晚于起始日
    e = Env("X-早于", eff={"巡查": "2026-10-05", "异常深审": "2026-10-05", "周审": "2026-10-11"})
    e.round(T, "2026-10-04"); rc, out, _ = e.run(T, "2026-10-04")
    check("X 早于起始日拒发", rc == 2 and out.startswith("未发：早于生效轮次（2026-10-05）") and e.count() == 0 and not os.path.exists(e.cred), out)
    e.round(T, "2026-10-05"); rc, out, _ = e.run(T, "2026-10-05")
    check("X 等于起始日正常发", rc == 0 and out.startswith("已发送") and e.count() == 1, out)
    e.round(T, "2026-10-06"); rc, out, _ = e.run(T, "2026-10-06")
    check("X 晚于起始日正常发", rc == 0 and out.startswith("已发送") and e.count() == 2, out)
    e.round("周审", "2026-10-04"); rc, out, _ = e.run("周审", "2026-10-04")
    check("X 周审早于起始日拒发", rc == 2 and "早于生效轮次" in out and e.count() == 2, out)
    # G4 判定表 10 例：脚本再调用的判断
    def mk(name):
        e = Env("X-判定-" + name); e.round(T, D); e.run(T, D); return e
    def recall(e): return e.run(T, D)
    e = mk("1合格"); rc, out, _ = recall(e)
    check("判定 1 合格已送达", rc == 0 and out.startswith("已送达") and "已变" not in out, out)
    for nm, mut in [("2目标不对", lambda c: c.update({"目标": "channel:100000000000000100"})),
                    ("3缺编号", lambda c: c.pop("消息编号"))]:
        e = mk(nm); c = e.cred_json(T, D); mut(c); open(e.credp(T, D), "w", encoding="utf-8").write(json.dumps(c, ensure_ascii=False))
        rc, out, _ = recall(e)
        check("判定 " + nm, rc == 3 and out.startswith("待核：已有发布凭据") and e.count() == 1, out)
    e = mk("4缺回执"); os.replace(os.path.join(e.cred, "%s-%s.回执.txt" % (T, D)), os.path.join(e.dir, "回执挪开.txt"))
    rc, out, _ = recall(e); check("判定 4 缺回执", rc == 3 and "编号或回执不合格" in out and e.count() == 1, out)
    e = mk("4b回执是目录"); rp = os.path.join(e.cred, "%s-%s.回执.txt" % (T, D)); os.replace(rp, os.path.join(e.dir, "回执挪开.txt")); os.makedirs(rp)
    rc, out, _ = recall(e); check("判定 4b 回执是同名目录", rc == 3 and "编号或回执不合格" in out and e.count() == 1, out)
    e = mk("5指纹变"); e.round(T, D, text=summary(T, D, ["这是 B1 发布实测，不是真实摘要。", "改过的内容。"]))
    rc, out, _ = recall(e); check("判定 5 指纹变化", rc == 0 and "摘要内容已变，不当新消息发" in out and e.count() == 1, out)
    e = Env("X-判定-6发送中"); e.round(T, D); e.touch("arm-after_cred_fsync"); p = e.popen(T, D); e.wait_reached("after_cred_fsync"); os.killpg(p.pid, signal.SIGKILL); p.wait(); e.rm("arm-after_cred_fsync")
    rc, out, _ = recall(e); check("判定 6 发送中", rc == 3 and "状态 发送中" in out and e.count() == 0, out)
    e = Env("X-判定-8校验失败"); e.round(T, D, text=summary(T, D, ["第%d行" % i for i in range(11)])); rc1, out1, _ = e.run(T, D)
    rc, out, _ = recall(e); check("判定 8 校验失败且当前失败条件仍在", rc1 == 2 and rc == 2 and "摘要超过 12 行" in out and e.count() == 0 and os.path.exists(os.path.join(e.cred, "%s-%s.校验失败.json" % (T, D))) and e.credraw(T, D) is None, out)
    e = Env("X-判定-10未完成"); e.round(T, D, complete=False); rc, out, _ = recall(e)
    check("判定 10 本轮记录未完成", rc == 2 and "本轮记录不是完成" in out and e.count() == 0, out)
    # 判定 7、9 只核前提：没有凭据、没有校验失败记录（表里不调用发送）
    e = Env("X-判定-7无凭据"); e.round(T, D)
    check("判定 7/9 前提：完成、无凭据、无校验失败记录", e.credraw(T, D) is None and not os.path.exists(e.cred), "只核前提，不调用")
    # G5 时限 180 秒（--slow）
    if SLOW:
        e = Env("X-时限170", timeout=180); e.round(T, D); e.mode("sleep170_ok"); t0 = time.time(); rc, out, _ = e.run(T, D)
        check("X 时限：170 秒返回成功→已送达", rc == 0 and out.startswith("已发送") and e.count() == 1, "rc=%s 用时 %.0f 秒 %s" % (rc, time.time() - t0, out))
        e = Env("X-时限200", timeout=180); e.round(T, D); e.mode("sleep200"); t0 = time.time(); rc, out, _ = e.run(T, D)
        c = e.cred_json(T, D); rc2, out2, _ = e.run(T, D)
        check("X 时限：200 秒→待核、不重试", rc == 3 and "超时（180 秒）" in out and c and c["状态"] == "待核" and rc2 == 3 and e.count() == 1, "rc=%s 用时 %.0f 秒 %s；再调用 %s；发送计数 %d（假发送先计数再睡，模拟已发出但回执超时）" % (rc, time.time() - t0, out, out2, e.count()))


main()
