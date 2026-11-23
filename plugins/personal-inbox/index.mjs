// Plugin entry: registers the note-inbox and document-sync tools and wires every program-layer module (gates, guards, notices) into OpenClaw hooks.
import { captureInbox, linkInboxCard, lookupInbox } from './store.mjs';
import { applySyncObligation, registerSyncObligation, verifySyncCard } from './sync.mjs';
import { blockControllerNativeDelegation } from './delegation.mjs';
import { dirname, join } from 'node:path';
import { crew } from './crew-config.mjs';
import { lexicon } from './lexicon.mjs';
const W = lexicon(); // folder names follow config "locale"
import { registerQuotaRecovery } from './quota-recovery.mjs';
import { registerExecutionRecord } from './execution-record.mjs';
import { registerDesktopScreenLock } from './desktop-lock.mjs';
import { realApprovalSend } from './approval-card.mjs';
import { recordApprovalExpiry, recordApprovalReissue } from './pending-ledger.mjs';
import { registerApprovalReminder } from './approval-reminder.mjs';
import { createCompletionNotice, realCompletionSend, realParentChannel } from './completion-notice.mjs';
import { entryHintFor } from './project-files.mjs';
import { createSmallJobNotice, registerSmallJobNotice } from './small-job-notice.mjs';
import { createRequestWatch, registerRequestWatch } from './request-watch.mjs';
import { registerAuditGuard } from './audit-guard.mjs';
import { registerAuditGate } from './audit-gate.mjs';
import { registerCardThreadLinks } from './card-thread-map.mjs';
import { registerPendingTools, makeMessageReader } from './pending-tools.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile); // 插件在 Gateway 进程里：外部命令必须异步，同步会堵住 Gateway 自己的事件循环、命令连不上它
import { appendFileSync, mkdirSync } from 'node:fs';

const string = (maxLength, description) => ({ type: 'string', minLength: 1, maxLength, description });

const captureParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'originalText', 'idempotencyKey'],
  properties: {
    kind: { type: 'string', enum: ['note', 'action'], description: 'Note for a static record; action when execution or later follow-up is needed.' },
    originalText: string(12000, 'The exact user wording to preserve, including mixed intent if relevant.'),
    idempotencyKey: string(200, 'Stable source message ID plus segment number; reuse it on retries.'),
    sourceRef: string(300, 'Optional source message or thread reference.'),
  },
};

const lookupParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: string(32, 'Inbox short ID, for example I-0001.'),
    query: string(200, 'Natural words from the original text or source reference.'),
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum matches; default 10.' },
  },
};

const linkParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'workboardCardId'],
  properties: {
    id: string(32, 'Inbox action ID, for example I-0001.'),
    workboardCardId: string(128, 'Card ID returned by the native workboard_create tool.'),
  },
};

const syncRegisterParameters = {
  type: 'object', additionalProperties: false,
  required: ['cardId', 'obligationId', 'targetPath', 'newText'],
  properties: {
    cardId: string(128, 'Stable Workboard card ID.'),
    obligationId: string(128, 'Stable synchronization obligation ID within the card.'),
    targetPath: string(2000, 'Absolute path of the project file to synchronize.'),
    oldText: { type: ['string', 'null'], maxLength: 12000, description: 'Exact unique old text to replace; null only for a new file.' },
    newText: string(12000, 'Expected replacement text or complete content of a new file.'),
    expectedRevision: { type: 'integer', minimum: 0, description: '0 for new obligation; current revision for a deliberate change.' },
  },
};

const syncApplyParameters = {
  type: 'object', additionalProperties: false,
  required: ['cardId', 'obligationId', 'expectedRevision'],
  properties: {
    cardId: string(128, 'Stable Workboard card ID.'),
    obligationId: string(128, 'Registered synchronization obligation ID.'),
    expectedRevision: { type: 'integer', minimum: 1, description: 'Revision returned by registration.' },
  },
};

const syncVerifyParameters = {
  type: 'object', additionalProperties: false, required: ['cardId'],
  properties: { cardId: string(128, 'Stable Workboard card ID to verify against actual project files.') },
};

function result(details) {
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
}

function registerWorkspaceTool(api, name, description, parameters, operation) {
  api.registerTool({
    contextVersion: 2,
    create(ctx) {
      if (!ctx.workspaceDir) return null;
      return {
        name,
        description,
        parameters,
        execute(_toolCallId, params) {
          ctx.assertInvocationCurrent();
          return result(operation({ ...params, workspaceDir: ctx.workspaceDir }));
        },
      };
    },
  }, { name });
}

