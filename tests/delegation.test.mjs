// Offline tests for delegation: temporary directories and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockControllerNativeDelegation, nativeDelegationNames } from '../plugins/personal-inbox/delegation.mjs';

const sampleRoles = [
  'main', 'system-auditor', 'probe', 'desktop',
  'worker-a', 'worker-b', 'worker-c', 'worker-d', 'worker-e', 'worker-f', 'worker-g', 'task-auditor',
  'worker-i', 'worker-z', 'taskAuditor', 'diary-bot',
];

test('每个角色（现有的和新编号）的每个原生派助手、传话、列会话工具名都被拦，两种写法都拦', () => {
  for (const agentId of sampleRoles) {
    for (const toolName of [...nativeDelegationNames, 'Agent', 'SendMessage', 'ListAgents', 'send_message', 'list_agents']) {
      const result = blockControllerNativeDelegation({ toolName }, { agentId });
      assert.equal(result?.block, true, `${agentId} ${toolName}`);
      assert.match(result.blockReason, /点名/);
    }
  }
});

test('任何角色编号都拦；没有编号不拦；别的工具不拦', () => {
  for (const toolName of ['sessions_spawn', 'sessions_send', 'message', 'exec', 'computer', 'web_fetch', 'workboard_create', 'read']) {
    assert.equal(blockControllerNativeDelegation({ toolName }, { agentId: 'main' }), undefined, toolName);
    assert.equal(blockControllerNativeDelegation({ toolName }, { agentId: 'worker-i' }), undefined, toolName);
  }
  assert.equal(blockControllerNativeDelegation({ toolName: 'agent' }, { agentId: 'someone-else' })?.block, true);
  assert.equal(blockControllerNativeDelegation({ toolName: 'agent' }, {}), undefined);
  assert.equal(blockControllerNativeDelegation({ toolName: 'agent' }, undefined), undefined);
  assert.equal(blockControllerNativeDelegation({ toolName: 'agent' }, { agentId: undefined }), undefined);
  assert.equal(blockControllerNativeDelegation({ toolName: 'agent' }, { agentId: '' }), undefined);
});
