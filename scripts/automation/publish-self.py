# -*- coding: utf-8 -*-
# Publishes a finished daily summary file to the workshop channel, verbatim (the model never writes the message). Fixed script: it accepts only a task name and a business date.
# Usage: /usr/bin/python3 -I <this file> <task name> <business date>
#   任务名只认：巡查、异常深审、周审；业务日期 YYYY-MM-DD（周审必须是周日）。
# 只用 Python 自带库。不收正文、不收路径、不收收件人。

# Publishes a finished daily summary file to the workshop channel, verbatim (the model never writes the message).
# Usage: python3 -I publish-self.py <task name> <business date YYYY-MM-DD>   (offline test: publish-self-test.py)
import json as _json
import os as _os


def _load_crew():
    here = _os.path.dirname(_os.path.abspath(__file__))
    for p in (_os.environ.get("SOLOFLEET_CONFIG"),
              _os.path.join(here, "..", "..", "config", "crew.json"),
              _os.path.join(here, "..", "..", "config", "crew.example.json")):
        if p and _os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return _json.load(f)
    return {}


_CREW = _load_crew()
_P = _CREW.get("paths", {})
_J = _CREW.get("jobs", {})

# Words and file names that follow config "locale" ("en" by default, or "zh-CN"). The same words are in
# plugins/personal-inbox/lexicon.mjs (the lexicon is the master; tests/publish-table-consistency.test.mjs
# compares the two). zh-CN holds exactly the literals this script always used.
LEX_ALL = {
    "zh-CN": {
        "audit": "审计", "publish": "发布", "receipts": "凭据",
        "tasks": {
            "patrol": {"name": "巡查", "dir": "巡查", "label": "【巡查 · {d}】", "report_line": "完整报告：资料/审计/巡查/{d}-报告.md", "report_file": "{d}-报告.md", "job": "patrol", "cut": "18:30"},
            "deepReview": {"name": "异常深审", "dir": "异常深审", "label": "【审计 · 异常深审 · {d}】", "report_line": "完整报告：资料/审计/异常深审/{d}.md", "report_file": "{d}.md", "job": "deepReview", "cut": "19:00"},
            "weekly": {"name": "周审", "dir": "周审", "label": "【审计 · 周审 · {d}】", "report_line": "完整报告：资料/审计/周审/{d}.md", "report_file": "{d}.md", "job": "weeklyAudit", "cut": "19:00"},
        },
        "files": {"summary": "-摘要.txt", "receipt": ".回执.txt", "failed": ".校验失败.json"},
        "states": {"sending": "发送中", "delivered": "已送达", "toVerify": "待核"},
        "receipt": {"task": "任务", "businessDate": "业务日期", "account": "账号", "channel": "频道", "target": "目标", "state": "状态", "messageId": "消息编号", "digest": "摘要指纹", "receiptFile": "回执文件", "receiptTime": "回执时间", "reason": "原因", "time": "时间", "unconfirmedId": "回执里的编号_未确认"},
        "record": {"task": "任务", "businessDate": "业务日期", "cutoff": "截止点", "execution": "执行"},
        "record_done": "完成",
    },
    "en": {
        "audit": "audit", "publish": "publish", "receipts": "receipts",
        "tasks": {
            "patrol": {"name": "patrol", "dir": "patrol", "label": "[Patrol · {d}]", "report_line": "Full report: dataroot/audit/patrol/{d}-report.md", "report_file": "{d}-report.md", "job": "patrol", "cut": "18:30"},
            "deepReview": {"name": "deep-review", "dir": "deep-review", "label": "[Audit · Deep review · {d}]", "report_line": "Full report: dataroot/audit/deep-review/{d}.md", "report_file": "{d}.md", "job": "deepReview", "cut": "19:00"},
            "weekly": {"name": "weekly-audit", "dir": "weekly", "label": "[Audit · Weekly audit · {d}]", "report_line": "Full report: dataroot/audit/weekly/{d}.md", "report_file": "{d}.md", "job": "weeklyAudit", "cut": "19:00"},
        },
        "files": {"summary": "-summary.txt", "receipt": ".receipt.txt", "failed": ".validation-failed.json"},
        "states": {"sending": "sending", "delivered": "delivered", "toVerify": "to-verify"},
        "receipt": {"task": "task", "businessDate": "business_date", "account": "account", "channel": "channel", "target": "target", "state": "state", "messageId": "message_id", "digest": "digest", "receiptFile": "receipt_file", "receiptTime": "receipt_time", "reason": "reason", "time": "time", "unconfirmedId": "receipt_message_id_unconfirmed"},
        "record": {"task": "task", "businessDate": "business_date", "cutoff": "cutoff", "execution": "execution"},
        "record_done": "done",
    },
}
LOCALE = _CREW.get("locale", "en")
LX = LEX_ALL.get(LOCALE, LEX_ALL["en"])
RK = LX["receipt"]


