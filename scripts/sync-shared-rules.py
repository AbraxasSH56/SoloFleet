#!/usr/bin/env python3
"""Shared-rules sync script (Python standard library only).

What it does
  Every bot's AGENTS.md is "head + shared section + tail":
    head            role-specific text, kept per role in rules/roles/<dir>/AGENTS.head[.zh-CN].md
    shared section  the shared rules (rules/shared-rules[.zh-CN].md) with the per-role
                    differences from rules/shared-rules-overrides.json applied
    tail            the "changed-files list" section (rules/shared-tail[.zh-CN].md);
                    roles marked hasTail=false in the overrides file have no tail
  This script keeps the shared section identical in every role's AGENTS.md, records
  fingerprints so a hand edit of a role's own head or tail is noticed, and can generate a
  complete AGENTS.md from scratch.

Inputs
  rules dir     default <repo>/rules (--rules-dir)
  language      --lang en|zh-CN (default en). Each language has its own set of rule files.
                The start marker is the first line of shared-rules*.md and the end marker is
                the first line of shared-tail*.md, so the convention lives in the rule files.
  config        --config, else $SOLOFLEET_CONFIG, else <repo>/config/crew.json, else
                <repo>/config/crew.example.json. The role table is the keys of "bots";
                a role's file is <paths.workspaceRoot>/<agentId>/AGENTS.md.
  placeholders  {{OWNER_TITLE}}, {{REPLY_LANGUAGE}} and tokens such as <OWNER_USER_ID>,
                <MAIN_BOT_USER_ID>, <DATA_ROOT>, <NODE_BIN> are filled in from the config
                when text is written. The values used are stored in the baseline so that a
                config change is not mistaken for a hand edit.
  state         baseline and fingerprints live in <state-dir> (default
                <workspaceRoot>/_shared/.sync/<lang>): last-source.md and fingerprints.json.

Commands (exactly one)
  --check                  Read only. For every role checks three things: the shared section,
                           the fingerprint of the head and the fingerprint of the tail.
  --apply                  Check everything first, then write everything. If any role has a
                           problem the whole run stops and nothing is written.
  --accept-header ROLE     After a legitimate edit of a role's head: if that role's shared
                           section and tail are both correct, recompute its head fingerprint.
  --register ROLE          Register a new role: it is in the config but not in the fingerprints
                           yet, its AGENTS.md splits into three parts and its shared section
                           equals the source with the overrides applied (old and new source).
                           Only that role's fingerprints are written.
  --generate [--dry-run]   Build AGENTS.md from scratch for every role whose file does not exist
                           yet (head + shared section with overrides + tail unless the role has
                           none). Existing files are never touched. When every role has a file
                           and all shared sections are correct, the baseline is created; roles
                           generated later are registered in an existing baseline when possible.

Exit codes: 0 all fine; 1 mismatch found; 2 whole run stopped (usage error, missing markers, ...).
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, ".."))
DEFAULT_RULES_DIR = os.path.join(REPO_ROOT, "rules")

LANGS = ("en", "zh-CN")
# File names per language (all inside the rules dir; heads are inside roles/<dir>/).
LANG_FILES = {
    "en": {"rules": "shared-rules.md", "tail": "shared-tail.md", "head": "AGENTS.head.md"},
    "zh-CN": {"rules": "shared-rules.zh-CN.md", "tail": "shared-tail.zh-CN.md", "head": "AGENTS.head.zh-CN.md"},
}
OVERRIDES_FILE = "shared-rules-overrides.json"

# Same defaults as plugins/personal-inbox/roles.mjs; "roles" in the config overrides them.
DEFAULT_ROLES = {
    "controller": "main",
    "desktop": "desktop",
    "taskAuditor": "task-auditor",
    "systemAuditor": "system-auditor",
    "diary": "diary",
    "standby": ["standby-a", "standby-b"],
    "workerPrefix": "worker-",
}

TOKEN_RE = re.compile(r"\{\{[A-Z][A-Z0-9_]*\}\}|<[A-Z][A-Z0-9_]*>")


class Halt(Exception):
    """A problem that must stop one role or the whole run."""


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write_atomic(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)


# ---------- configuration ----------

def find_config(explicit=None, env=None):
    env = os.environ if env is None else env
    candidates = [explicit, env.get("SOLOFLEET_CONFIG"),
                  os.path.join(REPO_ROOT, "config", "crew.json"),
                  os.path.join(REPO_ROOT, "config", "crew.example.json")]
    if explicit:
        if not os.path.isfile(explicit):
            raise Halt(f"config file not found: {explicit}")
        return explicit
    for c in candidates[1:]:
        if c and os.path.isfile(c):
            return c
    raise Halt("no config found (looked at $SOLOFLEET_CONFIG, config/crew.json, config/crew.example.json)")


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise Halt("config must be a JSON object")
    return cfg


def effective_roles(cfg):
    """Role table: defaults overlaid with the optional "roles" object of the config."""
    roles = dict(DEFAULT_ROLES)
    over = cfg.get("roles")
    if isinstance(over, dict):
        roles.update(over)
    return roles


def load_roles(cfg, workspace_root=None):
    """Return {agentId: path of its AGENTS.md}. The agentIds are the keys of "bots"."""
    bots = cfg.get("bots")
    if not isinstance(bots, dict) or not bots:
        raise Halt("the config has no bots (cannot build the role list)")
    ws = workspace_root or (cfg.get("paths") or {}).get("workspaceRoot")
    if not ws:
        raise Halt("paths.workspaceRoot is not set in the config (and no --workspace-root given)")
    return {rid: os.path.join(ws, rid, "AGENTS.md") for rid in bots}


def head_dir_for(agent_id, roles_cfg):
    """Directory under rules/roles/ that holds the head of this agentId."""
    r = roles_cfg
    if agent_id == r.get("controller"):
        return "main"
    if agent_id == r.get("desktop"):
        return "desktop"
    if agent_id == r.get("taskAuditor"):
        return "task-auditor"
    if agent_id == r.get("systemAuditor"):
        return "system-auditor"
    if agent_id == r.get("diary"):
        return "diary"
    if agent_id in (r.get("standby") or []):
        return "worker"
    prefix = r.get("workerPrefix") or "worker-"
    if agent_id.startswith(prefix):
        return "worker"
    raise Halt(f"no role head known for agentId '{agent_id}' (not a controller, desktop, system-auditor, diary, standby or worker)")


def placeholder_values(cfg, workspace_root=None):
    """Map placeholder token -> value, taken from the config. Empty values are left out."""
    vals = {}

    def put(token, value):
        if isinstance(value, str) and value.strip():
            vals[token] = value

    owner = cfg.get("owner") or {}
    put("{{OWNER_TITLE}}", owner.get("title") or "the owner")
    put("{{REPLY_LANGUAGE}}", cfg.get("replyLanguage") or "English")
    put("<OWNER_USER_ID>", owner.get("userId"))
    put("<GUILD_ID>", cfg.get("guildId"))
    channels = cfg.get("channels") or {}
    for key, token in (("workshop", "<WORKSHOP_CHANNEL_ID>"), ("approval", "<APPROVAL_CHANNEL_ID>"),
                       ("lounge", "<LOUNGE_CHANNEL_ID>"), ("diary", "<DIARY_CHANNEL_ID>")):
        put(token, channels.get(key))
    for agent_id, bot in (cfg.get("bots") or {}).items():
        token = "<" + agent_id.upper().replace("-", "_") + "_BOT_USER_ID>"
        put(token, (bot or {}).get("userId"))
    paths = cfg.get("paths") or {}
    put("<DATA_ROOT>", paths.get("dataRoot"))
    put("<WORKSPACE_ROOT>", workspace_root or paths.get("workspaceRoot"))
    put("<PROJECT_ROOT>", paths.get("projectRoot") or REPO_ROOT)
    put("<NODE_BIN>", paths.get("nodeBin"))
    put("<TIMEZONE>", cfg.get("timezone") or "UTC")
    return vals


def substitute(text, values):
    """Replace known placeholder tokens in one pass; unknown tokens stay as they are."""
    return TOKEN_RE.sub(lambda m: values.get(m.group(0), m.group(0)), text)


def unresolved_tokens(text, values):
    return sorted({m.group(0) for m in TOKEN_RE.finditer(text) if m.group(0) not in values})


# ---------- rule files of one language ----------

def normalize_source(text):
    """The source always ends with one blank line (drop_final_blank_line relies on it)."""
    body = text.rstrip("\n")
    if not body:
        raise Halt("shared-rules source is empty")
    return body + "\n\n"


def normalize_tail(text):
    body = text.rstrip("\n")
    if not body:
        raise Halt("shared-tail source is empty")
    return body + "\n"


def first_line(text, what):
    line = text.split("\n", 1)[0] + "\n"
    if not line.startswith("## ") or len(line.strip()) <= 3:
        raise Halt(f"{what} must start with a '## ' heading line (it is the marker); found: {line.strip()!r}")
    return line


class Ctx:
    """Everything one run needs for one language."""

    def __init__(self, lang, rules_dir, cfg, roles_cfg, table, state_dir, workspace_root=None):
        self.lang = lang
        self.rules_dir = rules_dir
        self.cfg = cfg
        self.roles_cfg = roles_cfg
        self.table = table
        self.state_dir = state_dir
        names = LANG_FILES[lang]
        self.source = normalize_source(read(os.path.join(rules_dir, names["rules"])))
        self.tail = normalize_tail(read(os.path.join(rules_dir, names["tail"])))
        self.start = first_line(self.source, names["rules"])
        self.end = first_line(self.tail, names["tail"])
        if self.start == self.end:
            raise Halt("start and end markers are the same line")
        self.values = placeholder_values(cfg, workspace_root)
        # first line of the other language's rule file, only used for a friendlier error
        other = "zh-CN" if lang == "en" else "en"
        try:
            self.other_start = first_line(read(os.path.join(rules_dir, LANG_FILES[other]["rules"])), "other")
        except (OSError, Halt):
            self.other_start = None

    def head_path(self, rid):
        d = head_dir_for(rid, self.roles_cfg)
        return os.path.join(self.rules_dir, "roles", d, LANG_FILES[self.lang]["head"])


# ---------- splitting: head / shared section / tail ----------

def split_file(text, start, end, has_tail, other_start=None):
    """Return (head, shared section, tail). Missing or duplicated markers, and a declaration that
    does not match the file, raise Halt. A marker must be a whole line on its own."""
    pos = 0
    starts, ends, others = [], [], []
    for line in text.splitlines(keepends=True):
        if line == start:
            starts.append(pos)
        elif line == end:
            ends.append(pos)
        elif other_start and line == other_start:
            others.append(pos)
        pos += len(line)
    if len(starts) != 1:
        hint = " (this file looks like the other language version; try --lang)" if (not starts and others) else ""
        raise Halt(f"start marker '{start.strip()}' found {len(starts)} times (must be exactly 1){hint}")
    i = starts[0]
    if not has_tail:
        if ends:
            raise Halt("the overrides file says this role has no tail, but the end marker is in the file")
        return text[:i], text[i:], ""
    if len(ends) != 1:
        raise Halt(f"end marker '{end.strip()}' found {len(ends)} times (must be exactly 1)")
    j = ends[0]
    if j < i:
        raise Halt("end marker comes before the start marker")
    return text[:i], text[i:j], text[j:]


# ---------- overrides operations ----------

def op_delete_section(section, op, lang):
    """Delete the whole section that starts with the given heading line: from the heading to the
    last non-blank line before the next heading (or the end). Blank lines around it stay."""
    headings = op.get("heading")
    if not isinstance(headings, dict) or lang not in headings:
        raise Halt(f"delete_section needs heading.{lang} in the overrides file")
    heading = headings[lang].rstrip("\n") + "\n"
    lines = section.splitlines(keepends=True)
    hits = [k for k, l in enumerate(lines) if l == heading]
    if len(hits) != 1:
        raise Halt(f"anchor '{heading.strip()}' found {len(hits)} times (must be exactly 1)")
    a = hits[0]
    b = a + 1
    while b < len(lines) and not lines[b].startswith("#"):
        b += 1
    last = b - 1
    while last > a and lines[last].strip() == "":
        last -= 1
    return "".join(lines[:a] + lines[last + 1:])


def op_drop_final_blank_line(section, op, lang):
    if not section.endswith("\n\n"):
        raise Halt("anchor failed: the shared section does not end with text + blank line, nothing to drop")
    return section[:-1]


OPS = {
    "delete_section": op_delete_section,
    "drop_final_blank_line": op_drop_final_blank_line,
}


def apply_ops(section, entry, lang):
    for op in entry.get("ops", []):
        fn = OPS.get(op.get("op"))
        if fn is None:
            raise Halt(f"unknown operation in the overrides file: {op.get('op')}")
        section = fn(section, op, lang)
    return section


def load_table(rules_dir):
    path = os.path.join(rules_dir, OVERRIDES_FILE)
    with open(path, "r", encoding="utf-8") as f:
        t = json.load(f)
    roles = t.get("roles", {})
    for rid, ent in roles.items():
        if not isinstance(ent.get("hasTail", True), bool):
            raise Halt(f"overrides role {rid}: hasTail must be true or false")
    return roles


def entry_of(table, rid):
    return table.get(rid, {})


def has_tail(table, rid):
    return entry_of(table, rid).get("hasTail", True)


def check_table_roles(table, roles, roles_cfg):
    """An overrides entry for a role missing from the config is ignored when it is one of the
    default role names (the config may simply not use that role); any other key is a typo."""
    known = {roles_cfg.get("controller"), roles_cfg.get("desktop"), roles_cfg.get("taskAuditor"),
             roles_cfg.get("systemAuditor"), roles_cfg.get("diary")} | set(roles_cfg.get("standby") or [])
    prefix = roles_cfg.get("workerPrefix") or "worker-"
    unknown = [k for k in table if k not in roles and k not in known and not k.startswith(prefix)]
    if unknown:
        raise Halt(f"the overrides file has roles that are not in the config: {unknown}")


def expected_section(ctx, rid, source=None, values=None):
    src = ctx.source if source is None else source
    vals = ctx.values if values is None else values
    return substitute(apply_ops(src, entry_of(ctx.table, rid), ctx.lang), vals)


# ---------- baseline ----------

def baseline_paths(state_dir):
    return state_dir, os.path.join(state_dir, "last-source.md"), os.path.join(state_dir, "fingerprints.json")


def load_baseline(state_dir):
    d, src, fp = baseline_paths(state_dir)
    have_src, have_fp = os.path.exists(src), os.path.exists(fp)
    if not have_src and not have_fp:
        return None
    if have_src != have_fp:
        raise Halt("the sync baseline is only half there (last-source.md and fingerprints.json must come as a pair); investigate first")
    with open(fp, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {"source": read(src), "fp": data}


def dump_fp(data):
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def save_baseline(ctx, roles_state):
    d, src, fp = baseline_paths(ctx.state_dir)
    os.makedirs(d, exist_ok=True)
    write_atomic(src, ctx.source)
    data = {"version": 1, "sourceFingerprint": sha(ctx.source), "values": ctx.values, "roles": roles_state}
    write_atomic(fp, dump_fp(data))


# ---------- inspection ----------

def inspect_roles(ctx, roles, baseline):
    """Take each role's file apart and compare. One dict per role; problems go in 'halt', not raised."""
    result = {}
    old_source = baseline["source"] if baseline else ctx.source
    old_values = baseline["fp"].get("values", ctx.values) if baseline else ctx.values
    base_fp = baseline["fp"].get("roles", {}) if baseline else {}
    for rid, path in roles.items():
        r = {"path": path, "halt": [], "notes": []}
        result[rid] = r
        try:
            text = read(path)
        except OSError as e:
            r["halt"].append(f"cannot read the file (use --generate to create missing files): {e}")
            continue
        r["text"] = text
        try:
            head, section, tail = split_file(text, ctx.start, ctx.end, has_tail(ctx.table, rid), ctx.other_start)
        except Halt as e:
            r["halt"].append(str(e))
            continue
        r.update(head=head, section=section, tail=tail)
        try:
            r["expected_old"] = expected_section(ctx, rid, old_source, old_values)
        except Halt as e:
            r["halt"].append(f"overrides failed on the old source: {e}")
        try:
            r["expected_new"] = expected_section(ctx, rid)
        except Halt as e:
            r["halt"].append(f"overrides failed on the new source: {e}")
        r["section_ok_old"] = ("expected_old" in r) and section == r["expected_old"]
        r["section_ok_new"] = ("expected_new" in r) and section == r["expected_new"]
        if baseline:
            b = base_fp.get(rid)
            if b is None:
                r["halt"].append("the sync baseline has no entry for this role (register a new role first)")
            else:
                r["head_ok"] = sha(head) == b["head"]
                r["tail_ok"] = sha(tail) == b["tail"]
                r["fp_section_ok"] = sha(section) == b["section"]
        else:
            r["head_ok"] = r["tail_ok"] = r["fp_section_ok"] = None
    return result


