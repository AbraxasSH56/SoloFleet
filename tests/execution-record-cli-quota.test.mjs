// Offline tests for execution record cli quota: temporary directories and fake data only; nothing touches a real deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import { crew } from '../plugins/personal-inbox/crew-config.mjs';
import {createCliQuotaSource,selectClaudeCliQuota,registerExecutionRecord,publishCliQuota} from '../plugins/personal-inbox/execution-record.mjs';
const rows=()=>[{provider:'claude',source:'claude',usage:{updatedAt:'2026-10-20T20:27:37Z',primary:{usedPercent:43,windowMinutes:300,resetsAt:'2026-10-20T22:10:00Z'},secondary:{usedPercent:96,windowMinutes:10080,resetsAt:'2026-10-24T16:00:00Z'}}}];
function fixture(options={}){
 let time=Date.parse('2026-10-20T20:28:00Z'),calls=[],children=[],kills=[];
 const source=createCliQuotaSource({credentialProfilePath:'/isolated/claude/.credentials.json',now:()=>time,spawnProcess:(...args)=>{calls.push(args);const c=new EventEmitter();c.stdout=new EventEmitter();children.push(c);return c;},killProcess:c=>{kills.push(c);queueMicrotask(()=>c.emit('close',null));},...options});
 const reply=(x=rows(),code=0)=>{children.at(-1).stdout.emit('data',Buffer.from(JSON.stringify(x)));children.at(-1).emit('close',code);};
 return{source,calls,children,kills,reply,advance:ms=>{time+=ms;}};
}
test('CLI projection keeps measured/reset semantics, missing fields unknown, no account identity invented',()=>{
 const x=selectClaudeCliQuota(rows(),{now:Date.parse('2026-10-20T23:00:00Z')});assert.equal(x.session.remainingPercent,57);assert.equal(x.week.remainingPercent,4);assert(x.session.resetPassed);assert(!x.profileMatched);
 const bad=rows();bad[0].usage.primary.usedPercent=101;assert.equal(selectClaudeCliQuota(bad).session,null);
 assert.equal(selectClaudeCliQuota([{provider:'codex',usage:rows()[0].usage}]).status,'unknown');assert.equal(selectClaudeCliQuota([...rows(),...rows()]).status,'unknown');
 const missing=rows();delete missing[0].usage.secondary;assert.equal(selectClaudeCliQuota(missing).week,null);
});
test('one official no-credit CLI query preserves native environment; reads and concurrent callers never start more processes',async()=>{
 const f=fixture();assert.equal(f.source.read().status,'unknown');const p=f.source.refresh();assert.equal(f.source.refresh(),p);assert.equal(f.source.read().reason,'cli_usage_pending');
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0][1],['usage','--provider','claude','--source','cli','--format','json','--no-credits']);assert.deepEqual(f.calls[0][2].env,{...process.env});assert.equal(f.calls[0][2].detached,true);
 f.reply();await p;for(let i=0;i<100;i++)f.source.read();await f.source.refresh();assert.equal(f.calls.length,1);assert.equal(f.source.read().week.remainingPercent,4);
 f.advance(300001);const next=f.source.refresh();assert.equal(f.calls.length,2);f.reply();await next;
});
test('timeout, provider failure and cancellation settle without blocking replies; old snapshot keeps its original timestamp',async()=>{
 const f=fixture({timeoutMs:5});let p=f.source.refresh();f.reply();await p;f.advance(300001);p=f.source.refresh();await p;assert.equal(f.kills.length,1);assert(f.source.read().refreshFailed);assert.equal(f.source.read().measuredAt,rows()[0].usage.updatedAt);
 f.advance(300001);const controller=new AbortController();p=f.source.refresh({signal:controller.signal});controller.abort();await p;assert.equal(f.kills.length,2);
 const empty=fixture();p=empty.source.refresh();empty.reply([],1);await p;assert.equal(empty.source.read().status,'unknown');
});
test('retired source cannot start a new query, failed sample is throttled, malformed or oversized output is unavailable',async()=>{
 const f=fixture(),a=new AbortController();a.abort();await f.source.refresh({signal:a.signal});assert.equal(f.calls.length,0);
 let p=f.source.refresh();f.children[0].stdout.emit('data',Buffer.from('{broken'));f.children[0].emit('close',0);await p;await f.source.refresh();assert.equal(f.calls.length,1);assert.equal(f.source.read().status,'unknown');
 f.advance(300001);p=f.source.refresh();f.children.at(-1).stdout.emit('data',Buffer.alloc(65537));await p;assert.equal(f.kills.length,1);assert.equal(f.source.read().status,'unknown');
});
test('original service starts a nonblocking quota sample, reply only reads snapshot, retirement joins the one owned query',async()=>{
 const f=fixture(),hooks={},services=[];let observe;
 registerExecutionRecord({pluginConfig:{executionRecord:{enabled:true,credentialProfilePath:'/isolated/service/.credentials.json',snapshotPath:'/never-read'}},config:{agents:{entries:{}}},on:(name,fn)=>{hooks[name]=fn;},registerService:s=>services.push(s),runtime:{events:{onAgentEvent:fn=>{observe=fn;return()=>{};}}}},{makeCliQuotaSource:()=>f.source});
 await services[0].start();assert.equal(f.calls.length,1);
 const payload={channel:'discord',kind:'final',runId:'service',payload:{text:'done'},usageState:{resolvedRef:'claude-cli/claude-sonnet-5-5',reasoningEffort:'medium'}};
 const result=await hooks.reply_payload_sending(payload,{});assert(result);assert.equal(f.calls.length,1);
 observe({runId:'service',stream:'lifecycle',data:{phase:'start'}});assert.equal(f.calls.length,1);
 await services[0].stop();assert.equal(f.kills.length,1);
 observe({runId:'service',stream:'lifecycle',data:{phase:'end'}});assert.equal(f.calls.length,1);
});
test('different role workspace projections and config ordering share one service-owned quota sample',async()=>{
 const f=fixture();let factories=0;
 const make=partial=>{const hooks={},services=[];const executionRecord=partial?{credentialProfilePath:'/isolated/role-projection/.credentials.json',snapshotPath:'/unused',enabled:true,quotaSource:'cli'}:{enabled:true,snapshotPath:'/unused',credentialProfilePath:'/isolated/role-projection/.credentials.json'};return{hooks,services,api:{pluginConfig:{executionRecord},config:{agents:{entries:partial?{'worker-c':{workspace:'/worker'}}:{main:{workspace:'/main'},'worker-c':{workspace:'/worker'}}}},on:(k,v)=>{hooks[k]=v;},registerService:s=>services.push(s),runtime:{events:{onAgentEvent:()=>()=>{}}}}};};
 const global=make(false),scoped=make(true),options={makeCliQuotaSource:()=>{factories++;return f.source;}};
 registerExecutionRecord(global.api,options);registerExecutionRecord(scoped.api,options);assert.equal(factories,1);
 await global.services[0].start();f.reply();await new Promise(resolve=>setImmediate(resolve));
 const result=await scoped.hooks.reply_payload_sending({channel:'discord',kind:'final',runId:'role-projection',payload:{text:'same task'},usageState:{resolvedRef:'claude-cli/claude-sonnet-5-5'}},{});
 assert.match(JSON.stringify(result),/余 57%/);assert.match(JSON.stringify(result),/CodexBar 命令行采样/);assert.equal(f.calls.length,1);
 await scoped.services[0].stop();assert.equal(f.kills.length,0);await global.services[0].stop();
});

