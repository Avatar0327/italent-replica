import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,get,expect,request,grant,dev} from './support/foundation-scenario.mjs';
const api=await import('../app/api/recruitment/route.ts');
async function call(command,key,status=200,revision){const req=request('/api/recruitment',{revision:revision??(await get()).revision,command});if(key)req.headers.set('Idempotency-Key',key);return expect(await api.POST(req),status);}
const input=f=>({action:'requisition',positionId:f.position.id,title:'合成网络响应恢复',headcount:1,reason:'网络响应丢失后使用原请求键恢复结果',submit:true});
test('lost creation responses replay the original ID across stale/current revisions without another write or metadata disclosure',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const c=input(f),rev=(await get()).revision,key='synthetic-lost-response-001',first=await call(c,key),count=f.sqlite.prepare('SELECT count(*) AS n FROM hris_audit_events').get().n;
 const again=await call(c,key,200,rev);assert.equal(again.id,first.id);assert.equal(again.replayed,true);assert.equal(again.originalRevision,first.revision);assert.equal((await get()).revision,first.revision);assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM hris_audit_events').get().n,count);assert.equal((await expect(await api.GET())).records.length,1);
 assert.equal((await expect(await api.GET())).records[0].payload.creationRequest,undefined);const history=await expect(await dev.GET(request('/api/development?id='+first.id)));assert.ok(history.items.every(i=>i.snapshot.payload.creationRequest===undefined));await call({...c,headcount:2},key,409);assert.equal((await get()).revision,first.revision);
 act('manager');await call({action:'approveRequisition',id:first.id});act('owner');const current=(await get()).revision,recovered=await call(c,key,200,current);assert.equal(recovered.id,first.id);assert.equal(recovered.revision,current);assert.equal((await expect(await api.GET())).records[0].status,'active');
});
test('candidate and interview creation keys are per actor, retain failure atomicity and do not bypass current scope or role',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());act('hr');const reqInput=input(f),q=await call(reqInput,'synthetic-demand-hr');act('manager');await call({action:'approveRequisition',id:q.id});act('hr');const candidate={action:'candidate',requisitionId:q.id,name:'合成恢复候选人',email:'',source:'合成手动创建，用于网络重试验证'},key='synthetic-candidate-key',before=(await get()).revision;
 f.sqlite.exec("CREATE TRIGGER reject_key_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END");await call(candidate,key,503);assert.equal((await get()).revision,before);f.sqlite.exec('DROP TRIGGER reject_key_audit');const c=await call(candidate,key),replay=await call(candidate,key,200,before);assert.equal(replay.id,c.id);
 act('manager');const interview={action:'interview',candidateId:c.id,rating:4,recommendation:'advance',evidence:'合成面试意见只记录一次'},i=await call(interview,'synthetic-interview-key');assert.equal((await call(interview,'synthetic-interview-key')).id,i.id);act('owner');const other=await call(interview,'synthetic-interview-key');assert.notEqual(other.id,i.id);
 await grant('hr','hr',null,[f.otherOrg.id],true);act('hr');await call(candidate,key,403);await grant('hr','manager',null,[f.org.id],true);act('hr');await call(candidate,key,403);
});
test('unsupported keys and commands are rejected instead of suggesting replay support for state transitions',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());await call(input(f),'short',400);const q=await call(input(f));act('manager');await call({action:'approveRequisition',id:q.id},'synthetic-transition-key',400);assert.equal((await expect(await api.GET())).records[0].status,'submitted');
});