def render_table(info, baseline):
    rows = [("role", "shared", "head", "tail", "note")]
    all_ok = True
    for rid, r in info.items():
        if r["halt"]:
            rows.append((rid, "-", "-", "-", "; ".join(r["halt"])))
            all_ok = False
            continue
        sec = "ok" if r["section_ok_new"] else "MISMATCH"
        if baseline is None:
            head = tail = "no baseline"
        else:
            head = "ok" if r["head_ok"] else "CHANGED"
            tail = "ok" if r["tail_ok"] else "CHANGED"
        ok = r["section_ok_new"] and (baseline is None or (r["head_ok"] and r["tail_ok"]))
        all_ok = all_ok and ok
        note = ""
        if not r["section_ok_new"]:
            note = "shared section differs from source + overrides"
        elif baseline is not None and not r["head_ok"]:
            note = "head fingerprint differs from the last sync; if the edit is legitimate use --accept-header"
        elif baseline is not None and not r["tail_ok"]:
            note = "content after the shared section changed"
        rows.append((rid, sec, head, tail, note))
    w = [max(len(str(x[i])) for x in rows) for i in range(4)]
    out = []
    for row in rows:
        out.append("  ".join(str(row[i]).ljust(w[i]) for i in range(4)) + "  " + str(row[4]))
    return "\n".join(out), all_ok


