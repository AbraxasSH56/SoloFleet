#!/usr/bin/env python3
"""Cross-vendor, read-only review wrapper (generic example).

Why this exists: the development process asks for at least one audit that
comes from a different vendor than the model that wrote the work. This
wrapper runs another vendor's command-line audit tool in read-only mode,
with guard rails around it.

What it does, in order:
  1. Checks the paths and config (report path must be inside REPORT_DIR).
  2. Checks the deny list (paths the auditor must never read) against the
     working tree: every secret-looking file must be covered. Stops if not.
  3. Appends three standard paragraphs to your instruction if it lacks them:
     evidence for every finding, three-class grading, no dangerous VCS commands.
  4. Runs <AUDIT_CLI> read-only (you must replace the example command below).
  5. Checks that nothing in the working tree changed (outside REPORT_DIR) and
     that the report looks complete, then writes the report into REPORT_DIR only.

This is a small example, not a hardened sandbox. The real read-only guarantee
must come from the audit tool's own permission settings; this script checks
that the deny list covers the files that matter and that the tool's settings
file (optional) did not change during the run.

Usage:
  review.py [--dry-run] [--replace] <instruction-file> <report-file>

  --dry-run   do every check, print what would be appended, do not call the tool
  --replace   allow overwriting an existing report (the old one is first copied
              to REPORT_DIR/.replaced/)

Exit codes: 0 ok | 2 usage, config or path error | 4 deny-list or settings
check failed | 5 audit tool failed or timed out | 6 report written but the
working tree changed during the run | 7 report incomplete (written, marked)
"""
import argparse
import fnmatch
import hashlib
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

# --------------------------------------------------------------------------
# CONFIG. Replace the <PLACEHOLDERS> (here or through environment variables).
# --------------------------------------------------------------------------
# The folder to audit. Defaults to the current directory.
WORKDIR = os.path.realpath(os.environ.get("AUDIT_WORKDIR", os.getcwd()))
# The only folder reports may be written to.
REPORT_DIR = os.environ.get("REPORT_DIR", "<REPORT_DIR>")
# Text file, one path per line, relative to WORKDIR. Directories cover everything
# below them. Globs such as *.pem or secrets/* are allowed. Lines starting with # are comments.
DENY_LIST_FILE = os.environ.get("DENY_LIST_FILE", "<DENY_LIST_FILE>")

# EXAMPLE COMMAND ONLY. This is NOT a real tool. Replace <AUDIT_CLI> and its flags with
# the command line of your other-vendor audit tool, in its read-only / no-write mode.
# {workdir}, {deny_list}, {prompt} are filled in by this script; {prompt} is passed as
# ONE argument (no shell is used). The script refuses to run while "<...>" is still here.
AUDIT_CMD = os.environ.get(
    "AUDIT_CMD",
    "<AUDIT_CLI> --read-only --cwd {workdir} --deny-list {deny_list} --prompt {prompt}",
)

# Optional: your audit tool's own settings file. If set, its sha256 must equal
# AUDIT_CLI_CONFIG_SHA256 before and after the run (so nobody loosened it).
AUDIT_CLI_CONFIG = os.environ.get("AUDIT_CLI_CONFIG", "")
AUDIT_CLI_CONFIG_SHA256 = os.environ.get("AUDIT_CLI_CONFIG_SHA256", "")

TIMEOUT_SEC = int(os.environ.get("AUDIT_TIMEOUT_SEC", "2700"))  # 45 minutes
APPEND_LANG = os.environ.get("AUDIT_APPEND_LANG", "en")         # "en" or "zh"
MAX_SCAN_BYTES = 5 * 1024 * 1024

