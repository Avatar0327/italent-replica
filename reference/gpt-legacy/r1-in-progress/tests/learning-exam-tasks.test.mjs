import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,get,act,expect,request,due} from './support/foundation-scenario.mjs';
const definitions=await import('../app/api/learning-exams/route.ts'),api=await import('../app/api/learning-exam-tasks/route.ts'),self=await import('../app/api/self-service/route.ts');
const {businessDate}=await import('../lib/hris/business-time.ts'),{developmentContext}=await import('../lib/hris/development-repository.ts'),{applyLearningExamTask}=await import('../lib/hris/learning-exam-tasks.ts');
async function cmd(route,command,status=200,revision){const d=await expect(await route.GET());return expect(await route.POST(request('/api/learning-exam-tasks',{revision:revision??d.revision,command})),status);}
test('independent exams bind attempts to employee and version, hide answers, honor revocation windows and roll back the entire submission',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const def=await cmd(definitions,{action:'create',title:'独立考试合成场景',orgId:f.org.id,passingScore:80,maxAttempts:2,questions:[{prompt:'合成场景的合理处理是什么',options:['独立核验','本人自批'],correct:0}]});await cmd(definitions,{action:'seal',id:def.id});
 const command={action:'assign',examId:def.id,employeeId:f.e.id,start:businessDate(),due};act('hr');await cmd(api,{...command,employeeId:f.other.id},403);const created=await cmd(api,command),taskId=created.ids[0];await cmd(api,command,400);
 act('employee');let data=await expect(await api.GET());assert.equal(data.papers.length,1);assert.ok(!('correct' in data.papers[0].payload.questions[0]));assert.ok(!data.records.some(r=>r.kind==='learningExamDefinition'));assert.ok((await expect(await self.GET())).tasks.some(r=>r.id===taskId));
 await cmd(api,{action:'submit',id:taskId,answers:[5]},400);
 const snapshot=()=>['hris_workspaces','hris_development_records','hris_development_events','hris_audit_events'].map(table=>f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()),before=snapshot();
 f.sqlite.exec("CREATE TRIGGER block_exam_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit blocked'); END");await cmd(api,{action:'submit',id:taskId,answers:[1]},503);assert.deepEqual(snapshot(),before);f.sqlite.exec('DROP TRIGGER block_exam_audit');
 await cmd(api,{action:'submit',id:taskId,answers:[1]});data=await expect(await api.GET());assert.equal(data.records.find(r=>r.id===taskId).status,'active');assert.equal(data.records.filter(r=>r.kind==='learningExamAttempt').length,1);
 const ctx=await developmentContext(),submission={action:'submit',id:taskId,answers:[0]};
 for(const employee of [{...f.e,status:'离职'},{...f.e,orgId:f.otherOrg.id}])assert.throws(()=>applyLearningExamTask(ctx.records,{...ctx.state,employees:ctx.state.employees.map(e=>e.id===f.e.id?employee:e)},ctx.member,submission),/状态已变化/);
 assert.throws(()=>applyLearningExamTask(ctx.records,ctx.state,ctx.member,submission,'2100-01-01T00:00:00Z'),/已过期/);
 act('manager');assert.equal((await expect(await api.GET())).records.length,0);await cmd(api,submission,403);
 act('owner');await cmd(api,submission,403);
 act('employee');const stale=data.revision;await cmd(api,submission);await cmd(api,submission,400);data=await expect(await api.GET());assert.equal(data.records.find(r=>r.id===taskId).status,'completed');assert.equal(data.records.filter(r=>r.kind==='learningExamAttempt').length,2);assert.ok(!(await expect(await self.GET())).tasks.some(r=>r.id===taskId));assert.ok(!(await get()).records.some(r=>r.kind==='enrollment'||r.kind==='learningCredit'));
 act('owner');const next=await cmd(definitions,{action:'revise',id:def.id});await cmd(definitions,{action:'seal',id:next.id});const separate=await cmd(api,{...command,examId:next.id});
 act('employee');await cmd(api,{...submission,id:separate.ids[0]},409,stale);assert.equal((await expect(await api.GET())).records.filter(r=>r.kind==='learningExamAttempt'&&r.referenceId===separate.ids[0]).length,0);
 act('owner');await cmd(api,{action:'cancel',id:separate.ids[0],evidence:'合成测试取消第二版本考试'});act('employee');await cmd(api,{...submission,id:separate.ids[0]},400);
});
