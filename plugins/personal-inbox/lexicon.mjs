// Lexicon: literal words the programs match in text (progress-sentence openers, card labels,
// report headers, sensitive button words ...). Selected by config "locale".
// Status: the zh-CN set is complete (it is what the reference deployment ran on).
// The "en" set is NOT finished yet: see docs/*/localization.md for the list of places that
// still match literals. The desktop sensitive-word list is the exception: Chinese and English
// words are ALWAYS both active (it guards payments, sends and deletions).
import { crew } from './crew-config.mjs';

export const LOCALES = ['en', 'zh-CN'];
export const locale = () => (LOCALES.includes(crew.locale) ? crew.locale : 'en');

const OWNER = () => crew.owner?.title ? crew.owner.title : 'the owner';

const ZH = {
  progressOpeners: ['完成：', '进行中：', '没跑成：', '等主人：', '卡住：'],
  statusLine: '状态：',
  sectionCurrentStatus: '当前状态',
  sectionWaitingForOwner: '等主人拍板',
  sectionResults: '当前成果',
  auditLevelLabel: '审计级别',
  authorizationLabel: '授权范围',
  reportVerdict: { pass: '我得：通过', fail: '我得：不通过', cannot: '我得：审不了' },
  ledgerStatus: { received: '收到', decided: '已定', revoked: '撤销', pending: '没回' },
  ledgerQuoteLabel: '原话',
  queueSkipReasons: ['不用了', '完成', '被接手'],
  autoRegisterPrefix: '（程序补登记）',
  quotaResumePrefix: '【额度恢复·程序代发】',
  helpRequestMarker: '【求助】',
  helpReplyMarker: '【求助回复】',
};

const EN = {
  progressOpeners: ['Done: ', 'In progress: ', 'Failed to run: ', 'Waiting for owner: ', 'Stuck: '],
  statusLine: 'Status: ',
  sectionCurrentStatus: 'Current status',
  sectionWaitingForOwner: 'Waiting for the owner',
  sectionResults: 'Current results',
  auditLevelLabel: 'Audit level',
  authorizationLabel: 'Authorization scope',
  reportVerdict: { pass: 'Verdict: pass', fail: 'Verdict: fail', cannot: 'Verdict: cannot audit' },
  ledgerStatus: { received: 'received', decided: 'decided', revoked: 'revoked', pending: 'no reply' },
  ledgerQuoteLabel: 'quote',
  queueSkipReasons: ['not needed', 'done', 'taken over'],
  autoRegisterPrefix: '(auto-registered) ',
  quotaResumePrefix: '[Quota restored · sent by program] ',
  helpRequestMarker: '[Help]',
  helpReplyMarker: '[Help reply]',
};

export const lexicon = (loc = locale()) => (loc === 'en' ? EN : ZH);
export const ownerTitle = OWNER;

/** Desktop sensitive-button words: both languages are always active. */
export const SENSITIVE_WORDS_EN = ['submit', 'send', 'pay', 'purchase', 'buy', 'placeorder', 'checkout', 'delete', 'remove', 'install', 'upload', 'confirmpurchase', 'transfer', 'subscribe', 'authorize']; // same list as the English words in sensitive-words.json (spaces removed, lower case)