# --------------------------------------------------------------------------
# The three paragraphs appended when the instruction lacks them.
# --------------------------------------------------------------------------
APPEND = {
    "en": {
        "evidence": (
            "Evidence rule: every finding must carry its evidence: the file and line, "
            "the command you ran and what it printed, or the exact text you compared. "
            "A conclusion without evidence counts as a guess; say so and say what is missing."
        ),
        "grading": (
            "Grading: start the report with an overall verdict (pass / conditional pass / fail). "
            "Then label each finding with one class. Class 1 (must fix): will really break "
            "something or violates a stated decision or acceptance rule. Class 2 (note the "
            "boundary): possible in theory, very unlikely, or already covered by another "
            "safeguard; writing down the limit is enough. Class 3 (wording fix): fix when "
            "convenient, does not block the next step. Only Class 1 blocks. Give a reason "
            "for every Class 2 and Class 3 label. If unsure, say \"unsure\" and what is missing."
        ),
        "vcs": (
            "Version-control rule: this is a read-only review. Never run git clean, git reset "
            "--hard, git checkout or git restore that discards changes, git stash, git commit, "
            "git push, or any command that writes. Do not use git show or git log -p to read "
            "files or folders on the deny list. Only inspect; never change anything."
        ),
    },
    "zh": {
        "evidence": (
            "依据规则：每条结论都要带依据：文件和行号、你跑的命令和它的输出，或比对过的原文。"
            "没有依据的结论只算猜测，要说明是猜测并写清缺什么。"
        ),
        "grading": (
            "分级：报告开头先写总判（通过／有条件通过／不通过）。每条发现标一类。"
            "Class 1（必须改）：真会出事，或违反已定的决定和验收标准。Class 2（写明边界就行）："
            "理论上可能、概率极低或已有别的兜底，写清边界即可。Class 3（文字订正）：顺手改，"
            "不挡下一步。只有 Class 1 挡下一步。判成 Class 2、3 的要写理由；拿不准就写“拿不准”并说明缺什么。"
        ),
        "vcs": (
            "版本库规则：这是只读审计。不许运行 git clean、git reset --hard、会丢改动的 git checkout "
            "或 git restore、git stash、git commit、git push，也不许运行任何会写文件的命令。"
            "不许用 git show、git log -p 去看禁读清单里的文件或文件夹。只检查，不修改。"
        ),
    },
}

# --------------------------------------------------------------------------
# Secret-looking files (names, permissions, content). Only file names and the
# kind of match are ever printed, never the matched text.
# --------------------------------------------------------------------------
NAME_RX = re.compile(
    r"(^|/)\.env|secret|credential|token|passw(or)?d|api[-_]?key|keychain|cookie"
    r"|\.(pem|key|p12|pfx|kdbx|sqlite3?|db|jsonl|sock)$|id_(rsa|ed25519|ecdsa)|(^|/)\.(netrc|npmrc)$",
    re.I,
)
EXEMPT_EXT = (".py", ".js", ".mjs", ".ts", ".sh", ".md", ".html", ".css", ".svg",
              ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf")
CONTENT_PATTERNS = [
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("cloud access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("sk- style key", re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{20,}")),
    ("code-host token", re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}")),
    ("chat token", re.compile(r"xox[abprs]-[A-Za-z0-9\-]{10,}")),
    ("secret field with long value", re.compile(
        r"(token|secret|passw(or)?d|api[_-]?key)[\"']?\s*[:=]\s*[\"']?[A-Za-z0-9/+_=\-]{20,}", re.I)),
]
SKIP_DIRS = {".git", "node_modules"}