def cmd_check(ctx, roles):
    baseline = load_baseline(ctx.state_dir)
    info = inspect_roles(ctx, roles, baseline)
    text, ok = render_table(info, baseline)
    print(text)
    if baseline is None:
        print("(no sync baseline yet: the first --apply creates it)")
    print("result: " + ("all match" if ok else "mismatch found"))
    return 0 if ok else 1


def collect_halts(info, baseline):
    halts = []
    for rid, r in info.items():
        for h in r["halt"]:
            halts.append(f"{rid}: {h}")
        if r["halt"]:
            continue
        if not r["section_ok_old"]:
            halts.append(f"{rid}: the current shared section does not match 'last source + overrides' (someone edited the shared section directly)")
        if baseline is not None:
            if not r["head_ok"]:
                halts.append(f"{rid}: head fingerprint differs from the last sync (for a legitimate edit run --accept-header {rid} first)")
            if not r["tail_ok"]:
                halts.append(f"{rid}: content after the shared section differs from the last sync")
            if not r["fp_section_ok"]:
                halts.append(f"{rid}: shared-section fingerprint differs from the last sync record")
    return halts


def cmd_apply(ctx, roles, backup_dir, now=None):
    baseline = load_baseline(ctx.state_dir)
    info = inspect_roles(ctx, roles, baseline)
    halts = collect_halts(info, baseline)
    if halts:
        print("Stopped, nothing was written:")
        for h in halts:
            print("  - " + h)
        return 2
    to_write = [rid for rid, r in info.items() if r["text"] != r["head"] + r["expected_new"] + r["tail"]]
    stamp = (now or datetime.datetime.now()).strftime("%Y%m%d-%H%M%S")
    if to_write:
        if not backup_dir:
            print("Stopped, nothing was written: files need to change but no --backup-dir was given (originals are saved there before writing)")
            return 2
        bdir = os.path.join(backup_dir, f"before-sync-{stamp}")
        for rid in to_write:
            dest = os.path.join(bdir, rid)
            os.makedirs(dest, exist_ok=True)
            shutil.copy2(info[rid]["path"], os.path.join(dest, "AGENTS.md"))
        for rid in to_write:
            r = info[rid]
            write_atomic(r["path"], r["head"] + r["expected_new"] + r["tail"])
        print(f"wrote {len(to_write)} file(s): {', '.join(to_write)} (originals saved in {bdir})")
    else:
        print("nothing to change: all files are byte-identical" + (" (first sync, baseline created)" if baseline is None else ""))
    # read back and store the baseline
    info2 = inspect_roles(ctx, roles, None)
    state = {}
    for rid, r in info2.items():
        if r["halt"] or not r["section_ok_new"]:
            print(f"post-write verification failed: {rid} {r['halt']}")
            return 2
        state[rid] = {"head": sha(r["head"]), "tail": sha(r["tail"]), "section": sha(r["section"])}
    save_baseline(ctx, state)
    print("sync baseline updated (last-source.md, fingerprints.json)")
    return cmd_check(ctx, roles)


