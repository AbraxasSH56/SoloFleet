// Offline tests for the reply-card texts in both locales (lexicon.mjs): model labels, change line, system-sentence replacements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crew } from '../plugins/personal-inbox/crew-config.mjs';
import { cardText, englishCleanupEnabled } from '../plugins/personal-inbox/lexicon.mjs';
import { executionModelLabel, composeChange, translateSystemEnglish, MODEL_LINE_RE } from '../plugins/personal-inbox/execution-record.mjs';

const withLocale = (loc, fn) => { const before = crew.locale; crew.locale = loc; try { return fn(); } finally { crew.locale = before; } };

test('both card text sets define exactly the same keys', () => {
  assert.deepEqual(Object.keys(cardText('en')).sort(), Object.keys(cardText('zh-CN')).sort());
});

test('model labels follow the locale', () => {
  assert.equal(withLocale('zh-CN', () => executionModelLabel(undefined)), '模型未知');
  assert.equal(withLocale('en', () => executionModelLabel(undefined)), 'model unknown');
  assert.equal(withLocale('en', () => executionModelLabel('claude-cli/claude-sonnet-5-5')), 'Sonnet/Cli');
  assert.match(withLocale('en', () => executionModelLabel('mystery/claude-sonnet-5-5')), /^Sonnet\/route unknown$/);
  // the card's own model line is recognised in either language
  assert.ok(MODEL_LINE_RE.test('Sonnet/route unknown · high'));
  assert.ok(MODEL_LINE_RE.test('Sonnet/入口未知 · high'));
  assert.ok(MODEL_LINE_RE.test('Opus/Cli · medium'));
});

test('the "changed files" line follows the locale', () => {
  assert.equal(withLocale('zh-CN', () => composeChange('none', [], [], [])), '未列');
  assert.equal(withLocale('en', () => composeChange('none', [], [], [])), 'not listed');
  assert.equal(withLocale('en', () => composeChange('valid', [], [], [])), 'none');
});

test('replacement sentences for the two fixed system messages follow the locale', () => {
  const empty = 'The AI service returned an empty reply. Please try again.';
  assert.match(withLocale('zh-CN', () => translateSystemEnglish(empty)), /没有生成可发的内容/);
  assert.match(withLocale('en', () => translateSystemEnglish(empty)), /produced nothing to send/);
  assert.equal(translateSystemEnglish('something else'), null);
});

test('the English-process-paragraph cleanup only runs for zh-CN', () => {
  assert.equal(englishCleanupEnabled('zh-CN'), true);
  assert.equal(englishCleanupEnabled('en'), false);
  assert.equal(withLocale('en', () => englishCleanupEnabled()), false);
});
