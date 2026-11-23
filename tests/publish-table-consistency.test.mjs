// publish-self.py carries its own copy of the words (LEX_ALL); this test compares it with lexicon.mjs for both locales.
// publish-self.py 自带一份词表（LEX_ALL），这条测试把它和 lexicon.mjs 逐项比。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexicon } from '../plugins/personal-inbox/lexicon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const py = spawnSync('/usr/bin/python3', ['-I', '-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("p", ${JSON.stringify(join(ROOT, 'scripts/automation/publish-self.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.LEX_ALL, ensure_ascii=False))`], { encoding: 'utf8' });
assert.equal(py.status, 0, py.stderr);
const ALL = JSON.parse(py.stdout);

for (const loc of ['zh-CN', 'en']) {
  test(`publish-self.py words equal the lexicon (${loc})`, () => {
    const L = lexicon(loc); const P = ALL[loc];
    assert.equal(P.audit, L.layout.audit);
    assert.equal(P.publish, L.layout.auditPublish);
    assert.equal(P.receipts, L.layout.auditReceipts);
    const map = { patrol: ['patrol', L.layout.auditPatrol], deepReview: ['deepReview', L.layout.auditDeep], weekly: ['weekly', L.layout.auditWeekly] };
    const jobKey = { patrol: 'patrol', deepReview: 'deepReview', weekly: 'weekly' };
    for (const [k, [, dir]] of Object.entries(map)) {
      const t = P.tasks[k]; const pt = L.publishTasks[k];
      assert.equal(t.name, L.jobNames[jobKey[k]], k);
      assert.equal(t.dir, dir, k);
      assert.equal(t.label, pt.label, k);
      assert.equal(t.report_line, pt.reportLine, k);
      assert.equal(t.report_file, pt.reportFile, k);
    }
    assert.deepEqual(P.files, L.publishFiles && { summary: L.publishFiles.summary, receipt: L.publishFiles.receipt, failed: L.publishFiles.failed });
    assert.deepEqual(P.states, { sending: L.publishStates.sending, delivered: L.publishStates.delivered, toVerify: L.publishStates.toVerify });
    assert.deepEqual(P.receipt, L.receiptKeys);
    assert.deepEqual(P.record, { task: L.auditRecordKeys.task, businessDate: L.auditRecordKeys.businessDate, cutoff: L.auditRecordKeys.cutoff, execution: L.auditRecordKeys.execution });
    assert.equal(P.record_done, L.auditRecordValues.done);
  });
}