def cmd_accept_header(ctx, roles, rid):
    if rid not in roles:
        print(f"no such role: {rid}")
        return 2
    baseline = load_baseline(ctx.state_dir)
    if baseline is None:
        print("there is no sync baseline yet, cannot --accept-header")
        return 2
    info = inspect_roles(ctx, roles, baseline)
    r = info[rid]
    if r["halt"]:
        print("Stopped: " + "; ".join(r["halt"]))
        return 2
    if not r["section_ok_new"] or not r["tail_ok"] or not r["fp_section_ok"]:
        print("Stopped: the shared section or the tail does not fully match, cannot accept a head change")
        return 2
    if r["head_ok"]:
        print(f"the head fingerprint of {rid} did not change, nothing to accept")
        return 0
    data = baseline["fp"]
    old = data["roles"][rid]["head"]
    data["roles"][rid]["head"] = sha(r["head"])
    write_atomic(baseline_paths(ctx.state_dir)[2], dump_fp(data))
    print(f"accepted the head change of {rid}: {old[:12]} -> {data['roles'][rid]['head'][:12]}")
    return 0


def register_role(ctx, roles, baseline, rid):
    """Register one role in an existing baseline. Returns (ok, message). Writes only fingerprints.json."""
    data = baseline["fp"]
    if rid in data.get("roles", {}):
        return False, f"{rid} is already registered (for a legitimate head edit use --accept-header)"
    try:
        text = read(roles[rid])
    except OSError as e:
        return False, f"cannot read the file of {rid}: {e}"
    try:
        head, section, tail = split_file(text, ctx.start, ctx.end, has_tail(ctx.table, rid), ctx.other_start)
    except Halt as e:
        return False, f"cannot split {rid} into three parts: {e}"
    old_values = data.get("values", ctx.values)
    try:
        exp_new = expected_section(ctx, rid)
        exp_old = expected_section(ctx, rid, baseline["source"], old_values)
    except Halt as e:
        return False, f"overrides failed on the source: {e}"
    if section != exp_new or section != exp_old:
        return False, f"the shared section of {rid} does not equal 'source + overrides' (old and new version must both match); not registered"
    data.setdefault("roles", {})[rid] = {"head": sha(head), "tail": sha(tail), "section": sha(section)}
    write_atomic(baseline_paths(ctx.state_dir)[2], dump_fp(data))
    return True, f"registered {rid}: head {sha(head)[:12]}, shared {sha(section)[:12]}, tail {sha(tail)[:12]}"