export default {
  id: 'personal-inbox',
  name: 'Personal Inbox',
  description: 'Save private notes and action requests in the active agent workspace.',
  register(api) {
    api.on('before_tool_call', blockControllerNativeDelegation, {
      registrationId: 'controller-openclaw-delegation-only',
    });
    const stateWorkspace = api.config?.agents?.entries?.main?.workspace;
    const syncRoot = api.pluginConfig?.syncRoot ?? (stateWorkspace ? crew.paths.projectRoot : null); // project root (the repo checkout); no main workspace configured = program layer off
    const dataRoot = syncRoot ? (crew.paths.dataRoot || null) : null; // project folders, ledgers and run records live here
    const desktopDir = join(crew.paths.workspaceRoot || join(syncRoot ?? '', 'runtime'), 'desktop');
// 审批卡过期（超时／取消）登记进“等你定”台账；同一件事重新申请出新卡时把旧的过期条目改已定。台账路径用项目根目录拼，失败由调用方吞掉只记日志。
    const pendingLedgerPath = dataRoot ? join(dataRoot, W.layout.audit, W.layout.auditAwaiting, W.layout.awaitingLedgerFile) : null;
    const approvalLedger = pendingLedgerPath ? { expired: (info) => recordApprovalExpiry(pendingLedgerPath, info), reissued: (info) => recordApprovalReissue(pendingLedgerPath, info) } : null;
    registerApprovalReminder(api, { ledgerPath: pendingLedgerPath, syncRoot, log: (row) => { try { api.logger?.info?.(`approval-reminder: ${JSON.stringify(row)}`); } catch { /* 只是记录 */ } } });
    registerQuotaRecovery(api, syncRoot);
    const executionRecord = registerExecutionRecord(api);
    // 官方把插件复制到临时目录里加载，路径不能从插件文件自己的位置推，要用项目根目录。
    registerDesktopScreenLock(api, syncRoot
      ? { lockPath: join(desktopDir, 'screen.lock'), logPath: join(desktopDir, 'screen-lock.log'), wordsPath: join(syncRoot, 'plugins', 'personal-inbox', 'sensitive-words.json'), sendApprovalNotice: realApprovalSend, dedupPath: join(desktopDir, 'approval-notice-dedup.json'), approvalLedger }
      : { lockPath: null });
    // 审计守门：只管 系统审计、task-auditor 的命令和写入位置；规则文件在项目里，守门记录放资料根下。
    registerAuditGuard(api, syncRoot
      ? {
          rulesPath: join(syncRoot, 'plugins', 'personal-inbox', 'audit-guard-rules.json'),
          logDir: join(dataRoot ?? syncRoot, '运行记录', '守门'),
        }
      : {});
    // 结案关口和“等你定”两个工具（3.9）：账本和记录放在资料根下；规则文件改动后重启才生效。
// 没建卡的小活，bot 没在主区域报时程序补一行（只认发话人编号是主人；排除频道走 channel-exclusions.json）。
    const smallJob = createSmallJobNotice({ syncRoot, dataRoot, getWrites: (runId) => executionRecord?.record?.writesOf?.(runId) ?? [], getToolSummary: (runId) => executionRecord?.record?.toolSummaryOf?.(runId) ?? null, parentChannelOf: realParentChannel, send: dataRoot ? realCompletionSend : null, log: (row) => { try { api.logger?.info?.(`small-job-notice: ${JSON.stringify(row)}`); } catch { /* 只是记录 */ } } });
    if (dataRoot) registerSmallJobNotice(api, smallJob);
    // “等你定”登记兜底：bot 用 message 工具发出“带按钮、只许主人点”的请示时，记一行流水；台账由“等你定”脚本核账补登记，这里不碰台账。
    if (dataRoot) registerRequestWatch(api, createRequestWatch({ dataRoot, log: (row) => { try { api.logger?.info?.(`request-watch: ${JSON.stringify(row)}`); } catch { /* 只是记录 */ } } }));
    if (dataRoot) {
      const closeDir = join(dataRoot, '运行记录', '结案');
      registerAuditGate(api, {
        ledgerPath: join(closeDir, '账.json'),
        sendApprovalNotice: realApprovalSend,
        dedupPath: join(desktopDir, 'approval-notice-dedup.json'),
        approvalLedger,
        completion: createCompletionNotice({ syncRoot, dataRoot, send: realCompletionSend, onSent: (x) => smallJob.noteCompletionSent(x.runId), entryHint: (channelId) => entryHintFor({ dataRoot, indexPath: join(dataRoot, 'INDEX.md'), channelId }) }),
        log: (row) => { mkdirSync(closeDir, { recursive: true }); appendFileSync(join(closeDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ 时间: new Date().toISOString(), ...row })}\n`); },
        getCard: async (id) => {
          // 优先只读任务板数据库（毫秒级）：钩子只有 15 秒，命令行子进程光启动就要 6 秒，在 Gateway 忙的时候会超时；读不到再退回命令行
          try {
            const { DatabaseSync } = await import('node:sqlite');
            const db = new DatabaseSync(join(crew.paths.openclawHome, 'plugins', 'workboard', 'workboard.sqlite'), { readOnly: true });
            try {
              const rows = db.prepare('SELECT id, title, notes, status, completed_at FROM workboard_cards WHERE id = ? OR id LIKE ? LIMIT 2').all(String(id), `${String(id).replace(/[%_]/g, '')}%`);
              const row = rows.find((r) => r.id === String(id)) ?? (rows.length === 1 ? rows[0] : null);
              if (row) {
                const labels = db.prepare('SELECT label FROM workboard_card_labels WHERE card_id = ? ORDER BY ordinal').all(row.id).map((r) => r.label);
                return { id: row.id, title: row.title, notes: row.notes ?? '', status: row.status, completedAt: row.completed_at ?? null, labels };
              }
            } finally { db.close(); }
          } catch { /* 退回命令行 */ }
          try { const { stdout: out } = await execFileAsync(crew.paths.openclawBin, ['workboard', 'show', String(id), '--json'], { encoding: 'utf8', timeout: 11000, env: { ...process.env, NODE_NO_WARNINGS: '1' } }); const d = JSON.parse(out.slice(out.indexOf('{'))); return d.card ?? d; } catch { return null; }
        },
        isWorkerRun: (ctx) => /:subagent:workboard-/.test(String(ctx?.sessionKey ?? '')),
      });
    }
    // 卡↔线程对应（小补三）：工具调用和开线程时自动记“哪个线程对着哪张卡”，只记不改卡；桌面角色的六类审批卡先查它。
    if (dataRoot) {
      const linkDir = join(dataRoot, '运行记录', '卡线程');
      registerCardThreadLinks(api, {
        dataRoot,
        log: (row) => { try { mkdirSync(linkDir, { recursive: true }); appendFileSync(join(linkDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ 时间: new Date().toISOString(), ...row })}\n`); } catch { /* 记日志失败不影响 */ } },
      });
    }
    const syncPaths = () => {
      if (!stateWorkspace || !syncRoot) throw new Error('Main agent workspace and syncRoot are required for document synchronization');
      return { stateWorkspace, syncRoot };
    };
    registerWorkspaceTool(
      api,
      'personal_inbox_capture',
      'Persist a user note or action this turn. Keep originalText exact and use a stable source-message idempotencyKey. For an action, create its Workboard card with the native workboard_create tool, then call personal_inbox_link_card. Confirm only after persisted is true.',
      captureParameters,
      captureInbox,
    );
    registerWorkspaceTool(
      api,
      'personal_inbox_lookup',
      'Read saved inbox items by short ID or natural words. The plugin does not verify Workboard progress; use native Workboard read and actual artifacts before reporting progress or completion.',
      lookupParameters,
      lookupInbox,
    );
    registerWorkspaceTool(
      api,
      'personal_inbox_link_card',
      'After native workboard_create succeeds, associate its returned card ID with a saved action. This records the link only and does not verify card existence or task completion.',
      linkParameters,
      linkInboxCard,
    );
    registerWorkspaceTool(
      api,
      'personal_inbox_sync_register',
      'Register one Workboard card document obligation with a stable ID, exact expected text, and optimistic revision. This does not claim that the file was updated.',
      syncRegisterParameters,
      (params) => registerSyncObligation({ ...syncPaths(), ...params }),
    );
    registerWorkspaceTool(
      api,
      'personal_inbox_sync_apply',
      'Apply a registered document replacement only if the target still matches its recorded base version, then read the actual file back.',
      syncApplyParameters,
      (params) => applySyncObligation({ ...syncPaths(), ...params }),
    );
    registerWorkspaceTool(
      api,
      'personal_inbox_sync_verify',
      'Read registered document obligations and actual project files for a Workboard card. Does not modify files or status.',
      syncVerifyParameters,
      (params) => verifySyncCard({ ...syncPaths(), ...params }),
    );
    // “等你定”两个工具：放在最后注册，顺序和 openclaw.plugin.json 的 contracts.tools 一致；读不到资料根时工具会如实回“没有资料根”。
    registerPendingTools(api, dataRoot
      ? { ledgerPath: join(dataRoot, W.layout.audit, W.layout.auditAwaiting, W.layout.awaitingLedgerFile), readMessage: makeMessageReader(), watchDir: join(dataRoot, '运行记录', '看护') }
      : { ledgerPath: null, readMessage: async () => null });
  },
};