class Stop(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


def say(msg):
    print(msg, flush=True)


def is_placeholder(value):
    return bool(re.search(r"<[A-Z][A-Z_]*>", value))


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# ---------------------------------------------------------------- paths

def under(path, base):
    path, base = os.path.realpath(path), os.path.realpath(base)
    return path == base or path.startswith(base.rstrip("/") + "/")


def check_config(instr, report):
    """Return the resolved instruction and report paths, or raise Stop(2)."""
    for name, val in (("REPORT_DIR", REPORT_DIR), ("DENY_LIST_FILE", DENY_LIST_FILE)):
        if is_placeholder(val):
            raise Stop(2, "%s is still a placeholder. Set it (environment variable or top of this file)." % name)
    if not os.path.isdir(WORKDIR):
        raise Stop(2, "AUDIT_WORKDIR is not a folder: %s" % WORKDIR)
    if not os.path.isdir(REPORT_DIR):
        raise Stop(2, "REPORT_DIR is not an existing folder: %s" % REPORT_DIR)
    if not os.path.isfile(DENY_LIST_FILE):
        raise Stop(2, "deny list file not found: %s" % DENY_LIST_FILE)
    if not os.path.isfile(instr):
        raise Stop(2, "instruction file not found: %s" % instr)
    rep = os.path.abspath(report)
    if os.path.islink(rep):
        raise Stop(2, "the report path must not be a symlink: %s" % rep)
    if not under(os.path.dirname(rep), REPORT_DIR):
        raise Stop(2, "the report must be written inside REPORT_DIR (%s), not %s" % (REPORT_DIR, rep))
    if not rep.endswith(".md"):
        raise Stop(2, "the report file name must end in .md")
    return os.path.abspath(instr), rep


# ---------------------------------------------------------------- deny list

def load_deny_list():
    entries = []
    with open(DENY_LIST_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                entries.append(line)
    if not entries:
        raise Stop(4, "the deny list is empty: %s" % DENY_LIST_FILE)
    return entries


def covered(rel, entries):
    """True if the relative path (or a parent folder of it) matches a deny entry."""
    parts = rel.split("/")
    for e in entries:
        e = e.rstrip("/")
        glob = any(c in e for c in "*?[")
        for i in range(1, len(parts) + 1):
            prefix = "/".join(parts[:i])
            if glob:
                if fnmatch.fnmatch(prefix, e) or ("/" not in e and fnmatch.fnmatch(parts[i - 1], e)):
                    return True
            elif prefix == e:
                return True
    return False


def scan_uncovered(entries):
    """Find secret-looking files that no deny entry covers. Returns (list of (path, why), count)."""
    bad, n = [], 0
    for dp, dns, fns in os.walk(WORKDIR):
        rel_dir = os.path.relpath(dp, WORKDIR)
        dns[:] = [d for d in dns if d not in SKIP_DIRS
                  and not covered(os.path.normpath(os.path.join(rel_dir, d)), entries)]
        for name in fns:
            rel = os.path.normpath(os.path.join(rel_dir, name))
            if covered(rel, entries):
                continue
            n += 1
            full = os.path.join(dp, name)
            if os.path.islink(full):
                if not under(full, WORKDIR):
                    bad.append((rel, "symlink pointing outside the working folder"))
                continue
            exempt = name.lower().endswith(EXEMPT_EXT)
            try:
                st = os.stat(full)
            except OSError:
                continue
            if NAME_RX.search(rel) and not exempt:
                bad.append((rel, "name looks like a secret"))
            elif (st.st_mode & 0o077) == 0 and (st.st_mode & 0o400) and not exempt:
                bad.append((rel, "owner-only permissions (600/400)"))
            elif st.st_size > MAX_SCAN_BYTES:
                if not name.lower().endswith(EXEMPT_EXT):
                    bad.append((rel, "too large to scan"))
            elif not name.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".md")):
                try:
                    with open(full, "rb") as f:
                        text = f.read().decode("utf-8", errors="ignore")
                except OSError:
                    continue
                for kind, rx in CONTENT_PATTERNS:
                    if rx.search(text):
                        bad.append((rel, "content looks like: " + kind))
                        break
    return bad, n


def check_cli_config():
    if not AUDIT_CLI_CONFIG:
        return []
    if not AUDIT_CLI_CONFIG_SHA256:
        return ["AUDIT_CLI_CONFIG is set but AUDIT_CLI_CONFIG_SHA256 is not"]
    try:
        now = sha256_file(AUDIT_CLI_CONFIG)
    except OSError as e:
        return ["cannot read the audit tool settings file: %s" % e]
    if now != AUDIT_CLI_CONFIG_SHA256.lower():
        return ["the audit tool settings file differs from the pinned sha256"]
    return []


def pre_checks(entries):
    probs = check_cli_config()
    bad, n = scan_uncovered(entries)
    for rel, why in bad:
        probs.append("not covered by the deny list: %s (%s)" % (rel, why))
    return probs, n


# ---------------------------------------------------------------- instruction

def build_append(instr_text):
    """Return (names of added parts, text to append)."""
    t = APPEND.get(APPEND_LANG, APPEND["en"])
    low = instr_text.lower()
    added, parts = [], []
    if not re.search(r"evidence|依据", low):
        added.append("evidence")
        parts.append(t["evidence"])
    if not (re.search(r"class [123]", low) or all(c in instr_text for c in "①②③")):
        added.append("grading")
        parts.append(t["grading"])
    if "git clean" not in low and "reset --hard" not in low:
        added.append("vcs")
        parts.append(t["vcs"])
    return added, "\n\n".join(parts)


# ---------------------------------------------------------------- change check

def git_state():
    try:
        r = subprocess.run(["git", "-C", WORKDIR, "status", "--porcelain"],
                           capture_output=True, text=True, timeout=60)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None


def changed_since(marker):
    """Files in WORKDIR (outside REPORT_DIR) modified after the marker time."""
    out = []
    for dp, dns, fns in os.walk(WORKDIR):
        dns[:] = [d for d in dns if d not in SKIP_DIRS and not under(os.path.join(dp, d), REPORT_DIR)]
        for name in fns:
            p = os.path.join(dp, name)
            try:
                if os.lstat(p).st_mtime > marker:
                    out.append(os.path.relpath(p, WORKDIR))
            except OSError:
                pass
    return out