def _cut(job, default):
    """Scheduled time (HH:MM, local) of a job from config jobs.<job>.time; the round the summary belongs to is cut off there."""
    return (_J.get(job, {}) or {}).get("time", default)


# ===== 常量（正式版；离线副本只改这一段）=====
SCRIPT_VERSION = "B1-自发-正式版-1"
DATA_ROOT = _P.get("dataRoot", "")
CRED_DIR = DATA_ROOT + "/" + LX["audit"] + "/" + LX["publish"] + "/" + LX["receipts"]
NODE = _P.get("nodeBin", "node")
OPENCLAW_ENTRY = _P.get("openclawInstallDir", "") + "/dist/entry.js"
ACCOUNT = "default"
CHANNEL = "discord"
TARGET = "channel:" + _CREW.get("channels", {}).get("workshop", "")
SEND_TIMEOUT_SECONDS = 180
TEST_HOOK_DIR = None  # 正式版为 None（关）；只有离线副本设成临时目录
EFFECTIVE_FROM = (_CREW.get("jobs", {}).get("publishSelf", {}) or {}).get("effectiveFrom", {})  # first business date each task may be published (unset = refuse)
TIMEZONE = _CREW.get("timezone", "UTC")  # IANA zone; the cut-off time is local time in it
# ===== 常量结束 =====

import datetime
import zoneinfo
import hashlib
import json
import os
import re
import subprocess
import sys
import time

TASKS = {
    v["name"]: {"dir": LX["audit"] + "/" + v["dir"], "label": v["label"], "report_line": v["report_line"], "report_file": v["report_file"], "cut": _cut(v["job"], v["cut"])}
    for v in LX["tasks"].values()
}
WEEKLY_TASK = LX["tasks"]["weekly"]["name"]
ST = LX["states"]
STATES = (ST["sending"], ST["delivered"], ST["toVerify"])
MSGID_RE = re.compile(r"^[0-9]{17,20}$")
CAP = 65536


def say(line, code):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    sys.exit(code)


def hook(name):
    """测试专用停点和出错注入。实测版 TEST_HOOK_DIR 为 None，什么都不做。"""
    if not TEST_HOOK_DIR:
        return
    if os.path.exists(os.path.join(TEST_HOOK_DIR, "fail-" + name)):
        raise OSError("测试注入出错：" + name)
    if os.path.exists(os.path.join(TEST_HOOK_DIR, "arm-" + name)):
        with open(os.path.join(TEST_HOOK_DIR, "reached-" + name), "w") as f:
            f.write(str(os.getpid()))
        deadline = time.time() + 60
        while not os.path.exists(os.path.join(TEST_HOOK_DIR, "release-" + name)):
            if time.time() > deadline:
                break
            time.sleep(0.02)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def parse_args(argv):
    if len(argv) != 3:
        return None, "参数个数不对（只收任务名和业务日期两个）"
    task, d = argv[1], argv[2]
    if task not in TASKS:
        return None, "任务名不认识"
    if not re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", d):
        return None, "业务日期格式不对"
    try:
        day = datetime.date(int(d[0:4]), int(d[5:7]), int(d[8:10]))
    except ValueError:
        return None, "业务日期不存在"
    if task == WEEKLY_TASK and day.weekday() != 6:
        return None, "周审业务日期不是周日"
    return (task, d), None