def cmd_register(ctx, roles, rid):
    """Register a role that is in the config but not in the baseline yet. Does not touch any
    AGENTS.md or the baseline source file."""
    if rid not in roles:
        print(f"Stopped: the config has no such role: {rid}")
        return 2
    baseline = load_baseline(ctx.state_dir)
    if baseline is None:
        print("Stopped: there is no sync baseline yet, cannot register (run --apply first to create it)")
        return 2
    ok, msg = register_role(ctx, roles, baseline, rid)
    print(("" if ok else "Stopped: ") + msg)
    return 0 if ok else 2


# ---------- generate from scratch ----------

def compose(ctx, rid):
    """Complete AGENTS.md text of a role: head + shared section (with overrides) + tail."""
    head_path = ctx.head_path(rid)
    try:
        head = read(head_path)
    except OSError as e:
        raise Halt(f"{rid}: cannot read the role head {head_path}: {e}")
    head_text = head.rstrip("\n") + "\n\n"
    section = expected_section(ctx, rid)
    tail = ctx.tail if has_tail(ctx.table, rid) else ""
    return substitute(head_text, ctx.values) + section + substitute(tail, ctx.values)


def cmd_generate(ctx, roles, dry_run=False):
    plan, kept, halts = [], [], []
    for rid, path in roles.items():
        if os.path.exists(path):
            kept.append(rid)
            continue
        try:
            plan.append((rid, path, compose(ctx, rid)))
        except Halt as e:
            halts.append(str(e))
    if halts:
        print("Stopped, nothing was written:")
        for h in halts:
            print("  - " + h)
        return 2
    leftovers = sorted({t for _, _, text in plan for t in unresolved_tokens(text, ctx.values)})
    for rid in kept:
        print(f"kept {rid}: {roles[rid]} already exists (not touched)")
    if dry_run:
        for rid, path, text in plan:
            print(f"would create {rid}: {path} ({len(text.encode('utf-8'))} bytes)")
        if leftovers:
            print("warning: placeholders without a config value would stay as written: " + ", ".join(leftovers))
        return 0
    for rid, path, text in plan:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "x", encoding="utf-8", newline="") as f:  # 'x': never overwrite
            f.write(text)
        print(f"created {rid}: {path}")
    if leftovers:
        print("warning: placeholders without a config value stayed as written: " + ", ".join(leftovers))
    created = [rid for rid, _, _ in plan]
    baseline = load_baseline(ctx.state_dir)
    if baseline is None:
        info = inspect_roles(ctx, roles, None)
        problems = [rid for rid, r in info.items() if r["halt"] or not r["section_ok_new"]]
        if problems:
            print("baseline not created: these existing files do not match the rules yet: " + ", ".join(problems)
                  + " (run --check, then --apply)")
        else:
            state = {rid: {"head": sha(r["head"]), "tail": sha(r["tail"]), "section": sha(r["section"])}
                     for rid, r in info.items()}
            save_baseline(ctx, state)
            print("sync baseline created (last-source.md, fingerprints.json)")
    else:
        for rid in created:
            ok, msg = register_role(ctx, roles, baseline, rid)
            print(msg if ok else f"not registered: {msg} (run --apply, then --register {rid})")
    return cmd_check(ctx, roles)


