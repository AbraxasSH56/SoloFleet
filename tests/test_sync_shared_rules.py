"""Offline tests for scripts/sync-shared-rules.py.

Fixtures: a copy of the repository's rules/ folder and a copy of config/crew.example.json whose
workspace root points into a temporary directory. The AGENTS.md files are produced with the
script's own --generate and then edited by the tests. Nothing real is touched.
Every test class runs twice, once per rule language (en, zh-CN).
Run from the repo root: python3 -I -m unittest discover -s tests -p "test_sync_shared_rules.py"
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
spec = importlib.util.spec_from_file_location("sync_shared_rules", os.path.join(ROOT, "scripts", "sync-shared-rules.py"))
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

# What each language's rule files are expected to look like.
INFO = {
    "en": {
        "start": "## Shared rules (all bots)\n",
        "end": "## Changed-files list for this turn\n",
        "desktop": "### Desktop\n",
        "anchor": "### Quota exhaustion\n",
        "word": "Basis and verification",
    },
    "zh-CN": {
        "start": "## 共用规则（所有 bot）\n",
        "end": "## 本轮改动名单\n",
        "desktop": "### 桌面\n",
        "anchor": "### 撞额度\n",
        "word": "依据和先核实",
    },
}
HEAD_DIRS = {"main": "main", "desktop": "desktop", "diary": "diary",
             "task-auditor": "task-auditor", "system-auditor": "system-auditor"}


def run(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = S.main(argv)
    return code, buf.getvalue()


class Base(unittest.TestCase):
    LANG = "en"

    def setUp(self):
        self.info = INFO[self.LANG]
        self.tmp = tempfile.mkdtemp(prefix="sync-test-")
        self.rules = os.path.join(self.tmp, "rules")
        shutil.copytree(os.path.join(ROOT, "rules"), self.rules)
        self.ws = os.path.join(self.tmp, "ws")
        with open(os.path.join(ROOT, "config", "crew.example.json"), encoding="utf-8") as f:
            self.cfg = json.load(f)
        self.cfg["paths"]["workspaceRoot"] = self.ws
        self.config = os.path.join(self.tmp, "cfg.json")
        self.write_config()
        self.backup = os.path.join(self.tmp, "backup")
        self.state = os.path.join(self.ws, "_shared", ".sync", self.LANG)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers ---
    def write_config(self):
        with open(self.config, "w", encoding="utf-8") as f:
            json.dump(self.cfg, f)

    @property
    def roles(self):
        return list(self.cfg["bots"])

    def path(self, rid):
        return os.path.join(self.ws, rid, "AGENTS.md")

    def args(self, *a):
        return list(a) + ["--lang", self.LANG, "--rules-dir", self.rules, "--config", self.config]

    def apply(self):
        return run(self.args("--apply", "--backup-dir", self.backup))

    def check(self):
        return run(self.args("--check"))

    def make_files(self, baseline=True):
        code, out = run(self.args("--generate"))
        self.assertEqual(code, 0, out)
        if not baseline:
            shutil.rmtree(self.state)

    def first_apply(self):
        self.make_files(baseline=False)
        code, out = self.apply()
        self.assertEqual(code, 0, out)

    def snapshot(self):
        return {r: S.read(self.path(r)) for r in self.roles if os.path.exists(self.path(r))}

    def baseline_state(self):
        if not os.path.exists(self.state):
            return None
        return {n: S.read(os.path.join(self.state, n)) for n in sorted(os.listdir(self.state))}

    def edit(self, rid, fn):
        t = S.read(self.path(rid))
        with open(self.path(rid), "w", encoding="utf-8", newline="") as f:
            f.write(fn(t))

    def edit_rules(self, fn, name=None):
        p = os.path.join(self.rules, name or S.LANG_FILES[self.LANG]["rules"])
        t = S.read(p)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(fn(t))

    def tamper_section(self, text):
        a = self.info["anchor"]
        self.assertIn(a, text)
        return text.replace(a, a + "EDITED LINE\n", 1)

    def split(self, text, rid):
        i = self.info
        return S.split_file(text, i["start"], i["end"], rid != "system-auditor")

    def new_overrides(self, fn):
        p = os.path.join(self.rules, S.OVERRIDES_FILE)
        with open(p, encoding="utf-8") as f:
            t = json.load(f)
        fn(t)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(t, f, ensure_ascii=False)

    def add_role(self, rid, copy_from="worker-a"):
        self.cfg["bots"][rid] = {"userId": "1000000099"}
        self.write_config()
        os.makedirs(os.path.dirname(self.path(rid)))
        shutil.copy(self.path(copy_from), self.path(rid))


class TestMarkersAndConfig(Base):
    def test_markers_are_first_lines_of_the_rule_files(self):
        a = self.info
        names = S.LANG_FILES[self.LANG]
        self.assertTrue(S.read(os.path.join(self.rules, names["rules"])).startswith(a["start"]))
        self.assertTrue(S.read(os.path.join(self.rules, names["tail"])).startswith(a["end"]))

    def test_roles_come_from_config_bots(self):
        roles = S.load_roles(self.cfg)
        self.assertEqual(set(roles), set(self.cfg["bots"]))
        for rid, p in roles.items():
            self.assertEqual(p, os.path.join(self.ws, rid, "AGENTS.md"))

    def test_config_lookup_order(self):
        explicit = os.path.join(self.tmp, "x.json")
        envp = os.path.join(self.tmp, "env.json")
        for p in (explicit, envp):
            with open(p, "w", encoding="utf-8") as f:
                f.write("{}")
        self.assertEqual(S.find_config(explicit, env={}), explicit)
        self.assertEqual(S.find_config(None, env={"SOLOFLEET_CONFIG": envp}), envp)
        default = S.find_config(None, env={})
        self.assertTrue(default.endswith("crew.json") or default.endswith("crew.example.json"))

    def test_head_dir_mapping(self):
        rc = S.effective_roles({})
        self.assertEqual(S.head_dir_for("main", rc), "main")
        self.assertEqual(S.head_dir_for("desktop", rc), "desktop")
        self.assertEqual(S.head_dir_for("task-auditor", rc), "task-auditor")
        self.assertEqual(S.head_dir_for("system-auditor", rc), "system-auditor")
        self.assertEqual(S.head_dir_for("diary", rc), "diary")
        self.assertEqual(S.head_dir_for("standby-b", rc), "worker")
        self.assertEqual(S.head_dir_for("worker-z", rc), "worker")
        with self.assertRaises(S.Halt):
            S.head_dir_for("stranger", rc)
        renamed = S.effective_roles({"roles": {"controller": "chief"}})
        self.assertEqual(S.head_dir_for("chief", renamed), "main")

    def test_placeholders_filled_from_config(self):
        vals = S.placeholder_values(self.cfg)
        self.assertEqual(vals["{{OWNER_TITLE}}"], "the owner")
        self.assertEqual(vals["<OWNER_USER_ID>"], self.cfg["owner"]["userId"])
        self.assertEqual(vals["<MAIN_BOT_USER_ID>"], self.cfg["bots"]["main"]["userId"])
        self.assertEqual(vals["<TASK_AUDITOR_BOT_USER_ID>"], self.cfg["bots"]["task-auditor"]["userId"])
        self.assertEqual(vals["<NODE_BIN>"], self.cfg["paths"]["nodeBin"])
        text = "x {{OWNER_TITLE}} <@<MAIN_BOT_USER_ID>> <UNKNOWN_THING> <name>"
        out = S.substitute(text, vals)
        self.assertIn("<UNKNOWN_THING>", out)
        self.assertIn("<name>", out)
        self.assertNotIn("{{", out)
        self.assertEqual(S.unresolved_tokens(out, vals), ["<UNKNOWN_THING>"])

    def test_table_role_not_in_config_halts(self):
        self.new_overrides(lambda t: t["roles"].update({"ghost": {"ops": []}}))
        code, out = self.check()
        self.assertEqual(code, 2, out)
        self.assertIn("ghost", out)

    def test_table_entry_of_unused_default_role_is_ignored(self):
        del self.cfg["bots"]["system-auditor"]
        self.write_config()
        self.make_files()
        self.assertEqual(self.check()[0], 0)

    def test_wrong_language_gets_a_hint(self):
        self.make_files()
        other = "zh-CN" if self.LANG == "en" else "en"
        code, out = run(["--check", "--lang", other, "--rules-dir", self.rules, "--config", self.config,
                         "--state-dir", self.state])
        self.assertEqual(code, 1, out)
        self.assertIn("other language", out)


class TestGenerate(Base):
    def test_generate_creates_every_role_and_a_baseline(self):
        self.make_files()
        for rid in self.roles:
            self.assertTrue(os.path.isfile(self.path(rid)), rid)
        self.assertIsNotNone(self.baseline_state())
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_generated_files_follow_head_shared_tail(self):
        self.make_files()
        values = S.placeholder_values(self.cfg)
        a = self.info
        names = S.LANG_FILES[self.LANG]
        tail = S.substitute(S.normalize_tail(S.read(os.path.join(self.rules, names["tail"]))), values)
        shared_by_role = {}
        for rid in self.roles:
            text = S.read(self.path(rid))
            head_dir = S.head_dir_for(rid, S.effective_roles(self.cfg))
            head = S.read(os.path.join(self.rules, "roles", head_dir, names["head"]))
            head = S.substitute(head.rstrip("\n") + "\n\n", values)
            self.assertTrue(text.startswith(head + a["start"]), rid)
            self.assertTrue(text.startswith("# "), rid)
            h, section, t = self.split(text, rid)
            self.assertEqual(h, head, rid)
            if rid == "system-auditor":
                self.assertEqual(t, "", rid)
                self.assertNotIn(a["end"], text)
                self.assertTrue(text.endswith("\n") and not text.endswith("\n\n"), rid)
            else:
                self.assertEqual(t, tail, rid)
            shared_by_role[rid] = section
            # no placeholder is left over
            self.assertNotIn("{{", text, rid)
            self.assertEqual(S.unresolved_tokens(text, values), [], rid)
        self.assertNotIn(a["desktop"], shared_by_role["desktop"])
        for rid in self.roles:
            if rid != "desktop":
                self.assertIn(a["desktop"], shared_by_role[rid], rid)
        plain = [r for r in self.roles if r not in ("desktop", "system-auditor")]
        for rid in plain:
            self.assertEqual(shared_by_role[rid], shared_by_role[plain[0]], rid)

    def test_generated_text_uses_config_values(self):
        self.make_files()
        main = S.read(self.path("main"))
        self.assertIn("<@" + self.cfg["bots"]["task-auditor"]["userId"] + ">", main)
        self.assertIn(self.cfg["paths"]["nodeBin"], main)
        self.assertIn(self.cfg["owner"]["userId"], main)
        self.assertNotIn("<NODE_BIN>", main)

    def test_generate_matches_overrides_for_special_roles(self):
        self.make_files()
        values = S.placeholder_values(self.cfg)
        names = S.LANG_FILES[self.LANG]
        source = S.normalize_source(S.read(os.path.join(self.rules, names["rules"])))
        full = S.substitute(source, values)
        desk = self.info["desktop"]
        _, sec_desktop, _ = self.split(S.read(self.path("desktop")), "desktop")
        j = full.index(desk)
        self.assertEqual(sec_desktop.rstrip("\n"), full[:j].rstrip("\n"))
        _, sec_aud, _ = self.split(S.read(self.path("system-auditor")), "system-auditor")
        self.assertEqual(sec_aud, full[:-1])

    def test_generate_never_touches_existing_files(self):
        os.makedirs(os.path.dirname(self.path("worker-a")))
        with open(self.path("worker-a"), "w", encoding="utf-8") as f:
            f.write("my own file\n")
        code, out = run(self.args("--generate"))
        self.assertIn("kept worker-a", out)
        self.assertEqual(S.read(self.path("worker-a")), "my own file\n")
        self.assertTrue(os.path.isfile(self.path("worker-b")))
        # an existing file that does not match means no baseline yet
        self.assertIsNone(self.baseline_state())
        self.assertEqual(code, 1, out)

    def test_generate_twice_changes_nothing(self):
        self.make_files()
        snap, bl = self.snapshot(), self.baseline_state()
        code, out = run(self.args("--generate"))
        self.assertEqual(code, 0, out)
        self.assertEqual(snap, self.snapshot())
        self.assertEqual(bl, self.baseline_state())

    def test_missing_head_stops_everything(self):
        os.remove(os.path.join(self.rules, "roles", "diary", S.LANG_FILES[self.LANG]["head"]))
        code, out = run(self.args("--generate"))
        self.assertEqual(code, 2, out)
        self.assertIn("diary", out)
        self.assertFalse(os.path.exists(self.ws))

    def test_dry_run_writes_nothing(self):
        code, out = run(self.args("--generate", "--dry-run"))
        self.assertEqual(code, 0, out)
        self.assertIn("would create main", out)
        self.assertFalse(os.path.exists(self.ws))

    def test_dry_run_only_with_generate(self):
        with self.assertRaises(SystemExit):
            run(self.args("--check", "--dry-run"))

    def test_unknown_agent_id_stops_generate(self):
        self.cfg["bots"]["stranger"] = {"userId": "1000000098"}
        self.write_config()
        code, out = run(self.args("--generate"))
        self.assertEqual(code, 2, out)
        self.assertIn("stranger", out)
        self.assertFalse(os.path.exists(self.ws))

    def test_new_role_generated_later_is_registered(self):
        self.make_files()
        self.cfg["bots"]["worker-c"] = {"userId": "1000000099"}
        self.write_config()
        code, out = run(self.args("--generate"))
        self.assertEqual(code, 0, out)
        self.assertIn("registered worker-c", out)
        self.assertTrue(os.path.isfile(self.path("worker-c")))
        self.assertEqual(self.check()[0], 0)

    def test_placeholder_left_when_config_has_no_value(self):
        del self.cfg["bots"]["worker-b"]
        self.write_config()
        code, out = run(self.args("--generate"))
        self.assertEqual(code, 0, out)
        self.assertIn("<WORKER_B_BOT_USER_ID>", out)  # reported as a warning
        self.assertIn("<WORKER_B_BOT_USER_ID>", S.read(self.path("main")))


class TestFirstApply(Base):
    def test_first_apply_leaves_all_files_byte_identical(self):
        self.make_files(baseline=False)
        before = self.snapshot()
        self.assertIsNone(self.baseline_state())
        code, out = self.apply()
        self.assertEqual(code, 0, out)
        self.assertEqual(before, self.snapshot())
        self.assertIsNotNone(self.baseline_state())
        code, out = self.check()
        self.assertEqual(code, 0, out)

    def test_baseline_has_empty_tail_fingerprint_for_the_role_without_tail(self):
        self.first_apply()
        fp = json.loads(self.baseline_state()["fingerprints.json"])
        self.assertEqual(fp["roles"]["system-auditor"]["tail"], S.sha(""))
        self.assertNotEqual(fp["roles"]["main"]["tail"], S.sha(""))

    def test_check_alone_writes_nothing(self):
        self.make_files(baseline=False)
        before = self.snapshot()
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("no sync baseline", out)
        self.assertIsNone(self.baseline_state())
        self.assertEqual(before, self.snapshot())


class TestHalts(Base):
    def assert_halt_nothing_written(self, expect_text=None):
        before, bl = self.snapshot(), self.baseline_state()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        if expect_text:
            self.assertIn(expect_text, out)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(bl, self.baseline_state())
        self.assertFalse(os.path.exists(self.backup))

    def test_undeclared_role_missing_end_marker_halts(self):
        self.make_files(baseline=False)
        self.edit("worker-a", lambda t: t.replace(self.info["end"], "## Renamed\n"))
        self.assert_halt_nothing_written("end marker")

    def test_end_marker_duplicate_halts(self):
        self.make_files(baseline=False)
        self.edit("worker-b", lambda t: t + self.info["end"])
        self.assert_halt_nothing_written("end marker")

    def test_start_marker_duplicate_halts(self):
        self.make_files(baseline=False)
        self.edit("diary", lambda t: t + self.info["start"])
        self.assert_halt_nothing_written("start marker")

    def test_start_marker_missing_halts(self):
        self.make_files(baseline=False)
        self.edit("standby-a", lambda t: t.replace(self.info["start"], "## Not the shared rules\n"))
        self.assert_halt_nothing_written("start marker")

    def test_anchor_not_found_halts(self):
        self.make_files(baseline=False)

        def change(t):
            t["roles"]["desktop"]["ops"][0]["heading"][self.LANG] = "### No such section\n"
        self.new_overrides(change)
        self.assert_halt_nothing_written("found 0 times")

    def test_anchor_found_twice_halts(self):
        self.make_files(baseline=False)
        self.edit_rules(lambda t: t + "\n" + self.info["desktop"] + "Another desktop section\n")
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertIn("found 2 times", out)

    def test_directly_edited_shared_section_halts_after_baseline(self):
        self.first_apply()
        self.edit("worker-b", self.tamper_section)
        self.assert_halt_nothing_written("edited the shared section directly")

    def test_unaccepted_header_change_halts(self):
        self.first_apply()
        self.edit("standby-b", lambda t: "A new head line\n" + t)
        self.assert_halt_nothing_written("head fingerprint")

    def test_tail_change_halts(self):
        self.first_apply()
        self.edit("task-auditor", lambda t: t + "\nOne extra line\n")
        self.assert_halt_nothing_written("after the shared section")

    def test_missing_agents_file_halts_and_points_to_generate(self):
        self.first_apply()
        os.remove(self.path("worker-b"))
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertIn("--generate", out)


class TestAuditorDeclaration(Base):
    """The role declared hasTail=false."""

    def test_direct_edit_in_section_check_fails_apply_halts(self):
        self.first_apply()
        self.edit("system-auditor", self.tamper_section)
        code, out = self.check()
        self.assertEqual(code, 1, out)
        before, bl = self.snapshot(), self.baseline_state()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(bl, self.baseline_state())

    def test_appended_text_halts(self):
        self.first_apply()
        self.edit("system-auditor", lambda t: t + "Extra text\n")
        code, out = self.check()
        self.assertEqual(code, 1, out)
        before, bl = self.snapshot(), self.baseline_state()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(bl, self.baseline_state())

    def test_gains_end_marker_halts(self):
        self.first_apply()
        self.edit("system-auditor", lambda t: t + self.info["end"] + "- x\n")
        before, bl = self.snapshot(), self.baseline_state()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertIn("has no tail", out)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(bl, self.baseline_state())

    def test_duplicate_start_halts(self):
        self.first_apply()
        self.edit("system-auditor", lambda t: t + self.info["start"])
        before, bl = self.snapshot(), self.baseline_state()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(bl, self.baseline_state())

    def test_declaring_a_tail_for_it_halts(self):
        self.make_files(baseline=False)
        self.new_overrides(lambda t: t["roles"]["system-auditor"].update({"hasTail": True}))
        code, out = self.apply()
        self.assertEqual(code, 2, out)

    def test_hastail_must_be_boolean(self):
        self.new_overrides(lambda t: t["roles"]["system-auditor"].update({"hasTail": "no"}))
        code, out = self.check()
        self.assertEqual(code, 2, out)
        self.assertIn("hasTail", out)


class TestNormalSync(Base):
    def test_source_edit_updates_all_and_keeps_head_tail(self):
        self.first_apply()
        before = self.snapshot()
        anchor = self.info["anchor"]
        note = "Audit roles and the diary install nothing, use commands only to read.\n\n"
        self.edit_rules(lambda s: s.replace(anchor, note + anchor, 1))
        code, out = self.apply()
        self.assertEqual(code, 0, out)
        after = self.snapshot()
        for rid in self.roles:
            h0, s0, t0 = self.split(before[rid], rid)
            h1, s1, t1 = self.split(after[rid], rid)
            self.assertEqual(h0, h1, rid)
            self.assertEqual(t0, t1, rid)
            self.assertNotEqual(s0, s1, rid)
            self.assertIn(note.strip(), s1, rid)
        self.assertEqual(self.split(after["system-auditor"], "system-auditor")[2], "")
        self.assertNotIn(self.info["desktop"], self.split(after["desktop"], "desktop")[1])
        self.assertTrue(after["system-auditor"].endswith("\n"))
        self.assertFalse(after["system-auditor"].endswith("\n\n"))
        self.assertTrue(os.path.isdir(self.backup))  # originals were saved before writing
        self.assertEqual(self.check()[0], 0)
        snap = self.snapshot()
        code, out = self.apply()
        self.assertEqual(code, 0, out)
        self.assertEqual(snap, self.snapshot())

    def test_apply_with_pending_write_needs_backup_dir(self):
        self.first_apply()
        self.edit_rules(lambda s: s + "One more line\n")
        before = self.snapshot()
        code, out = run(self.args("--apply"))
        self.assertEqual(code, 2, out)
        self.assertEqual(before, self.snapshot())

    def test_config_change_is_not_mistaken_for_a_hand_edit(self):
        self.first_apply()
        self.cfg["owner"]["title"] = "Boss"
        self.write_config()
        code, out = self.check()
        self.assertEqual(code, 1, out)  # sections no longer equal the source with the new value
        code, out = self.apply()
        self.assertEqual(code, 0, out)
        for rid in self.roles:
            self.assertIn("Boss", S.read(self.path(rid)), rid)
        self.assertEqual(self.check()[0], 0)

    def test_hand_edit_is_still_caught_after_a_config_change(self):
        self.first_apply()
        self.cfg["owner"]["title"] = "Boss"
        self.write_config()
        self.edit("worker-a", self.tamper_section)
        before = self.snapshot()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertEqual(before, self.snapshot())


class TestAcceptHeader(Base):
    def test_accept_header_then_apply_and_check_pass(self):
        self.first_apply()
        self.edit("worker-a", lambda t: t.replace("\n\n", "\n\nA legitimate head edit.\n", 1))
        code, out = self.check()
        self.assertEqual(code, 1, out)
        code, out = run(self.args("--accept-header", "worker-a"))
        self.assertEqual(code, 0, out)
        self.assertEqual(self.check()[0], 0)
        self.assertEqual(self.apply()[0], 0)

    def test_accept_header_refused_when_section_changed(self):
        self.first_apply()
        self.edit("worker-b", lambda t: "New head\n" + self.tamper_section(t))
        bl = self.baseline_state()
        code, out = run(self.args("--accept-header", "worker-b"))
        self.assertEqual(code, 2, out)
        self.assertEqual(bl, self.baseline_state())

    def test_accept_header_only_one_role(self):
        self.first_apply()
        self.edit("worker-a", lambda t: "New head\n" + t)
        self.edit("worker-b", lambda t: "Another new head\n" + t)
        code, out = run(self.args("--accept-header", "worker-a"))
        self.assertEqual(code, 0, out)
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn("worker-b", out)

    def test_no_accept_all_switch(self):
        with self.assertRaises(SystemExit):
            run(self.args("--accept-header"))


class TestRegister(Base):
    """--register: add a role that is in the config but not yet in the fingerprints."""

    def setUp(self):
        super().setUp()
        self.first_apply()
        self.add_role("worker-c")

    def fp(self):
        return json.loads(self.baseline_state()["fingerprints.json"])

    def reg(self, rid="worker-c"):
        return run(self.args("--register", rid))

    def test_new_role_in_config_halts_check_and_apply_until_registered(self):
        code, out = self.check()
        self.assertNotEqual(code, 0, out)
        self.assertIn("worker-c", out)
        before = self.snapshot()
        code, out = self.apply()
        self.assertEqual(code, 2, out)
        self.assertEqual(before, self.snapshot())

    def test_register_success_writes_only_that_role_fingerprint(self):
        old = self.fp()
        files_before = self.snapshot()
        baseline_before = self.baseline_state()
        code, out = self.reg()
        self.assertEqual(code, 0, out)
        new = self.fp()
        self.assertEqual({k: v for k, v in new["roles"].items() if k != "worker-c"}, old["roles"])
        head, section, tail = self.split(S.read(self.path("worker-c")), "worker-c")
        self.assertEqual(new["roles"]["worker-c"], {"head": S.sha(head), "section": S.sha(section), "tail": S.sha(tail)})
        self.assertEqual(files_before, self.snapshot())
        after = self.baseline_state()
        self.assertEqual(baseline_before["last-source.md"], after["last-source.md"])
        self.assertEqual(new["sourceFingerprint"], old["sourceFingerprint"])
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("worker-c", out)

    def test_registered_role_gets_next_apply(self):
        self.assertEqual(self.reg()[0], 0)
        anchor = self.info["anchor"]
        self.edit_rules(lambda s: s.replace(anchor, "Registered roles are synced too.\n\n" + anchor, 1))
        code, out = self.apply()
        self.assertEqual(code, 0, out)
        self.assertIn("worker-c", out)
        self.assertIn("Registered roles are synced too.", S.read(self.path("worker-c")))
        self.assertEqual(self.check()[0], 0)

    def test_two_new_roles_one_after_another(self):
        self.add_role("worker-d")
        self.assertEqual(self.reg("worker-c")[0], 0)
        self.assertEqual(self.reg("worker-d")[0], 0)
        self.assertEqual(self.check()[0], 0)

    def test_register_refuses_when_section_differs_from_source(self):
        self.edit("worker-c", self.tamper_section)
        before = self.baseline_state()
        code, out = self.reg()
        self.assertEqual(code, 2, out)
        self.assertIn("shared section", out)
        self.assertEqual(before, self.baseline_state())

    def test_register_refuses_role_not_in_config(self):
        before = self.baseline_state()
        code, out = self.reg("worker-z")
        self.assertEqual(code, 2, out)
        self.assertIn("no such role", out)
        self.assertEqual(before, self.baseline_state())

    def test_register_refuses_already_registered_role(self):
        before = self.baseline_state()
        code, out = self.reg("worker-a")
        self.assertEqual(code, 2, out)
        self.assertIn("already registered", out)
        self.assertEqual(before, self.baseline_state())

    def test_register_refuses_without_baseline(self):
        shutil.rmtree(self.state)
        code, out = self.reg()
        self.assertEqual(code, 2, out)
        self.assertIn("baseline", out)
        self.assertIsNone(self.baseline_state())

    def test_register_refuses_when_markers_missing(self):
        self.edit("worker-c", lambda t: t.replace(self.info["end"], "## Renamed\n"))
        before = self.baseline_state()
        code, out = self.reg()
        self.assertEqual(code, 2, out)
        self.assertIn("cannot split", out)
        self.assertEqual(before, self.baseline_state())

    def test_register_does_not_touch_agents_or_source(self):
        files = self.snapshot()
        src = S.read(os.path.join(self.rules, S.LANG_FILES[self.LANG]["rules"]))
        self.reg()
        self.assertEqual(files, self.snapshot())
        self.assertEqual(src, S.read(os.path.join(self.rules, S.LANG_FILES[self.LANG]["rules"])))

    def test_register_and_apply_are_mutually_exclusive_options(self):
        with self.assertRaises(SystemExit):
            run(self.args("--register", "worker-c", "--apply"))


# Run every test class once for each rule language.
_BASES = [TestMarkersAndConfig, TestGenerate, TestFirstApply, TestHalts, TestAuditorDeclaration,
          TestNormalSync, TestAcceptHeader, TestRegister]
for _cls in _BASES:
    for _lang in INFO:
        _name = f"{_cls.__name__}_{_lang.replace('-', '_')}"
        globals()[_name] = type(_name, (_cls,), {"LANG": _lang})
    del globals()[_cls.__name__]  # keep the language-less base out of the run
del _cls, _lang, _name


if __name__ == "__main__":
    unittest.main()