def paths(task, d):
    t = TASKS[task]
    base = os.path.join(DATA_ROOT, t["dir"])
    return {
        "record": os.path.join(base, d + ".json"),
        "report": os.path.join(base, t["report_file"].format(d=d)),
        "summary": os.path.join(base, d + LX["files"]["summary"]),
        "cred": os.path.join(CRED_DIR, task + "-" + d + ".json"),
        "receipt": os.path.join(CRED_DIR, task + "-" + d + LX["files"]["receipt"]),
        "fail": os.path.join(CRED_DIR, task + "-" + d + LX["files"]["failed"]),
    }


def check_business(task, d, p):
    """返回 (摘要字节, 摘要文本, None) 或 (字节或None, None, 原因)。摘要文件只读这一次。"""
    t = TASKS[task]
    try:
        with open(p["record"], "rb") as f:
            rec = json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return None, None, "本轮记录不存在"
    except Exception:
        return None, None, "本轮记录读不懂"
    if not isinstance(rec, dict):
        return None, None, "本轮记录读不懂"
    cutoff = datetime.datetime.strptime("%s %s" % (d, t["cut"]), "%Y-%m-%d %H:%M").replace(tzinfo=zoneinfo.ZoneInfo(TIMEZONE)).isoformat(timespec="seconds")
    RC = LX["record"]
    if rec.get(RC["task"]) != task:
        return None, None, "本轮记录的任务不对"
    if rec.get(RC["businessDate"]) != d:
        return None, None, "本轮记录的业务日期不对"
    if rec.get(RC["cutoff"]) != cutoff:
        return None, None, "本轮记录的截止点不对"
    if rec.get(RC["execution"]) != LX["record_done"]:
        return None, None, "本轮记录不是完成"
    if not os.path.isfile(p["report"]):
        return None, None, "完整报告不存在"
    try:
        with open(p["summary"], "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return None, None, "摘要文件不存在"
    reason = check_summary_bytes(task, d, raw)
    if reason:
        return raw, None, reason
    return raw, raw.decode("utf-8"), None


def check_summary_bytes(task, d, raw):
    t = TASKS[task]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return "摘要不是 UTF-8"
    if "\r" in text:
        return "摘要含回车符"
    body = text.rstrip("\n")
    if not body.strip():
        return "摘要是空的"
    lines = body.split("\n")
    if len(lines) > 12:
        return "摘要超过 12 行（%d 行）" % len(lines)
    if len(body) > 1200:
        return "摘要超过 1200 字（%d 字）" % len(body)
    if "```" in body:
        return "摘要含 ```"
    if lines[0] != t["label"].format(d=d):
        return "摘要第一行标签不对"
    if lines[-1] != t["report_line"].format(d=d):
        return "摘要最后一行不是本轮的完整报告行"
    return None


def judge_existing(task, d, p):
    """读已有凭据（只读），返回 (是否已送达, 状态说明, 凭据dict或None)。"""
    try:
        with open(p["cred"], "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return None
    try:
        c = json.loads(raw.decode("utf-8"))
    except Exception:
        return (False, "读不懂（%d 字节）" % len(raw), None)
    if not isinstance(c, dict):
        return (False, "读不懂", None)
    st = c.get(RK["state"])
    ok = (c.get(RK["task"]) == task and c.get(RK["businessDate"]) == d and c.get(RK["account"]) == ACCOUNT
          and c.get(RK["channel"]) == CHANNEL and c.get(RK["target"]) == TARGET and st in STATES)
    if not ok:
        return (False, "字段对不上（状态 %s）" % st, c)
    if st != ST["delivered"]:
        return (False, st, c)
    mid = c.get(RK["messageId"])
    if not (isinstance(mid, str) and MSGID_RE.match(mid)) or not os.path.isfile(p["receipt"]):
        return (False, "已送达但编号或回执不合格", c)
    return (True, ST["delivered"], c)


def report_existing(task, d, p, ex):
    delivered, desc, c = ex
    if not delivered:
        say("待核：已有发布凭据（状态 %s），不发" % desc, 3)
    line = "已送达（消息编号 %s），不重发" % c[RK["messageId"]]
    try:
        with open(p["summary"], "rb") as f:
            cur = f.read()
        if hashlib.sha256(cur).hexdigest() != c.get(RK["digest"]):
            line += "；摘要内容已变，不当新消息发"
        r = check_summary_bytes(task, d, cur)
        if r:
            line += "；现在的摘要也不合格：" + r
    except FileNotFoundError:
        line += "；现在的摘要文件不见了"
    except Exception:
        line += "；现在的摘要读不了"
    say(line, 0)


def write_fail_record(p, reason, raw):
    try:
        os.makedirs(CRED_DIR, exist_ok=True)
        rec = {RK["time"]: now_iso(), RK["reason"]: reason,
               RK["digest"]: hashlib.sha256(raw).hexdigest() if raw is not None else None,
               "脚本版本": SCRIPT_VERSION}
        tmp = p["fail"] + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p["fail"])
    except Exception:
        pass


def parse_receipt(rc, out):
    """Five fixed checks written against the installed OpenClaw implementation。返回 (编号, handledBy, None) 或 (None, None, 原因)。"""
    if rc != 0:
        return None, None, "退出码 %s" % rc
    try:
        obj = json.loads(out.strip())
    except Exception:
        return None, None, "标准输出不是恰好一个 JSON"
    if not isinstance(obj, dict):
        return None, None, "标准输出不是 JSON 对象"
    if obj.get("action") != "send" or obj.get("channel") != "discord":
        return None, None, "不是 Discord 发送动作"
    if obj.get("dryRun") is not False:
        return None, None, "dryRun 不是 false"
    for k in ("ok", "error", "deliveryStatus", "sentBeforeError"):
        if k in obj:
            return None, None, "带失败标志字段 %s" % k
    pl = obj.get("payload")
    if not isinstance(pl, dict) or pl.get("ok") is False:
        return None, None, "payload 不是对象或 ok 为 false"
    hb = obj.get("handledBy")
    if hb not in ("core", "plugin"):
        return None, None, "handledBy 不认识"
    mid = obj.get("messageId")
    if not (isinstance(mid, str) and MSGID_RE.match(mid)):
        return None, None, "顶层 messageId 不合格"
    inner = pl.get("messageId")
    if inner is None and isinstance(pl.get("result"), dict):
        inner = pl["result"].get("messageId")
    if inner != mid:
        return None, None, "顶层编号和 payload 里的不一致"
    return mid, hb, None


def main():
    args, why = parse_args(sys.argv)
    if why:
        say("未发：参数不对：" + why, 2)
    task, d = args
    # 生效轮次：未设或早于起始日 → 不发，不写任何文件
    eff = EFFECTIVE_FROM.get(task)
    if eff is None:
        say("未发：生效轮次未设", 2)
    if d < eff:
        say("未发：早于生效轮次（%s），这一轮按旧投递处理" % eff, 2)
    p = paths(task, d)

    # 第 2 步：先看凭据（只读）
    ex = judge_existing(task, d, p)
    if ex is not None:
        report_existing(task, d, p, ex)

    # 第 3 步：业务是否完成；摘要只读一次
    raw, text, why = check_business(task, d, p)
    if why:
        write_fail_record(p, why, raw)
        say("未发：校验不通过：" + why, 2)
    fp = hashlib.sha256(raw).hexdigest()

    # 第 4 步：原子取得发送资格
    os.makedirs(CRED_DIR, exist_ok=True)
    try:
        fd = os.open(p["cred"], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        ex = judge_existing(task, d, p)
        if ex is None:
            say("待核：发布凭据一闪而过，不发", 3)
        report_existing(task, d, p, ex)
    started = now_iso()
    cred = {RK["state"]: ST["sending"], RK["task"]: task, RK["businessDate"]: d, RK["digest"]: fp, RK["account"]: ACCOUNT,
            RK["channel"]: CHANNEL, RK["target"]: TARGET, "开始时间": started, "进程号": os.getpid(),
            "脚本版本": SCRIPT_VERSION}
    data = json.dumps(cred, ensure_ascii=False, indent=1).encode("utf-8")
    try:
        hook("after_create")
        hook("write")
        half = len(data) // 2
        os.write(fd, data[:half])
        hook("mid_write")
        os.write(fd, data[half:])
        hook("fsync")
        os.fsync(fd)
        os.close(fd)
        fd = None
        fsync_dir(CRED_DIR)
    except Exception:
        try:
            if fd is not None:
                os.close(fd)
        except Exception:
            pass
        say("待核：发布凭据没写完整，不发", 3)
    hook("after_cred_fsync")

    # 第 5 步：发送（正文就是第 3 步那份）
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(NODE) + ":" + env.get("PATH", "/usr/bin:/bin")
    env["OPENCLAW_NO_AUTO_UPDATE"] = "1"
    env["NO_COLOR"] = "1"
    cmd = [NODE, OPENCLAW_ENTRY, "message", "send", "--channel", CHANNEL, "--account", ACCOUNT,
           "--target", TARGET, "--message", text, "--json"]
    t0 = time.time()
    rc, out, err, timed_out = None, b"", b"", False
    try:
        cp = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=SEND_TIMEOUT_SECONDS)
        rc, out, err = cp.returncode, cp.stdout, cp.stderr
    except subprocess.TimeoutExpired as e:
        timed_out = True
        out, err = e.stdout or b"", e.stderr or b""
    except Exception as e:
        err = ("启动发送命令出错：%s" % type(e).__name__).encode("utf-8")
    took = round(time.time() - t0, 2)
    hook("after_send")

    # 第 6 步：认回执并记结果
    out_s = out.decode("utf-8", "replace")
    if timed_out:
        mid, hb, why = None, None, "超时（%d 秒）" % SEND_TIMEOUT_SECONDS
    elif rc is None:
        mid, hb, why = None, None, "发送命令没能启动"
    else:
        mid, hb, why = parse_receipt(rc, out_s)
    receipt = ("时间：%s\n退出码：%s\n用时秒：%s\n超时：%s\n判定：%s\n===== 标准输出（前 64KB）=====\n%s\n===== 标准错误（前 64KB）=====\n%s\n" % (
        now_iso(), rc, took, timed_out, ST["delivered"] if mid else "待核：" + why,
        out[:CAP].decode("utf-8", "replace"), err[:CAP].decode("utf-8", "replace")))
    receipt_ok = True
    try:
        hook("receipt")
        with open(p["receipt"], "w", encoding="utf-8") as f:
            f.write(receipt)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        receipt_ok = False
    final = dict(cred)
    final[RK["receiptTime"]] = now_iso()
    if mid and receipt_ok:
        final.update({RK["state"]: ST["delivered"], RK["messageId"]: mid, "handledBy": hb, RK["receiptFile"]: os.path.basename(p["receipt"])})
    else:
        final.update({RK["state"]: ST["toVerify"], RK["reason"]: why if not mid else "回执文件写不进"})
        if mid:
            final[RK["unconfirmedId"]] = mid
    tmp = os.path.join(CRED_DIR, "." + os.path.basename(p["cred"]) + ".tmp-%d" % os.getpid())
    try:
        hook("replace")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(final, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p["cred"])
        hook("replace_dirfsync")
        fsync_dir(CRED_DIR)
    except Exception as e:
        # 保留磁盘现状：不删、不重发、不覆盖回去；回读留证
        try:
            with open(p["cred"], "rb") as f:
                now_bytes = f.read()[:CAP]
        except Exception as e2:
            now_bytes = ("回读失败：%s" % type(e2).__name__).encode("utf-8")
        try:
            with open(p["receipt"], "a", encoding="utf-8") as f:
                f.write("===== 写凭据出错：%s：%s =====\n===== 出错后回读凭据 =====\n%s\n" % (
                    type(e).__name__, e, now_bytes.decode("utf-8", "replace")))
                f.flush()
                os.fsync(f.fileno())
        except Exception:
            pass
        say("待核：已调用发送，凭据没能完整更新，消息可能已发出，请到频道核", 3)
    if final[RK["state"]] == ST["delivered"]:
        say("已发送（消息编号 %s）" % mid, 0)
    say("待核：发送结果不确定（%s），不重试" % final[RK["reason"]], 3)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        say("待核：脚本出错（%s），请人核" % type(e).__name__, 3)