// ---- Text shown on the reply card (execution-record.mjs) and the two replacement sentences. Both sets are complete. ----
const CARD_ZH = {
  modelUnknown: '模型未知', modelUnrecognized: '模型未识别', routeUnknown: '入口未知', labelUnknown: '型号未知', effortUnknown: '档位未知',
  modelAndEffortUnknown: '模型和档位：未知（本轮没有拿到用量状态）',
  messageOther: { edit: ['编辑了消息', '编辑消息'], unsend: ['撤回了消息', '撤回消息'], delete: ['删除了消息', '删除消息'], react: ['加了反应', '加反应'],
    pin: ['置顶了消息', '置顶消息'], unpin: ['取消了置顶', '取消置顶'], poll: ['发了投票', '发投票'], poll_vote: ['投了票', '投票'], thread_create: ['建了消息线程', '建消息线程'] },
  changeLabel: '修改：', unlisted: '未列', unlistedTools: (inner) => `未列（工具记录：${inner}）`, none: '无',
  listSep: '、', segSep: '；', more: (n) => ` 等 ${n} 个`,
  hiddenN: (n) => `${n} 个名称隐藏`, outsideN: (n) => `${n} 个范围外文件`, also: (c) => `另有 ${c}`,
  leaked: (n, names) => `另有 ${n} 个漏列：${names}`, leakedHidden: (n) => `另有 ${n} 个漏列，名称隐藏`, leakedOutside: (n) => `另有 ${n} 个漏列，在范围外`,
  wrap: (inner) => `（${inner}）`, withExtra: (inner, extra) => `${inner}；另有 ${extra}`,
  quotaUnknown: '未知', quotaResetPassed: '已到重置点，待新读数', quotaRemaining: (p) => `余 ${p}%`,
  quotaApi: '额度：API 额度（用完即停，余额看 Console）', quotaLine: (s, w, f, fam = 'fable') => `额度：5h ${s} · 周限额（总量/${fam}）：${w}/${f}`,
  sampleCli: 'CodexBar 命令行采样', sampleCache: 'CodexBar 缓存',
  sampleNote: (src, at, mins, failed) => `（${src} ${at}，距今 ${mins} 分钟${failed ? '，刷新失败，保留旧值' : ''}）`,
  quotaUnavailable: '额度：暂时取不到',
  emptyReplyReplacement: '⚠️ 这一轮我没有生成可发的内容，请再叫我一次。',
  unconfirmedReplacement: '上一条回复我没法确认是否送到，不会自动重发，缺什么请再问我。',
};
const CARD_EN = {
  modelUnknown: 'model unknown', modelUnrecognized: 'model not recognized', routeUnknown: 'route unknown', labelUnknown: 'model unknown', effortUnknown: 'effort unknown',
  modelAndEffortUnknown: 'Model and effort: unknown (no usage state this turn)',
  messageOther: { edit: ['edited a message', 'edit message'], unsend: ['unsent a message', 'unsend message'], delete: ['deleted a message', 'delete message'], react: ['added a reaction', 'add reaction'],
    pin: ['pinned a message', 'pin message'], unpin: ['unpinned a message', 'unpin message'], poll: ['posted a poll', 'post poll'], poll_vote: ['voted in a poll', 'vote in poll'], thread_create: ['created a thread', 'create thread'] },
  changeLabel: 'Changed: ', unlisted: 'not listed', unlistedTools: (inner) => `not listed (tool log: ${inner})`, none: 'none',
  listSep: ', ', segSep: '; ', more: (n) => ` and ${n} more`,
  hiddenN: (n) => `${n} with hidden names`, outsideN: (n) => `${n} outside the scope`, also: (c) => `also ${c}`,
  leaked: (n, names) => `${n} more not listed: ${names}`, leakedHidden: (n) => `${n} more not listed, names hidden`, leakedOutside: (n) => `${n} more not listed, outside the scope`,
  wrap: (inner) => ` (${inner})`, withExtra: (inner, extra) => `${inner}; also ${extra}`,
  quotaUnknown: 'unknown', quotaResetPassed: 'reset passed, waiting for a new reading', quotaRemaining: (p) => `${p}% left`,
  quotaApi: 'Quota: API credit (stops when used up; see the Console for the balance)', quotaLine: (s, w, f, fam = 'fable') => `Quota: 5h ${s} · weekly (total/${fam}): ${w}/${f}`,
  sampleCli: 'CodexBar CLI sample', sampleCache: 'CodexBar cache',
  sampleNote: (src, at, mins, failed) => `(${src} ${at}, ${mins} min ago${failed ? ', refresh failed, keeping the old value' : ''})`,
  quotaUnavailable: 'Quota: not available right now',
  emptyReplyReplacement: '⚠️ I produced nothing to send this turn. Please call me again.',
  unconfirmedReplacement: "I could not confirm that my previous reply arrived, and I will not resend it automatically. Ask me again for anything that is missing.",
};
export const cardText = (loc = locale()) => (loc === 'en' ? CARD_EN : CARD_ZH);
export const cardTextAll = (key) => [CARD_EN[key], CARD_ZH[key]];
/** The English-process-paragraph cleanup was written for deployments whose rules say "always reply in Chinese": it only runs for zh-CN. */
export const englishCleanupEnabled = (loc = locale()) => loc === 'zh-CN';
