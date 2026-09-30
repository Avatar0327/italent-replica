import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,core,grant,hris,expect,act,request} from './support/foundation-scenario.mjs';
const {memberContext}=await import('../lib/hris/context.ts');
const route=await import('../app/api/r1/commands/route.ts');
const {businessDate}=await import('../lib/hris/business-time.ts');
import {transferFixture as fixture} from './support/r1-transfer-fixture.mjs';
test('P3-M01-04 new D7 endpoint: second reviewer scope is target only; approval waits, atomic effect changes primary and compatibility once',async t=>{
 const f=await fixture(t),id=await f.submit();act('r1-b');await f.post({action:'decide',id,decision:'approved'},403);
 const publicView=await expect(await hris.GET());assert.ok(!publicView.state.employees.some(e=>e.id===f.e.id));assert.ok(publicView.state.approvals.some(a=>a.id===id));
 await f.approve(id);act('r1-hr');let state=await f.state();assert.equal(state.employees.find(e=>e.id===f.e.id).orgId,f.org.id);assert.equal(state.approvals.find(a=>a.id===id).details.transfer.execution,'waiting');
 const intent=await f.intent({action:'executeTransfer',id});const a=await expect(await route.POST(request('/api/r1/commands',intent)));assert.equal(a.result.effectStatus,'applied');
 const b=await expect(await route.POST(request('/api/r1/commands',intent)));assert.equal(b.replayed,true);assert.equal(a.result.assignmentId,b.result.assignmentId);
 state=await f.state();assert.equal(state.employees.find(e=>e.id===f.e.id).orgId,f.otherOrg.id);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_m01_entities WHERE kind='assignment' AND status='active'").get().n,1);
 assert.equal(f.sqlite.prepare("SELECT status FROM r1_m01_entities WHERE id='primary'").get().status,'ended');
 assert.deepEqual(f.sqlite.prepare('SELECT delta FROM r1_occupancy_events ORDER BY delta').all().map(x=>x.delta),[-1,1]);
});
test('P3-M01-05 new D7 endpoint: early execution has no attempt; audit exception rolls back both models and same key can safely retry',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-10T15:59:59Z')});const f=await fixture(t),id=await f.submit({effectiveOn:'2026-09-11'});await f.approve(id);act('r1-hr');
 let snapshot=f.snapshot();await f.post({action:'executeTransfer',id},400);assert.deepEqual(f.snapshot(),snapshot);
 t.mock.timers.setTime(Date.parse('2026-09-10T16:00:00Z'));const intent=await f.intent({action:'executeTransfer',id});
 f.sqlite.exec("CREATE TRIGGER r1_test_audit_fail BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");snapshot=f.snapshot();await expect(await route.POST(request('/api/r1/commands',intent)),503);assert.deepEqual(f.snapshot(),snapshot);f.sqlite.exec('DROP TRIGGER r1_test_audit_fail');
 await expect(await route.POST(request('/api/r1/commands',intent)));assert.equal((await f.state()).approvals.find(a=>a.id===id).details.transfer.attempts,1);
});
test('P3-M01-06 new D7 endpoint: unrelated terminal history permits independent intent; correction restarts both reviewers; parallel requests share CAS',async t=>{
 const f=await fixture(t),first=await f.submit();act('r1-hr');await f.post({action:'withdraw',id:first});
 const independent=await f.submit();assert.equal((await f.state()).approvals.find(a=>a.id===independent).details.previousApprovalId,undefined);await f.post({action:'withdraw',id:independent});
 const corrected=await f.submit({intent:'correction',previousApprovalId:first});assert.equal((await f.state()).approvals.find(a=>a.id===corrected).currentStep,0);await f.post({action:'withdraw',id:corrected});
 const one=await f.intent(f.request),two=await f.intent(f.request);const results=await Promise.all([route.POST(request('/api/r1/commands',one)),route.POST(request('/api/r1/commands',two))]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
});
test('same-day transfers retain exact event time and one day-end primary instead of invalid negative date intervals',async t=>{
 const f=await fixture(t),first=await f.submit();await f.approve(first);act('r1-hr');const firstEffect=await f.post({action:'executeTransfer',id:first});
 act('owner');await f.post({action:'workflow',kind:'transfer',steps:[{userId:'r1-b',name:'调出B'},{userId:'approver',name:'调入A'}]});
 const second=await f.submit({orgId:f.org.id,positionId:f.position.id});act('r1-b');await f.post({action:'decide',id:second,decision:'approved'});act('approver');await f.post({action:'decide',id:second,decision:'approved'});act('r1-hr');await f.post({action:'executeTransfer',id:second});
 const ended=JSON.parse(f.sqlite.prepare('SELECT payload FROM r1_m01_entities WHERE id=?').get(firstEffect.result.assignmentId).payload);assert.equal(ended.validFrom,ended.validTo);assert.equal(ended.dayProjectionExcluded,true);assert.ok(ended.effectiveToAt>=ended.effectiveFromAt);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM r1_m01_entities WHERE kind='assignment' AND status='active'").get().n,1);
 assert.equal(f.sqlite.prepare('SELECT sum(delta) n FROM r1_occupancy_events WHERE position_id=?').get(f.target.id).n,0);
});
test('D7 business failure commits only attempt and reason; primary history and occupancy remain unchanged',async t=>{
 const f=await fixture(t),id=await f.submit();await f.approve(id);act('r1-hr');f.seed('budget','budget_policy',f.otherOrg.id,null,{strongBlocking:true});
 const before=f.sqlite.prepare('SELECT * FROM r1_m01_versions').all();const r=await f.post({action:'executeTransfer',id});assert.equal(r.result.effectStatus,'failed');
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM r1_m01_versions').all(),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM r1_occupancy_events').get().n,0);
 const a=(await f.state()).approvals.find(a=>a.id===id);assert.equal(a.status,'approved');assert.equal(a.details.transfer.attempts,1);assert.match(a.details.transfer.failure,/金额预算/);
});
test('D7 field revocation rejects blind review; target-only summary does not grant source history or attachments',async t=>{
 const f=await fixture(t,true),id=await f.submit();act('approver');await f.post({action:'decide',id,decision:'approved'});await f.setViewLevel('r1-b',0);act('r1-b');
 const summary=await expect(await hris.GET());const a=summary.state.approvals.find(a=>a.id===id);assert.equal(a.details.transfer.source.level,'');assert.equal(a.details.transfer.target.gradeId,null);await f.post({action:'decide',id,decision:'approved'},403);
 const history=await import('../app/api/history/route.ts'),attachments=await import('../app/api/attachments/route.ts');assert.equal((await history.GET(request('/api/history?employeeId='+f.e.id))).status,403);assert.equal((await attachments.GET(request('/api/attachments?employeeId='+f.e.id))).status,403);
 await f.setViewLevel('r1-b',1);act('r1-b');await f.post({action:'decide',id,decision:'approved'});act('r1-hr');assert.equal((await f.post({action:'executeTransfer',id})).result.effectStatus,'applied');
});
test('D7 approval expires at the planned Beijing date boundary; source and intent remain unchanged',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-10T01:00:00Z')});const f=await fixture(t),id=await f.submit();act('approver');await f.post({action:'decide',id,decision:'approved'});
 t.mock.timers.setTime(Date.parse('2026-09-10T16:00:00Z'));act('r1-b');const before=f.snapshot();await f.post({action:'decide',id,decision:'approved'},400);assert.deepEqual(f.snapshot(),before);
});
test('D7 unknown after a real SQLite commit resolves by command receipt and never duplicates history or occupancy',async t=>{
 const f=await fixture(t),id=await f.submit();await f.approve(id);act('r1-hr');const intent=await f.intent({action:'executeTransfer',id});let lost=false;
 globalThis.p2env.DB={prepare:q=>f.db.prepare(q),batch:async statements=>{const r=await f.db.batch(statements);if(!lost&&statements.some(s=>s.sql.includes('INSERT INTO r1_occupancy_events'))){lost=true;throw Error('synthetic response lost after actual SQLite commit');}return r;}};
 await expect(await route.POST(request('/api/r1/commands',intent)),503);globalThis.p2env.DB=f.db;
 const receipt=await import('../app/api/r1/commands/[commandId]/route.ts');const response=await receipt.GET(request('/api/r1/commands/'+intent.commandId),{params:Promise.resolve({commandId:intent.commandId})});const body=await expect(response);assert.equal(body.status,'committed');
 const before=f.snapshot();await expect(await route.POST(request('/api/r1/commands',intent)));assert.deepEqual(f.snapshot(),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM r1_occupancy_events').get().n,2);
});
