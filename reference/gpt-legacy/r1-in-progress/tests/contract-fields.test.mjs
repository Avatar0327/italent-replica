import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,expect,get,request,dev} from './support/foundation-scenario.mjs';
const fields=await import('../app/api/contract-fields/route.ts'),workforce=await import('../app/api/workforce/route.ts');
const field=async(command,status=200)=>expect(await fields.POST(request('/api/contract-fields',{revision:(await get()).revision,command})),status);
const work=async(command,status=200,revision)=>expect(await workforce.POST(request('/api/workforce',{revision:revision??(await get()).revision,command})),status);
const find=async id=>(await get()).records.find(r=>r.id===id);
const base=f=>({action:'contract',employeeId:f.e.id,number:'SYN-OLD',employerName:'合成用工主体',contractType:'fixed',start:'2026-01-01',end:'2026-01-31',evidence:'仅合成合同字段继承验证资料'});
async function definition(f,code,inheritPrevious=true){const d=await field({action:'create',orgId:f.org.id,code,name:'合成字段'+code,inheritPrevious});await field({action:'seal',id:d.id});return d;}
async function sign(id){return work({action:'signContract',id,signedOn:'2026-01-01',evidence:'仅登记合成签署证据，不签署真实合同'});}
test('renewals distinguish inherited, non-inherited and explicitly cleared values without changing the original',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());act('hr');const carry=await definition(f,'CARRY'),empty=await definition(f,'EMPTY',false),manual=await definition(f,'MANUAL');
 const old=await work({...base(f),customFields:{[carry.id]:'原合成值',[empty.id]:'不得自动带入',[manual.id]:'将被明确清空'}});await sign(old.id);const oldState=await find(old.id);
 const draft=await field({action:'revise',id:carry.id});await field({action:'archive',id:draft.id,reason:'丢弃修订草稿，不停用原定版'});
 const renewed=await work({...base(f),number:'SYN-NEW',start:'2026-02-01',end:'2026-02-28',renewalOf:old.id,customFields:{[manual.id]:null}});
 const result=(await find(renewed.id)).payload.contractFields;
 assert.equal(result.find(x=>x.id===carry.id).value,'原合成值');assert.equal(result.find(x=>x.id===carry.id).sourceContractId,old.id);assert.equal(result.find(x=>x.id===empty.id).value,null);assert.equal(result.find(x=>x.id===empty.id).source,'empty');assert.equal(result.find(x=>x.id===manual.id).source,'manual');assert.equal(result.find(x=>x.id===manual.id).value,null);assert.deepEqual(await find(old.id),oldState);
 await work({...base(f),number:'DUP-RENEWAL',start:'2026-02-01',end:'2026-02-28',renewalOf:old.id},400);
 act('employee');const own=await expect(await workforce.GET());assert.equal(own.records.find(r=>r.id===old.id).payload.contractFields,undefined);assert.ok(!own.records.some(r=>r.kind==='contractFieldDefinition'));await expect(await dev.GET(request('/api/development?id='+old.id)),403);await expect(await fields.GET(),403);
});
test('new field versions govern only new contract snapshots and archiving latest sealed version never revives older settings',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());act('hr');const d=await definition(f,'VERSION');const original=await work({...base(f),customFields:{[d.id]:'旧值'}});await sign(original.id);
 const revised=await field({action:'revise',id:d.id});await field({action:'edit',id:revised.id,orgId:f.org.id,code:'VERSION',name:'合成新版字段',inheritPrevious:false});await field({action:'seal',id:revised.id});
 await work({...base(f),number:'STALE-FIELD',start:'2026-02-01',end:'2026-02-28',renewalOf:original.id,customFields:{[d.id]:'旧ID不能伪造当前版本'}},400);
 const renewal=await work({...base(f),number:'V2-CONTRACT',start:'2026-02-01',end:'2026-02-28',renewalOf:original.id});const captured=(await find(renewal.id)).payload.contractFields[0];assert.equal(captured.version,2);assert.equal(captured.value,null);assert.equal(captured.inheritPrevious,false);
 assert.equal((await find(original.id)).payload.contractFields[0].value,'旧值');await field({action:'archive',id:revised.id,reason:'停用新版字段，不回退旧版本'});
 const without=await work({...base(f),number:'NO-FIELD',start:'2026-03-01',end:'2026-03-31'});assert.equal((await find(without.id)).payload.contractFields,undefined);assert.equal((await find(renewal.id)).payload.contractFields[0].version,2);
});
test('contract fields reject unauthorized IDs, extra values, stale revisions and audit failures atomically',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());act('owner');const outside=await field({action:'create',orgId:f.otherOrg.id,code:'OUTSIDE',name:'范围外字段'});await field({action:'seal',id:outside.id});act('hr');const d=await definition(f,'LOCAL');
 await field({action:'create',orgId:f.otherOrg.id,code:'DENIED',name:'越界'},403);act('manager');await expect(await fields.GET(),403);act('hr');
 for(const customFields of [{[outside.id]:'不可越界'},{[d.id]:'文'.repeat(1001)},{'not-an-id':'无效'}])await work({...base(f),customFields},400);
 const before=(await get()).revision;await work({...base(f),customFields:{[d.id]:'手工覆盖'}},409,before-1);
 f.sqlite.exec("CREATE TRIGGER reject_contract_fields BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");await work({...base(f),customFields:{[d.id]:'手工覆盖'}},503);f.sqlite.exec('DROP TRIGGER reject_contract_fields');assert.equal((await get()).revision,before);assert.ok(!(await get()).records.some(r=>r.kind==='employmentContract'));
 const valid=await work({...base(f),customFields:{[d.id]:'手工覆盖'}});assert.equal((await find(valid.id)).payload.contractFields[0].source,'manual');
});