# ---------------------------------------------------------------- report

def report_problems(text):
    probs = []
    if len(text.strip()) < 200:
        probs.append("report is very short")
    if not re.search(r"overall (verdict|conclusion)|verdict\s*:|总判|总结论", text, re.I):
        probs.append("no overall verdict")
    if not re.search(r"class [123]|①|②|③|no findings", text, re.I):
        probs.append("no grading labels")
    return probs


def write_report(path, text, replace):
    if os.path.lexists(path):
        if not replace:
            raise Stop(2, "report already exists (use --replace): %s" % path)
        backup_dir = os.path.join(REPORT_DIR, ".replaced")
        os.makedirs(backup_dir, exist_ok=True)
        shutil.copy2(path, os.path.join(backup_dir, "%s.%d" % (os.path.basename(path), int(time.time()))))
    tmp = path + ".tmp%d" % os.getpid()
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ---------------------------------------------------------------- main

def main(argv):
    ap = argparse.ArgumentParser(description="Cross-vendor read-only review wrapper (example).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--replace", action="store_true")
    ap.add_argument("instruction_file")
    ap.add_argument("report_file")
    args = ap.parse_args(argv)

    instr, report = check_config(args.instruction_file, args.report_file)
    entries = load_deny_list()
    say("1. Checking the deny list against the working tree ...")
    probs, n = pre_checks(entries)
    if probs:
        raise Stop(4, "checks failed, stopping (nothing was run):\n  " + "\n  ".join(probs))
    say("   %d files checked; every secret-looking file is covered by the deny list." % n)

    with open(instr, encoding="utf-8") as f:
        instr_text = f.read()
    added, extra = build_append(instr_text)
    say("2. Standard paragraphs appended: %s" % (", ".join(added) if added else "none needed"))

    if args.dry_run:
        if extra:
            say("\n--- text that would be appended ---\n" + extra)
        say("(--dry-run: the audit tool was not called.)")
        return 0

    if is_placeholder(AUDIT_CMD):
        raise Stop(2, "AUDIT_CMD still contains <AUDIT_CLI>. Put your audit tool's read-only command there.")

    prompt = ("Read the instruction file %s, then follow it exactly. Work inside the current "
              "folder, read-only. Your final reply is the report body." % instr)
    if extra:
        prompt += "\n\nThe following rules apply as well and are as binding as the instruction file:\n\n" + extra
    argv_cmd = [tok.replace("{workdir}", WORKDIR).replace("{deny_list}", os.path.abspath(DENY_LIST_FILE))
                .replace("{prompt}", prompt) for tok in shlex.split(AUDIT_CMD)]

    git0, marker = git_state(), time.time()
    say("3. Running the audit tool (read-only), time limit %d s ..." % TIMEOUT_SEC)
    try:
        r = subprocess.run(argv_cmd, cwd=WORKDIR, capture_output=True, text=True, timeout=TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        raise Stop(5, "the audit tool did not finish in %d s and was stopped" % TIMEOUT_SEC)
    except OSError as e:
        raise Stop(5, "could not start the audit tool: %s" % e)
    if r.returncode != 0:
        raise Stop(5, "the audit tool exited with code %d. Its error output (first lines):\n%s"
                   % (r.returncode, "\n".join((r.stderr or "").splitlines()[:20])))

    # Check the working tree before writing the report (the report itself lives in REPORT_DIR).
    notes = check_cli_config()
    changed = changed_since(marker)
    if changed:
        notes.append("files changed in the working tree during the run: " + ", ".join(changed[:20]))
    if git0 is not None and git_state() != git0:
        notes.append("git status differs from before the run")

    text, code = r.stdout, 0
    problems = report_problems(text)
    if problems:
        code = 7
        text = "> INCOMPLETE REPORT (%s). Run again before relying on it.\n\n%s" % ("; ".join(problems), text)
    write_report(report, text, args.replace)
    say("4. Report written: %s" % report)
    if notes:
        say("WARNING (the audit was meant to be read-only):\n  " + "\n  ".join(notes))
        code = code or 6
    if code == 7:
        say("The report is marked INCOMPLETE: " + "; ".join(problems))
    return code


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as e:
        print(e.msg, file=sys.stderr)
        sys.exit(e.code)