test('separate scoped module generation reads the native host quota publication without sampling',async(t)=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-10-20T20:30:00Z')); // the fixture's quota windows are dated; pin the clock
 const scoped=await import('../plugins/personal-inbox/execution-record.mjs?isolated-quota-reader');
 const values=new Map(),stats={writes:0},f=fixture();
 const open=(_options,authority)=>({
  lookup:async key=>values.get(key),
  observe:async key=>({value:values.get(key),comparison:String(stats.writes)}),
  compareAndApply:async(key,comparison,intent)=>{
   authority?.assertCurrent();assert.equal(intent.operation,'update');assert.equal(intent.action,'set');
   if(comparison!==String(stats.writes))return{status:'conflict'};
   values.set(key,intent.value);stats.writes++;return{status:'applied'};
  },
 });
 const make=()=>{const hooks={},services=[];return{hooks,services,api:{
  pluginConfig:{executionRecord:{enabled:true,credentialProfilePath:'/isolated/separate-generation/.credentials.json'}},config:{agents:{entries:{}}},
  on:(name,fn)=>{hooks[name]=fn;},registerService:s=>services.push(s),runtime:{state:{openKeyedStoreV2:open},events:{onAgentEvent:()=>()=>{}}},
 }};};
 const host=make(),reader=make();let readerSamples=0;
 registerExecutionRecord(host.api,{makeCliQuotaSource:()=>f.source});
 scoped.registerExecutionRecord(reader.api,{makeCliQuotaSource:()=>({read:()=>({status:'unknown',reason:'cli_usage_not_sampled'}),refresh:()=>{readerSamples++;throw Error('Reader cannot sample');}})});
 await host.services[0].start();f.reply();await new Promise(resolve=>setImmediate(resolve));
 const result=await reader.hooks.reply_payload_sending({channel:'discord',kind:'final',runId:'separate-module',payload:{text:'original task'},usageState:{resolvedRef:'claude-cli/claude-sonnet-5-5'}},{});
 assert.match(JSON.stringify(result),/余 57%/);assert.equal(stats.writes,1);assert.equal(readerSamples,0);
 assert(!JSON.stringify([...values.values()]).includes('credential'));await host.services[0].stop();
});

