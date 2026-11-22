// Offline tests for execution record card: temporary directories and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createExecutionRecord, selectClaudeQuota, registerExecutionRecord, createQuotaCacheReader, createSnapshotProcessReader, executionModelLabel, selectClaudeCliQuota, preloadCodeRegions } from '../plugins/personal-inbox/execution-record.mjs';
const time = Date.parse('2026-10-20T18:30:00Z'), profile='/test/.claude/.credentials.json';
const owner=createHash('sha256').update(`codexbar:claude-oauth-cache-profile:v1\0${profile}`).digest('hex');
const snapshot=()=>({entries:[{provider:'codex',primary:{usedPercent:1}},{provider:'claude',quotaOwnerKey:owner,updatedAt:'2026-10-20T18:20:56Z',primary:{usedPercent:68,windowMinutes:300,resetsAt:'2026-10-20T21:39:00Z'},secondary:{usedPercent:92,windowMinutes:10080,resetsAt:'2026-10-24T20:29:00Z'}}]});
const quota=()=>selectClaudeQuota(snapshot(),{credentialProfilePath:profile,now:time});
test('blocked OS read is killed and reaped before another read; no Gateway I/O or surviving helper',async()=>{
 let child,closed=false;
 const read=createSnapshotProcessReader({spawnProcess:(exe,_args,opts)=>{
   child=spawn(exe,['-e','setInterval(()=>{},10000)'],opts);
   child.on('close',()=>{closed=true;});return child;
 }});
 const controller=new AbortController(),result=read('/not-read-by-test',{signal:controller.signal});
 const pid=child.pid;controller.abort();
 await assert.rejects(result,e=>e.code==='ABORT_ERR');
 assert(closed);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('disposable reader returns Claude quota only, omitting other providers and account details',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'openclaw-quota-reader-test-'));
 try{
  const data=snapshot();data.entries[1].email='must-not-leave-helper';
  const file=join(dir,'snapshot.json');await writeFile(file,JSON.stringify(data));
  const output=await createSnapshotProcessReader()(file);
  assert.doesNotMatch(output.toString(),/codex|must-not-leave-helper/);
  assert.equal(selectClaudeQuota(JSON.parse(output),{credentialProfilePath:profile,now:time}).week.remainingPercent,8);
 }finally{await rm(dir,{recursive:true});}
});
test('unresolved OS read cannot stall a reply or fan out retries; later completion permits normal cache read',async()=>{
 let release,reads=0,signal;
 const read=createQuotaCacheReader({timeoutMs:10,read:(_p,opts)=>{reads++;signal=opts.signal;return new Promise(r=>{release=r;});}});
 const p={snapshotPath:'/approved/export',credentialProfilePath:profile,now:time};
 const first=await read(p);assert.equal(first.reason,'snapshot_read_timeout');assert(signal.aborted);
 assert.equal((await read(p)).reason,'snapshot_read_pending');assert.equal(reads,1);
 release(Buffer.from(JSON.stringify(snapshot())));await new Promise(r=>setImmediate(r));
 const next=read(p);release(Buffer.from(JSON.stringify(snapshot())));assert.equal((await next).status,'cached');assert.equal(reads,2);
});
test('one service-owned approval read waits without blocking or duplicating reply reads, then returns its original measurement',async()=>{
 let release,reads=0;
 const cache=createQuotaCacheReader({timeoutMs:5,read:()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
 const controller=new AbortController(),p={snapshotPath:'/approved/cache',credentialProfilePath:profile,now:time};
 const warm=cache({...p,signal:controller.signal,waitForOriginalRead:true});
 await new Promise(resolve=>setTimeout(resolve,12));
 assert.equal((await cache(p)).reason,'snapshot_read_pending');assert.equal(reads,1);
 release(Buffer.from(JSON.stringify(snapshot())));assert.equal((await warm).status,'cached');
});
test('service retirement cancels and reaps its original blocked read; a retired source cannot start another child',async()=>{
 let child,closed=false,reads=0;
 const cache=createQuotaCacheReader({read:createSnapshotProcessReader({spawnProcess:(exe,_args,opts)=>{
  reads++;child=spawn(exe,['-e','setInterval(()=>{},10000)'],opts);child.once('close',()=>{closed=true;});return child;
 }})});
 const controller=new AbortController(),p={snapshotPath:'/not-read-by-fixture',credentialProfilePath:profile,signal:controller.signal,waitForOriginalRead:true};
 const warm=cache(p),pid=child.pid;
 assert.equal((await cache({...p,signal:undefined,waitForOriginalRead:false})).reason,'snapshot_read_pending');
 controller.abort();assert.equal((await warm).reason,'reader_retired');assert(closed);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.equal((await cache(p)).reason,'reader_retired');assert.equal(reads,1);
});
test('actual CodexBar contract uses only matching Claude profile and measured quota; no UI fill-mode reversal or token conversion',()=>{
 const d=snapshot(); d.usageBarsShowUsed=false;
 const q=selectClaudeQuota(d,{credentialProfilePath:profile,now:time});assert.equal(q.session.remainingPercent,32);assert.equal(q.week.usedPercent,92);assert.equal(q.week.remainingPercent,8);assert.equal(q.ageSeconds,544);assert.equal(q.accountIdentity,'not_exposed_by_snapshot');
 assert.equal(selectClaudeQuota(d,{credentialProfilePath:'/other/.credentials.json',now:time}).reason,'profile_mismatch');
 d.entries.push(d.entries[1]);assert.equal(selectClaudeQuota(d,{credentialProfilePath:profile,now:time}).status,'unknown');
});
test('expired resets, invalid or missing measurements stay historical/unknown and never become replenished allowance',()=>{
 const d=snapshot();d.entries[1].primary.resetsAt='2026-10-20T18:29:00Z';let q=selectClaudeQuota(d,{credentialProfilePath:profile,now:time});assert(q.session.resetPassed);assert.equal(q.session.remainingPercent,32);
 d.entries[1].primary.usedPercent='68';assert.equal(selectClaudeQuota(d,{credentialProfilePath:profile,now:time}).session,null);
 d.entries[1].updatedAt='2026-10-21T18:30:00Z';assert.equal(selectClaudeQuota(d,{credentialProfilePath:profile,now:time}).status,'unknown');
});

// ---- 附卡是 Discord 嵌入卡片（channelData.discord.embeds），不再接在正文后面；一轮一张。
// 官方页脚只在"能确认这个载荷实际被官方追加了页脚"时才搬进卡里：末行逐字等于按用量状态算出的页脚，
// 且去掉末行后的正文等于本轮 CLI 最终正文 assistant 事件的文字（itemId＝cli-assistant:<runId>、有 text、无 delta）；否则正文原样保留。
const cli=(secondary={})=>selectClaudeCliQuota([{provider:'claude',usage:{updatedAt:'2026-10-20T18:20:56Z',primary:{usedPercent:68,windowMinutes:300,resetsAt:'2026-10-20T21:39:00Z'},secondary:{usedPercent:39,windowMinutes:10080,resetsAt:'2026-10-25T04:30:00Z',...secondary}}}],{now:time});
const stamp='（CodexBar 命令行采样 2026-10-20 23:50 Asia/Kolkata，距今 9 分钟）';
const quotaOk=`额度：5h 余 32% · 周限额（总量/fable）：余 61%/未知\n${stamp}`;
const answer='Complete natural answer', footer='Sonnet/Cli · high';
const ctxD={channelId:'discord',accountId:'default',conversationId:'channel:123'};
// 上机实测的官方 message 工具返回（19:47～19:52）：落点在 details.to、details.result.target.id、receipt…raw.channelId；成功证据 deliveryStatus:'sent'
const okRet=(to,extra={})=>{const id=to.split(':')[1];return {content:[{type:'text',text:'{}'}],details:{channel:'discord',to,via:'direct',mediaUrl:'/w/a.txt',mediaUrls:['/w/a.txt'],result:{target:{kind:'channel',id},receipt:{primaryPlatformMessageId:'1',platformMessageIds:['1'],parts:[{platformMessageId:'1',kind:'media',index:0,raw:{channel:'discord',messageId:'1',channelId:id}}],raw:[{messageId:'1',channelId:id}]},messageId:'1',channel:'discord'},deliveryStatus:'sent',payloadOutcomes:[{index:0,status:'sent',resultCount:1}],messageDelivery:{status:'settled',partialDelivery:false,createdThreadIds:[],sourceReplyDelivered:true},...extra}};};
const final={kind:'final',channel:'discord',runId:'run1',usageState:{resolvedRef:'claude-cli/claude-sonnet-5-5',reasoningEffort:'high'},payload:{text:`${answer}\n${footer}`,mediaUrls:['original-attachment']}};
// 记录表改放 globalThis 共享，每个用例先清空；工作区和资料目录用真实临时目录（文件身份按真实路径）。
const WS=mkdtempSync(join(tmpdir(),'er-card-ws-')),ZL=mkdtempSync(join(tmpdir(),'er-card-zl-'));
// bot 自列：代码区域识别用本机官方 SDK 的 findCodeRegions；MARK 生成最后一行的名单标记。
const SDK_FILE = process.env.OPENCLAW_SDK_TEXT_CHUNKING || ''; let sdk = null; if (SDK_FILE) { try { sdk = await import(pathToFileURL(SDK_FILE).href); } catch { sdk = null; } } const { findCodeRegions } = sdk?.findCodeRegions ? sdk : await import('./fixtures/code-regions.mjs');
const MARK=files=>`[[oc_changes ${JSON.stringify({files})}]]`;
const listedFinal=(listed,extra={})=>({...final,...extra,payload:{...final.payload,text:`${listed}\n${footer}`}});
const resetShared=()=>{globalThis[Symbol.for('personal-inbox.execution-record.assistantSeen')]?.clear();globalThis[Symbol.for('personal-inbox.execution-record.changeLists')]?.clear();globalThis[Symbol.for('personal-inbox.execution-record.runMarkers')]?.clear();globalThis[Symbol.for('personal-inbox.execution-record.fragments')]?.clear();delete globalThis[Symbol.for('personal-inbox.execution-record.runs.v1')];};
const make=(q=cli())=>(resetShared(),createExecutionRecord({now:()=>time,readQuota:async()=>q,workspaceFor:()=>WS,ziliaoRoot:ZL,findCodeRegions}));
const started=(r,runId='run1')=>r.observe({runId,stream:'lifecycle',data:{phase:'start'}});
const answered=(r,runId='run1',text=answer)=>r.observe({runId,stream:'assistant',data:{itemId:`cli-assistant:${runId}`,text}});
const wrote=(r,file,id,runId='run1')=>r.afterTool({toolName:'Write',params:{file_path:file},result:{ok:true}},{runId,toolCallId:id});
const card=x=>x.payload.channelData.discord.embeds.at(-1).description.split('\n');
const boxed=x=>{assert.equal(x.payload.channelData.discord.embeds.length>=1,true);assert.deepEqual(x.payload.mediaUrls,['original-attachment']);};
test('executionModelLabel names the real transport and never guesses',()=>{
 assert.equal(executionModelLabel('claude-cli/claude-sonnet-5-5'),'Sonnet/Cli');
 assert.equal(executionModelLabel('claude-cli/claude-opus-5-5'),'Opus/Cli');
 assert.equal(executionModelLabel('anthropic/claude-sonnet-5-5'),'Sonnet/api');
 assert.equal(executionModelLabel('unverified/claude-opus-5-5'),'Opus/入口未知');
 assert.equal(executionModelLabel('claude-cli/new-model-unverified'),'模型未识别');
});
test('L6 backup-bot batch: API routes get /api model line and an API quota line, never read the subscription quota; CLI card unchanged',async()=>{
 assert.equal(executionModelLabel('anthropic-api/claude-sonnet-5-5'),'Sonnet/api');
 assert.equal(executionModelLabel('anthropic-api/claude-opus-5-5'),'Opus/api');
 assert.equal(executionModelLabel('anthropic/claude-fable-5-2'),'Fable/api');
 assert.equal(executionModelLabel('claude-cli/claude-fable-5-2'),'Fable/Cli');
 assert.equal(executionModelLabel('anthropic-api/new-model-unverified'),'模型未识别');
 assert.equal(executionModelLabel('anthropic-apix/claude-opus-5-5'),'Opus/入口未知');
 // 密钥分开：备用A、备用B各自的提供商同样算 API 路径；名字不在名单里的仍不认
 assert.equal(executionModelLabel('anthropic-standby-a/claude-fable-5-2'),'Fable/api');
 assert.equal(executionModelLabel('anthropic-standby-b/claude-opus-5-5'),'Opus/api');
 assert.equal(executionModelLabel('anthropic-standby-a2/claude-fable-5-2'),'Fable/入口未知');
 for(const [ref,line0] of [['anthropic/claude-fable-5-2','Fable/api · high'],['anthropic-api/claude-opus-5-5','Opus/api · high'],['anthropic-api/claude-sonnet-5-5','Sonnet/api · high']]){
  let reads=0;
  resetShared();
  const r=createExecutionRecord({now:()=>time,readQuota:async()=>{reads++;return cli();},workspaceFor:()=>WS,ziliaoRoot:ZL,findCodeRegions});
  started(r);answered(r);
  const x=await r.payload({...final,usageState:{resolvedRef:ref,reasoningEffort:'high'},payload:{...final.payload,text:answer}});boxed(x);
  assert.equal(card(x)[0],line0,ref);
  assert.equal(card(x)[1],'额度：API 额度（用完即停，余额看 Console）',ref);
  assert.equal(card(x).length,3,ref);
  assert.doesNotMatch(card(x).join('\n'),/5h|周限额|CodexBar/,ref);
  assert.equal(reads,0,`${ref} must not read the subscription quota`);
 }
 // 订阅路径：仍读订阅额度、卡片原样
 let cliReads=0;resetShared();
 const c=createExecutionRecord({now:()=>time,readQuota:async()=>{cliReads++;return cli();},workspaceFor:()=>WS,ziliaoRoot:ZL,findCodeRegions});
 started(c);answered(c);
 const y=await c.payload({...final,payload:{...final.payload,text:answer}});
 assert.equal(cliReads,1);assert.deepEqual(card(y).slice(0,3),[footer,...quotaOk.split('\n')]);
});
test('card 1: confirmed official footer moves into the embed card; body keeps no footer; attachment kept',async()=>{
 const r=make();started(r);const listed=`${answer}\n${MARK(['status.md'])}`;answered(r,'run1',listed);wrote(r,'status.md','w1');
 const x=await r.payload(listedFinal(listed));boxed(x);
 assert.equal(x.payload.text,answer);   // 页脚搬走，名单标记行也删掉
 assert.deepEqual(card(x),[footer,...quotaOk.split('\n'),'修改：status.md']);
});
test('card 1b: footer that cannot be confirmed (no final assistant event, only intermediate deltas, or transformed body) stays in the body; card still has three lines',async()=>{
 const none=make();started(none);let x=await none.payload(final);assert.equal(x.payload.text,`${answer}\n${footer}`);assert.equal(card(x).length,4);assert.equal(card(x)[0],footer);
 const mid=make();started(mid);mid.observe({runId:'run1',stream:'assistant',data:{itemId:'cli-assistant:run1',text:answer,delta:answer}});
 x=await mid.payload(final);assert.equal(x.payload.text,`${answer}\n${footer}`);
 const diff=make();started(diff);answered(diff,'run1','Complete  natural answer');x=await diff.payload(final);assert.equal(x.payload.text,`${answer}\n${footer}`);
});
test('card 1c: body that merely ends with a model-looking line is never trimmed (no footer appended)',async()=>{
 const r=make();started(r);const body=`quote:\n${footer}`;answered(r,'run1',body);
 const x=await r.payload({...final,payload:{text:body}});assert.equal(x.payload.text,body);assert.equal(card(x)[0],footer);
});
test('card 2: quota unavailable says so and an empty self-list says 无',async()=>{
 const r=make({status:'unknown',reason:'cli_usage_unavailable'});started(r);const listed=`${answer}\n${MARK([])}`;answered(r,'run1',listed);
 const x=await r.payload(listedFinal(listed));boxed(x);
 assert.equal(x.payload.text,answer);
 assert.deepEqual(card(x).slice(1),['额度：暂时取不到','修改：无']);
});
test('card 3: no usage state says the model line is unknown and guesses nothing; without a trusted full text the change line says 未列 (shell use adds no wording)',async()=>{
 const r=make();started(r);r.afterTool({toolName:'Bash',params:{command:'opaque command'},result:{exitCode:0}},{runId:'run1',toolCallId:'shell'});
 const x=await r.payload({...final,usageState:undefined});boxed(x);
 assert.match(card(x)[0],/^模型和档位：未知/);assert.deepEqual(card(x).slice(1),[...quotaOk.split('\n'),'修改：未列']);
 assert.doesNotMatch(card(x)[0],/Sonnet|Opus|Haiku|medium|high/);
 const part=await make().payload({...final,runId:'r-part',usageState:{resolvedRef:'claude-cli/claude-sonnet-5-5'}});assert.equal(card(part)[0],'Sonnet/Cli · 档位未知');
 const part2=await make().payload({...final,runId:'r-part2',usageState:{reasoningEffort:'high'}});assert.equal(card(part2)[0],'型号未知 · high');
});
test('card 4: several self-listed files plus shell use, and a window whose reset already passed',async()=>{
 const r=make(cli({resetsAt:'2026-10-20T14:30:00Z'}));started(r);const listed=`${answer}\n${MARK(['a.md','b.md'])}`;answered(r,'run1',listed);wrote(r,'a.md','w1');wrote(r,'b.md','w2');
 r.afterTool({toolName:'Bash',params:{command:'x'},result:{exitCode:0}},{runId:'run1',toolCallId:'shell'});
 const x=await r.payload(listedFinal(listed));boxed(x);
 assert.deepEqual(card(x).slice(1),[`额度：5h 余 32% · 周限额（总量/fable）：已到重置点，待新读数/未知`,stamp,'修改：a.md、b.md']);
});
test('card 5: more than eight self-listed files show eight and the total',async()=>{
 const names=Array.from({length:11},(_,i)=>`${i+1}.md`);
 const r=make();started(r);const listed=`${answer}\n${MARK(names)}`;answered(r,'run1',listed);for(let i=1;i<=11;i++)wrote(r,`${i}.md`,`w${i}`);
 const x=await r.payload(listedFinal(listed));
 assert.equal(card(x)[3],'修改：1.md、2.md、3.md、4.md、5.md、6.md、7.md、8.md 等 11 个');
});
test('card 6: failed refresh keeps the old reading and a run without any record says 未列',async()=>{
 const r=make({...cli(),refreshFailed:true});
 const x=await r.payload(final);
 assert.deepEqual(card(x).slice(1),[`额度：5h 余 32% · 周限额（总量/fable）：余 61%/未知`,`（CodexBar 命令行采样 2026-10-20 23:50 Asia/Kolkata，距今 9 分钟，刷新失败，保留旧值）`,'修改：未列']);
});
test('card 7: a tool call that has not returned and a failed write are not leaks; a private leaked name is only counted',async()=>{
 const r=make();started(r);
 r.observe({runId:'run1',stream:'tool',data:{phase:'start',toolCallId:'pending',name:'Write',args:{file_path:join(WS,'late.md')}}});
 let x=await r.payload(final);assert.equal(card(x)[3],'修改：未列');   // 没有名单
 const q=make();started(q,'run2');const listed=`${answer}\n${MARK(['ok.md'])}`;answered(q,'run2',listed);
 q.afterTool({toolName:'Write',params:{file_path:join(WS,'failed.md')},result:{ok:false},error:'denied'},{runId:'run2',toolCallId:'f'});
 q.afterTool({toolName:'Write',params:{file_path:join(WS,'.env')},result:{ok:true}},{runId:'run2',toolCallId:'s'});
 x=await q.payload(listedFinal(listed,{runId:'run2'}));
// 成功写了却没列的私密名只计数，名字和完整路径都不出现。
 assert.equal(card(x)[3],'修改：ok.md（另有 1 个漏列，名称隐藏）');
 assert.doesNotMatch(card(x).join('\n')+x.payload.text,/\.env|failed|er-card-ws/);
});
test('once per run: a second final fragment of the same run is left alone',async()=>{
 const r=make();started(r);
 const first=await r.payload(final);assert.ok(first);
 assert.equal(await r.payload({...final,payload:{text:'second fragment'}}),undefined);
 assert.equal(await r.payload({...final,payload:{mediaUrls:['b']}}),undefined);
 const parallel=make();const [a,b]=await Promise.all([parallel.payload(final),parallel.payload({...final,payload:{text:'other'}})]);
 assert.equal([a,b].filter(Boolean).length,1);
});
test('an already boxed payload is not boxed again, and replays without a run id are left alone',async()=>{
 const r=make();started(r);
 const once=(await r.payload(final)).payload;
 assert.equal(await make().payload({...final,runId:'run-resend',payload:once}),undefined);
 assert.equal(await make().payload({...final,runId:undefined}),undefined);
 assert.equal(await make().payload({...final,runId:'run-fresh'}) !== undefined,true);
});
test('an attachment-only reply: the official footer-only status notice becomes an embed-only message, but only when the attachment reached this reply\'s account and conversation',async()=>{
 const sent=(params,result=okRet('channel:123'))=>({toolName:'message',params:{action:'send',media:'/task/a.txt',...params},result});
 const notice={...final,payload:{text:footer,isStatusNotice:true}};
 const r=make();started(r);r.afterTool(sent({target:'channel:123'}),{runId:'run1',toolCallId:'m1'});
 const x=await r.payload(notice,ctxD);assert.equal(x.payload.text,'');assert.equal(x.payload.isStatusNotice,undefined);assert.equal(card(x).length,4);assert.equal(card(x)[0],footer);
 for(const [params,result,ctx] of [[{target:'channel:999'},okRet('channel:999'),ctxD],[{channel:'slack'},okRet('channel:123'),ctxD],[{accountId:'desktop'},okRet('channel:123'),ctxD],[{target:'channel:123'},{ok:false},ctxD],[{target:'channel:123'},{},ctxD],[{target:'channel:123'},okRet('channel:123'),{...ctxD,conversationId:undefined}],[{target:'channel:123',threadId:'555'},okRet('channel:123'),ctxD]]){
  const q=make();started(q);q.afterTool(sent(params,result),{runId:'run1',toolCallId:'m1'});assert.equal(await q.payload(notice,ctx),undefined,JSON.stringify([params,result]));
 }
 const none=make();assert.deepEqual(await none.payload(notice,ctxD),{cancel:true,reason:'execution-record: footer-only status notice'});   // D9：这一轮没有附件、之前没发过片段的纯页脚状态通知不再单独发出（原为原样放行）
});
test('status notices, errors, other channels and rich output are never touched; other embeds survive',async()=>{
 const r=make();
 for(const event of [{...final,kind:'tool'},{...final,channel:'telegram'},{...final,payload:{text:'NO_REPLY',isStatusNotice:true}},{...final,payload:{text:'boom',isError:true}},{...final,payload:{...final.payload,presentation:{}}},{...final,payload:{...final.payload,interactive:{blocks:[]}}},{...final,payload:{...final.payload,audioAsVoice:true}},{...final,payload:{...final.payload,channelData:{execApproval:{id:1}}}},{...final,payload:{...final.payload,channelData:{discord:{components:[{type:1}]}}}}])
  assert.equal(await r.payload(event),undefined);
 const x=await r.payload({...final,payload:{text:'body',channelData:{discord:{embeds:[{title:'Original'}]}}}});
 assert.equal(x.payload.channelData.discord.embeds[0].title,'Original');assert.equal(x.payload.channelData.discord.embeds.length,2);assert.equal(card(x).length,4);
});
test('native scoped hook registration works without duplicate service start and shares successful file telemetry',async()=>{
 let emit;const make2=()=>{const hooks={},services=[];let subscribed=0;return {hooks,services,api:{pluginConfig:{executionRecord:{enabled:true,quotaSource:'cache',snapshotPath:'/nonexistent-test-snapshot',credentialProfilePath:profile}},config:{agents:{entries:{'worker-c':{workspace:WS}}}},on:(name,fn)=>{hooks[name]=fn;},registerService:s=>services.push(s),runtime:{events:{onAgentEvent:fn=>{emit=fn;subscribed++;return()=>{subscribed--;};}}}},subscriptions:()=>subscribed};};
 await preloadCodeRegions(async()=>({findCodeRegions}));   // 现场由注册时的提前加载完成；这里替它装好本机官方函数
 resetShared();const original=make2(),scoped=make2();registerExecutionRecord(original.api);registerExecutionRecord(scoped.api);
 await original.services[0].start();assert.equal(original.subscriptions(),1);assert.equal(scoped.subscriptions(),0);
 original.hooks.after_tool_call({toolName:'Write',params:{file_path:join(WS,'shared-success.md')},result:{ok:true}},{runId:'native-run',toolCallId:'shared-write',agentId:'worker-c'});
 const listed=`${answer}\n${MARK([])}`;emit({runId:'native-run',stream:'assistant',data:{itemId:'cli-assistant:native-run',text:listed}});
 const x=await scoped.hooks.reply_payload_sending(listedFinal(listed,{runId:'native-run'}),{agentId:'worker-c'});assert.match(x.payload.channelData.discord.embeds.at(-1).description,/修改：无（另有 1 个漏列：shared-success\.md）/);
 await original.services[0].stop();assert.equal(original.subscriptions(),0);
 assert(await scoped.hooks.reply_payload_sending({...final,runId:'native-run-2'},{}));
});

test('native service stop still joins its cache probe when event unsubscription fails',async()=>{
 const services=[];
 const api={pluginConfig:{executionRecord:{enabled:true,quotaSource:'cache',snapshotPath:'/nonexistent-retirement-fixture',credentialProfilePath:profile}},config:{agents:{entries:{}}},on(){},registerService:s=>services.push(s),runtime:{events:{onAgentEvent:()=>()=>{throw Error('original unsubscribe failure');}}}};
 registerExecutionRecord(api);await services[0].start();
 await assert.rejects(services[0].stop(),/original unsubscribe failure/);
 await services[0].stop();
});

test('页脚确认：事件订阅和页脚钩子在不同模块代／不同实例时，最终回复哈希仍然共享（实测 13:2x 的缺陷）',async()=>{
 const other=await import('../plugins/personal-inbox/execution-record.mjs?isolated-footer-state');
 assert.notEqual(other.createExecutionRecord,createExecutionRecord);
 const b=make();
 const a=other.createExecutionRecord({now:()=>time,readQuota:async()=>cli(),workspaceFor:()=>'/task'});
 answered(a,'run-shared');
 const x=await b.payload({...final,runId:'run-shared'},{});
 assert.equal(x.payload.text,answer);
 assert.equal(card(x)[0],'Sonnet/Cli · high');
});

test('只发附件：官方消息工具认的各种附件写法（path／filePath／fileUrl／mediaUrl／mediaUrls／attachments／buffer）都算附件；没有附件字段不算',async()=>{
 const notice={...final,payload:{text:footer,isStatusNotice:true}};
 const shapes=[{path:'/task/a.txt'},{filePath:'/task/a.txt'},{fileUrl:'file:///task/a.txt'},{mediaUrl:'/task/a.txt'},{mediaUrls:['/task/a.txt']},{attachments:[{filePath:'/task/a.txt'}]},{buffer:'QUJD'}];
 for(const extra of shapes){
  const r=make();started(r);r.afterTool({toolName:'message',params:{action:'send',target:'channel:123',...extra},result:okRet('channel:123')},{runId:'run1',toolCallId:'m1'});
  const x=await r.payload(notice,ctxD);assert(x,JSON.stringify(extra));assert.equal(x.payload.text,'');assert.equal(card(x).length,4);
 }
 for(const extra of [{},{path:''},{mediaUrls:[]},{attachments:[]}]){
  const r=make();started(r);r.afterTool({toolName:'message',params:{action:'send',target:'channel:123',message:'hi',...extra},result:okRet('channel:123')},{runId:'run1',toolCallId:'m1'});
  assert.deepEqual(await r.payload(notice,ctxD),{cancel:true,reason:'execution-record: footer-only status notice'},JSON.stringify(extra));   // D9：没有附件字段 → 不是 footerOnly 老路径；纯页脚通知不再单独发出（原为原样放行）
 }
});

test('只发附件（回复自己带附件、没有文字）：附件那条不加框，随后的页脚状态通知换成独立的框；没有页脚通知就没有框（已接受缺口）',async()=>{
 const media={...final,payload:{text:'',mediaUrls:['/task/a.txt'],mediaUrl:'/task/a.txt'}};
 const notice={...final,payload:{text:footer,isStatusNotice:true}};
 const r=make();   // 实测这种轮次没有工具记录、也没有生命周期事件
 assert.equal(await r.payload(media,ctxD),undefined);
 const x=await r.payload(notice,ctxD);assert(x);assert.equal(x.payload.text,'');assert.equal(x.payload.isStatusNotice,undefined);assert.equal(card(x).length,4);assert.equal(card(x)[0],footer);assert.equal(card(x)[3],'修改：未列');
 assert.equal(await r.payload(notice,ctxD),undefined);       // 同轮只一张
 const q=make();started(q);assert.deepEqual(await q.payload(notice,ctxD),{cancel:true,reason:'execution-record: footer-only status notice'});   // D9：没有附件的纯页脚通知不再单独发出（原为"不动"）
 const w=make();started(w);assert.equal(await w.payload(media,ctxD),undefined);   // 只有附件、没有页脚通知＝没有框
 const t=make();started(t);const withText=await t.payload({...final,payload:{text:`${answer}\n${footer}`,mediaUrls:['/task/a.txt']}},ctxD);assert(withText);assert.equal(card(withText).length,4);   // 文字＋附件照常加框
});

test('页脚确认：assistant 最终文字末尾有 MEDIA:路径 行、宿主已把它抽成附件时，页脚照样搬走（实测 S3-1c）；正文本身不同则保留原正文（只测了末尾 MEDIA 行；实现过滤所有符合规则的 MEDIA 行）',async()=>{
 const r=make();
 r.observe({runId:'run1',stream:'assistant',data:{itemId:'cli-assistant:run1',text:`${answer}\nMEDIA:/task/a.txt`}});
 const x=await r.payload({...final,payload:{text:`${answer}\n${footer}`,mediaUrls:['/x/a.txt'],mediaUrl:'/x/a.txt'}},ctxD);
 assert.equal(x.payload.text,answer);assert.equal(card(x)[0],footer);
 const q=make();
 q.observe({runId:'run1',stream:'assistant',data:{itemId:'cli-assistant:run1',text:`${answer}\nMEDIA:/task/a.txt`}});
 const y=await q.payload({...final,payload:{text:`其他文字\n${footer}`,mediaUrls:['/x/a.txt']}},ctxD);
 assert.equal(y.payload.text,`其他文字\n${footer}`);
});

test('工具发附件：按上机实测的官方 message 返回形状（details.deliveryStatus／details.result，无顶层 ok）识别成功；目的地和账号对得上才把页脚通知换成独立的框',async()=>{
 const real=(to,extra={})=>({content:[{type:'text',text:'{}'}],details:{channel:'discord',to,via:'direct',mediaUrl:'/w/a.txt',mediaUrls:['/w/a.txt'],result:{target:{kind:'channel',id:to.split(':')[1]},receipt:{primaryPlatformMessageId:'1',platformMessageIds:['1']},messageId:'1',channel:'discord'},deliveryStatus:'sent',payloadOutcomes:[{index:0,status:'sent',resultCount:1}],messageDelivery:{status:'settled',primaryPlatformMessageId:'1',partialDelivery:false,createdThreadIds:[],sourceReplyDelivered:true},...extra}});
 const notice={...final,payload:{text:footer,isStatusNotice:true}};
 const send=(params,result)=>{const r=make();r.afterTool({toolName:'message',params:{action:'send',media:'/w/a.txt',...params},result},{runId:'run1',toolCallId:'m1'});return r;};
 // M-1 实测：不写账号、不写目标；返回目的地＝当前频道（ctxD 的会话是 channel:123）
 let x=await send({},real('channel:123')).payload(notice,ctxD);assert(x,'默认账号＋返回 to 是本频道');assert.equal(x.payload.text,'');assert.equal(card(x).length,4);
 // M-3 实测：目标和账号都写
 x=await send({target:'channel:123',accountId:'default'},real('channel:123')).payload(notice,ctxD);assert(x,'显式目标和账号');
 // M-2 实测：发到别的线程——不是这条回复所在的会话，不能换成框
 assert.equal(await send({target:'channel:777'},real('channel:777')).payload(notice,ctxD),undefined);
 // 账号不一致
 assert.equal(await send({accountId:'desktop'},real('channel:123')).payload(notice,ctxD),undefined);
 // 失败／部分失败／被拦截的形状一律不算
 for(const extra of [{deliveryStatus:'failed'},{deliveryStatus:'suppressed'},{deliveryStatus:'partial_failed'},{messageDelivery:{status:'settled',partialDelivery:true}},{messageDelivery:{status:'failed'}},{payloadOutcomes:[{index:0,status:'suppressed'}]}]){
  assert.equal(await send({},real('channel:123',extra)).payload(notice,ctxD),undefined,JSON.stringify(extra));
 }
 const none={content:[],details:{channel:'discord',to:'channel:123'}};
 assert.equal(await send({},none).payload(notice,ctxD),undefined);
});

test('工具发附件：以权威返回的最终落点为准——请求写本频道而成功返回别处（或返回自相矛盾、没有落点、账号／平台相反）都不换成框；线程和父频道区分',async()=>{
 const notice={...final,payload:{text:footer,isStatusNotice:true}};
 const go=async(params,result,ctx=ctxD)=>{const r=make();r.afterTool({toolName:'message',params:{action:'send',media:'/w/a.txt',...params},result},{runId:'run1',toolCallId:'m1'});return r.payload(notice,ctx);};
 // 基线：请求和返回都是本频道 → 出框
 assert(await go({target:'channel:123'},okRet('channel:123')),'请求＝返回＝本频道');
 assert(await go({},okRet('channel:123')),'不写目标，返回本频道');
 // 请求本频道，成功返回别处（顶层 to 与 result.target、receipt 都写别处）→ 不出框
 assert.equal(await go({target:'channel:123'},okRet('channel:777')),undefined,'请求本频道、返回别处');
 // 请求别处，返回本频道 → 也是冲突，不出框
 assert.equal(await go({target:'channel:777'},okRet('channel:123')),undefined,'请求别处、返回本频道');
 // 不写目标，返回别处 → 不出框
 assert.equal(await go({},okRet('channel:777')),undefined,'默认路由落到别处');
 // 返回里几处落点互相矛盾（to 是本频道、receipt 里是别处）→ 确认不了，不出框
 const mixed=okRet('channel:123');mixed.details.result.receipt.parts[0].raw.channelId='777';
 assert.equal(await go({target:'channel:123'},mixed),undefined,'返回自相矛盾');
 const mixed2=okRet('channel:123');mixed2.details.result.target.id='777';
 assert.equal(await go({},mixed2),undefined,'返回 target 与 to 不一致');
 // 返回没有任何落点 → 确认不了，不出框（哪怕请求写了本频道）
 const noDest={content:[],details:{channel:'discord',deliveryStatus:'sent',result:{messageId:'1'}}};
 assert.equal(await go({target:'channel:123'},noDest),undefined,'返回没有落点');
 assert.equal(await go({},noDest),undefined,'都没有落点');
 // 线程与父频道：请求线程 555 且返回线程 555，而回复在父频道 123 → 不出框；回复就在线程 555 → 出框
 assert.equal(await go({target:'channel:123',threadId:'555'},okRet('channel:555')),undefined,'附件在线程，回复在父频道');
 assert(await go({target:'channel:123',threadId:'555'},okRet('channel:555'),{...ctxD,conversationId:'channel:555'}),'回复也在线程 555');
 // 请求线程、返回父频道（实际没进线程）→ 冲突
 assert.equal(await go({target:'channel:123',threadId:'555'},okRet('channel:123'),{...ctxD,conversationId:'channel:555'}),undefined,'请求线程、返回父频道');
 // 账号：请求和返回的账号相反 → 不出框；返回没写账号、请求写本账号 → 出框
 const acct=okRet('channel:123');acct.details.accountId='desktop';
 assert.equal(await go({accountId:'default'},acct),undefined,'账号请求与返回相反');
 assert.equal(await go({},acct),undefined,'返回账号是别的账号');
 const acctOk=okRet('channel:123');acctOk.details.accountId='default';
 assert(await go({accountId:'default'},acctOk),'账号一致');
 // 平台：请求写 slack、返回 discord → 相反，不出框
 assert.equal(await go({channel:'slack'},okRet('channel:123')),undefined,'平台相反');
});
