import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,act,expect,request,due} from './support/foundation-scenario.mjs';
const {developmentContext}=await import('../lib/hris/development-repository.ts');
const {applyLearningAssignment}=await import('../lib/hris/learning-assignments.ts');
const {applyDevelopment}=await import('../lib/hris/development.ts');
const definitions=await import('../app/api/learning-plans/route.ts'),api=await import('../app/api/learning-assignments/route.ts'),self=await import('../app/api/self-service/route.ts');
async function cmd(route,command,status=200,revision){const d=await expect(await route.GET());return expect(await route.POST(request('/api/learning-assignments',{revision:revision??d.revision,command})),status);}
async function definition(f,courses,config={mode:'relative',durationDays:30,allowOverdue:true,progressSync:false,orderedStages:true}){const r=await cmd(definitions,{action:'create',title:'合成首轮学习',orgId:f.org.id,config,courseIds:courses});await cmd(definitions,{action:'seal',id:r.id});return r.id;}
test('first learning instance atomically creates 20 tasks, blocks duplicate instances and permits separate plan versions, closes only after independent evidence',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const courses=[];
 for(let i=0;i<20;i++){const c=await send({action:'course',code:'INSTANCE'+i,title:'合成实例课程'+i,description:'首轮学习与事务容量验证',content:'阅读合成案例，完成实践并提交完整证明材料，由独立人员核验学习成果。'});await send({action:'publishCourse',id:c.id});courses.push(c.id);}
 const def=await definition(f,courses),assign={action:'assign',definitionId:def,employeeId:f.e.id};
 const before=(await get()).revision;
 const snapshot=()=>['hris_workspaces','hris_development_records','hris_development_events','hris_audit_events'].map(table=>f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
 const prior=snapshot();f.sqlite.exec("CREATE TRIGGER fail_instance_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit unavailable'); END");await cmd(api,assign,503);assert.deepEqual(snapshot(),prior);f.sqlite.exec('DROP TRIGGER fail_instance_audit');
 const created=await cmd(api,assign);assert.equal(created.ids.length,21);assert.equal((await get()).revision,before+1);
 const rows=(await expect(await api.GET())).records,instance=rows.find(r=>r.kind==='learningAssignment'),tasks=rows.filter(r=>r.payload.learningAssignmentId===instance.id);assert.equal(tasks.length,20);assert.equal(instance.payload.learningRequirements.length,20);assert.ok(tasks.every(task=>instance.payload.learningRequirements.some(req=>req.id===task.payload.learningRequirementId&&req.resourceId===task.referenceId)));
 await send({action:'cancelEnrollment',id:tasks[0].id,reason:'合成单项先取消，验证整体恢复保留状态'});
 const ctx=await developmentContext();const restored=applyDevelopment(ctx.records,ctx.state,ctx.member,{action:'restoreEnrollment',id:tasks[0].id,due:tasks[0].payload.due,evidence:'允许超期的实例恢复仍保留原截止日'},'2099-01-01T00:00:00Z');assert.equal(restored.payload.due,tasks[0].payload.due);
 await cmd(api,{action:'cancelAssignment',id:instance.id,evidence:'合成整体暂停学习实例'});
 act('employee');assert.ok(!(await expect(await self.GET())).tasks.some(t=>tasks.some(x=>x.id===t.id)));act('owner');
 await send({action:'restoreEnrollment',id:tasks[0].id,due:tasks[0].payload.due,evidence:'整体取消期间不允许绕过实例恢复'},400);
 await cmd(api,{action:'restoreAssignment',id:instance.id,evidence:'合成重新开放原实例学习'});
 assert.equal((await get()).records.find(r=>r.id===tasks[0].id).status,'cancelled');
 await send({action:'restoreEnrollment',id:tasks[0].id,due:tasks[0].payload.due,evidence:'合成独立恢复原先单项取消的课程'});
 const count=()=>f.sqlite.prepare('SELECT count(*) AS n FROM hris_development_records').get().n;
 const n=count();await cmd(api,assign,400);assert.equal(count(),n);await cmd(api,{action:'closeAssignment',id:instance.id},400);
 const revised=await cmd(definitions,{action:'revise',id:def});await cmd(definitions,{action:'seal',id:revised.id});const second=await cmd(api,{...assign,definitionId:revised.id});assert.equal(second.ids.length,21);assert.equal(count(),n+22);
 for(const task of tasks){act('employee');await send({action:'submitLearning',id:task.id,evidence:'合成课程实践完成并提交独立核验'});act('hr');await send({action:'verifyLearning',id:task.id,accepted:true,evidence:'独立确认合成课程成果完整符合要求'});}
 const completedContext=await developmentContext();
 for(const employee of [{...f.e,status:'离职'},{...f.e,orgId:f.otherOrg.id}]){
  const changedState={...completedContext.state,employees:completedContext.state.employees.map(e=>e.id===f.e.id?employee:e)};
  assert.throws(()=>applyLearningAssignment(completedContext.records,changedState,{...completedContext.member,role:'admin'},{action:'closeAssignment',id:instance.id}),/在职员工/);
  assert.equal(applyLearningAssignment(completedContext.records,changedState,{...completedContext.member,role:'admin'},{action:'cancelAssignment',id:instance.id,evidence:'人员状态变化后保留历史并取消办理'})[0].status,'cancelled');
 }
 await cmd(api,{action:'closeAssignment',id:instance.id});assert.equal((await expect(await api.GET())).records.find(r=>r.id===instance.id).status,'completed');await cmd(api,{action:'closeAssignment',id:instance.id},400);
 act('employee');await expect(await api.GET(),403);assert.ok(!(await expect(await self.GET())).tasks.some(t=>tasks.some(task=>task.id===t.id)));
});
test('first instance refuses outside scope, expired dates and stale revision without partial records',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const c=await send({action:'course',code:'I-GUARD',title:'合成边界课程',description:'实例权限与日期校验',content:'合成案例只用于验证权限日期，不含真实人员或企业业务信息。'});await send({action:'publishCourse',id:c.id});
 const base={mode:'relative',durationDays:30,allowOverdue:true,progressSync:false,orderedStages:true};
 for(const config of [{mode:'fixed',start:'2020-01-01',end:'2020-01-02',progressSync:false,orderedStages:true}]){const id=await definition(f,[c.id],config);await cmd(api,{action:'assign',definitionId:id,employeeId:f.e.id},400);}
 const id=await definition(f,[c.id]);act('hr');await cmd(api,{action:'assign',definitionId:id,employeeId:f.other.id},403);
 const revision=(await get()).revision;await definition(f,[c.id]);await cmd(api,{action:'assign',definitionId:id,employeeId:f.e.id},409,revision);
 assert.ok(!(await get()).records.some(r=>r.kind==='learningAssignment'||r.kind==='enrollment'));
 const future=await definition(f,[c.id],{mode:'fixed',start:'2099-01-01',end:due,progressSync:false,orderedStages:true});await cmd(api,{action:'assign',definitionId:future,employeeId:f.e.id});const task=(await get()).records.find(r=>r.kind==='enrollment');
 act('employee');await send({action:'submitLearning',id:task.id,evidence:'尚未开始的合成学习尝试提交'},400);assert.ok(!(await expect(await self.GET())).tasks.some(t=>t.id===task.id));
});