# ---------- entry point ----------

def build_ctx(a):
    cfg_path = find_config(a.config)
    cfg = load_config(cfg_path)
    roles_cfg = effective_roles(cfg)
    roles = load_roles(cfg, a.workspace_root)
    table = load_table(a.rules_dir)
    check_table_roles(table, roles, roles_cfg)
    ws = a.workspace_root or (cfg.get("paths") or {}).get("workspaceRoot")
    state_dir = a.state_dir or os.path.join(ws, "_shared", ".sync", a.lang)
    ctx = Ctx(a.lang, a.rules_dir, cfg, roles_cfg, table, state_dir, a.workspace_root)
    return ctx, roles


def main(argv=None):
    ap = argparse.ArgumentParser(description="Shared-rules sync: check, apply, accept-header, register, generate")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--apply", action="store_true")
    g.add_argument("--generate", action="store_true", help="create AGENTS.md for roles that have none yet")
    g.add_argument("--accept-header", metavar="ROLE")
    g.add_argument("--register", metavar="ROLE")
    ap.add_argument("--lang", choices=LANGS, default="en", help="rule language (default en)")
    ap.add_argument("--rules-dir", default=DEFAULT_RULES_DIR)
    ap.add_argument("--config", default=None, help="crew config (default: $SOLOFLEET_CONFIG, config/crew.json, config/crew.example.json)")
    ap.add_argument("--workspace-root", default=None, help="override paths.workspaceRoot of the config")
    ap.add_argument("--state-dir", default=None, help="baseline folder (default <workspaceRoot>/_shared/.sync/<lang>)")
    ap.add_argument("--backup-dir", default=None, help="--apply saves originals here before writing")
    ap.add_argument("--dry-run", action="store_true", help="with --generate: show what would be created")
    a = ap.parse_args(argv)
    if a.dry_run and not a.generate:
        ap.error("--dry-run only works with --generate")
    try:
        ctx, roles = build_ctx(a)
        if a.check:
            return cmd_check(ctx, roles)
        if a.apply:
            return cmd_apply(ctx, roles, a.backup_dir)
        if a.generate:
            return cmd_generate(ctx, roles, a.dry_run)
        if a.register:
            return cmd_register(ctx, roles, a.register)
        return cmd_accept_header(ctx, roles, a.accept_header)
    except Halt as e:
        print(f"Stopped: {e}")
        return 2
    except (OSError, json.JSONDecodeError) as e:
        print(f"Stopped: cannot read a required file: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
