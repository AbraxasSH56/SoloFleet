// Existing architecture: roles delegate through OpenClaw (sessions_spawn, Workboard) and
// reach each other by Discord mention, not through Claude's native helpers or cross-session messaging.
export const nativeDelegationNames = ['agent', 'task', 'spawn_agent', 'send_message', 'sendmessage', 'list_agents', 'listagents'];
// 没有角色编号的回合照旧不拦（和改前一样）。
export function blockControllerNativeDelegation(event, ctx) {
  const agentId = ctx?.agentId;
  if (typeof agentId !== 'string' || agentId.trim() === '') return;
  if (!nativeDelegationNames.includes(String(event?.toolName ?? ctx?.toolName ?? '').toLowerCase())) return;
  return {
    block: true,
    blockReason: '这个角色不能用 Claude 自带的派助手、传话和列会话工具。要派活用 OpenClaw 的 sessions_spawn 和原来的 Workboard 任务；要叫别的 bot（包括桌面角色），在当前线程里点名它。',
  };
}