test('native quota publication rejects retired work, preserves newer sample and retries only explicit conflict',async()=>{
 const value=selectClaudeCliQuota(rows()),oldRows=rows();let writes=0,live=true;
 const store={observe:async()=>({comparison:'original',value:undefined}),compareAndApply:async()=>{writes++;return{status:'conflict'};}};
 assert.equal(await publishCliQuota(store,'source',value),false);assert.equal(writes,2);
 writes=0;store.observe=async()=>{live=false;return{comparison:'original'};};
 await assert.rejects(publishCliQuota(store,'source',value,()=>{if(!live)throw Error('Retired');}),/Retired/);assert.equal(writes,0);
 oldRows[0].usage.updatedAt='2026-10-20T20:30:00Z';store.observe=async()=>({value:{version:1,sourceKey:'source',rows:oldRows},comparison:'new'});
 assert.equal(await publishCliQuota(store,'source',value),true);assert.equal(writes,0);
 assert.equal(await publishCliQuota(store,'source',{status:'unknown'}),undefined);
});

test('unavailable or stalled native quota state is unknown and does not initiate a provider query',async()=>{
 const f=fixture(),hooks={};let lookups=0;
 registerExecutionRecord({pluginConfig:{executionRecord:{enabled:true,credentialProfilePath:'/isolated/stalled-state/.credentials.json'}},config:{agents:{entries:{}}},on:(name,fn)=>{hooks[name]=fn;},registerService(){},runtime:{state:{openKeyedStoreV2:()=>({lookup:()=>{lookups++;return new Promise(()=>{});}})}}},{makeCliQuotaSource:()=>f.source});
 const event={channel:'discord',kind:'final',runId:'stalled-state',payload:{text:'reply'}};
 const results=await Promise.all([hooks.reply_payload_sending(event,{}),hooks.reply_payload_sending({...event,runId:'stalled-state-2'},{})]);
 assert.equal(lookups,1);assert.equal(f.calls.length,0);assert(results.every(r=>JSON.stringify(r).includes('未知')));
});

test('shared quota cache: the weekly-cap window id follows attachCard.scopedWeeklyFamily and reads back', async () => {
  const value = { status: 'cached', measuredAt: '2026-10-20T20:27:37Z', session: { usedPercent: 43, windowMinutes: 300, resetsAt: '2026-10-20T22:10:00Z' }, week: { usedPercent: 96, windowMinutes: 10080, resetsAt: '2026-10-24T16:00:00Z' }, fable: { usedPercent: 10, windowMinutes: 10080, resetsAt: '2026-10-24T16:00:00Z' } };
  const before = crew.attachCard.scopedWeeklyFamily;
  try {
    for (const family of ['fable', 'sage']) {
      crew.attachCard.scopedWeeklyFamily = family;
      const mod = await import(`../plugins/personal-inbox/execution-record.mjs?scoped-${family}`); // a fresh module instance reads the config at load
      const rows = mod.quotaRows(value);
      assert.equal(rows[0].usage.extraRateWindows[0].id, `claude-weekly-scoped-${family}`);
      const back = mod.selectClaudeCliQuota(rows, { now: Date.parse('2026-10-20T20:30:00Z') });
      assert.equal(back.fable.remainingPercent, 90, `the ${family} window is found again after the round trip`);
    }
  } finally { crew.attachCard.scopedWeeklyFamily = before; }
});
