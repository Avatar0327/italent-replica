import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,act,expect,request} from './support/foundation-scenario.mjs';
const definitions=await import('../app/api/learning-plans/route.ts'),assignments=await import('../app/api/learning-assignments/route.ts'),self=await import('../app/api/self-service/route.ts');
async function cmd(api,command,status=200){const d=await expect(await api.GET());return expect(await api.POST(request('/api/learning-plans',{revision:d.revision,command})),status);}
test('versioned instance stages gate tasks and close at independent required/optional thresholds without crediting unfinished electives',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const courses=[];
 for(let i=0;i<4;i++){const c=await send({action:'course',code:'STAGE'+i,title:'合成阶段课程'+i,description:'阶段独立核验',content:'阅读案例并实践，提交成果由独立人员核验，不含真实数据。'});await send({action:'publishCourse',id:c.id});courses.push(c.id);}
 const definition=await cmd(definitions,{action:'create',title:'两阶段培养闭环',orgId:f.org.id,config:{mode:'relative',durationDays:30,allowOverdue:false,orderedStages:true,progressSync:false},courseIds:courses});
 const stages=[{title:'实践准备',courseIds:courses.slice(0,3),optionalCourseIds:courses.slice(1,3),requiredMinimum:1,optionalMinimum:1},{title:'实践应用',courseIds:[courses[3]]}];
 await cmd(definitions,{action:'stages',id:definition.id,stages:[stages[0]]},400);
 await cmd(definitions,{action:'stages',id:definition.id,stages:[{...stages[0],optionalMinimum:3},stages[1]]},400);
 await cmd(definitions,{action:'stages',id:definition.id,stages});await cmd(definitions,{action:'seal',id:definition.id});
 await cmd(definitions,{action:'stages',id:definition.id,stages},400);
 await cmd(assignments,{action:'assign',definitionId:definition.id,employeeId:f.e.id});
 let records=(await get()).records;const instance=records.find(r=>r.kind==='learningAssignment'),tasks=courses.map(id=>records.find(r=>r.kind==='enrollment'&&r.referenceId===id));
 assert.deepEqual(instance.payload.trainingStages,stages);
 act('employee');let pending=await expect(await self.GET());assert.ok(!pending.tasks.some(t=>t.id===tasks[3].id));
 await send({action:'submitLearning',id:tasks[3].id,evidence:'前阶段未核验，不应提前提交后续成果'},400);
 async function complete(i){act('employee');await send({action:'submitLearning',id:tasks[i].id,evidence:'完成合成实践并提交学习成果'});act('hr');await send({action:'verifyLearning',id:tasks[i].id,accepted:true,evidence:'独立核验成果符合合成课程要求'});}
 await complete(0);act('employee');assert.ok(!(await expect(await self.GET())).tasks.some(t=>t.id===tasks[3].id));
 await complete(1);act('employee');assert.ok((await expect(await self.GET())).tasks.some(t=>t.id===tasks[3].id));
 act('hr');await cmd(assignments,{action:'closeAssignment',id:instance.id},400);
 await complete(3);await cmd(assignments,{action:'closeAssignment',id:instance.id});
 records=(await get()).records;assert.equal(records.find(r=>r.id===instance.id).status,'completed');assert.equal(records.find(r=>r.id===tasks[2].id).status,'cancelled');assert.ok(!records.find(r=>r.id===tasks[2].id).payload.verifiedBy);
 await send({action:'restoreEnrollment',id:tasks[2].id,due:tasks[2].payload.due,evidence:'结项后不可恢复被关闭的选修任务'},400);
 act('employee');assert.ok(!(await expect(await self.GET())).tasks.some(t=>tasks.some(x=>x.id===t.id)));
 act('owner');const next=await cmd(definitions,{action:'revise',id:definition.id});await cmd(definitions,{action:'stages',id:next.id,stages:[{title:'后续版本',courseIds:courses}]});
 assert.deepEqual((await expect(await assignments.GET())).records.find(r=>r.id===instance.id).payload.trainingStages,stages);
 const delayed=await cmd(definitions,{action:'create',title:'延迟开放历史复用',orgId:f.org.id,config:{mode:'relative',durationDays:30,allowOverdue:false,orderedStages:false,progressSync:true},courseIds:[courses[0]]});
 await cmd(definitions,{action:'stages',id:delayed.id,stages:[{title:'加入两天后开放',courseIds:[courses[0]],startAfterDays:2}]});await cmd(definitions,{action:'seal',id:delayed.id});
 await cmd(assignments,{action:'assign',definitionId:delayed.id,employeeId:f.e.id});
 const delayedInstance=(await expect(await assignments.GET())).records.find(r=>r.kind==='learningAssignment'&&r.referenceId===delayed.id);
 await cmd(assignments,{action:'closeAssignment',id:delayedInstance.id},400);
 const independent=await cmd(definitions,{action:'create',title:'延迟开放新学',orgId:f.org.id,config:{mode:'relative',durationDays:30,allowOverdue:false,orderedStages:false,progressSync:false},courseIds:[courses[0]]});
 await cmd(definitions,{action:'stages',id:independent.id,stages:[{title:'加入两天后开放',courseIds:[courses[0]],startAfterDays:2}]});await cmd(definitions,{action:'seal',id:independent.id});
 await cmd(assignments,{action:'assign',definitionId:independent.id,employeeId:f.e.id});
 const independentRows=(await expect(await assignments.GET())).records,independentInstance=independentRows.find(r=>r.kind==='learningAssignment'&&r.referenceId===independent.id),independentTask=independentRows.find(r=>r.kind==='enrollment'&&r.payload.learningAssignmentId===independentInstance.id);
 act('employee');assert.ok(!(await expect(await self.GET())).tasks.some(t=>t.id===independentTask.id));await send({action:'submitLearning',id:independentTask.id,evidence:'阶段尚未开放不应提前提交成果'},400);
 act('owner');const impossible=await cmd(definitions,{action:'create',title:'不可达阶段拒绝派发',orgId:f.org.id,config:{mode:'relative',durationDays:1,allowOverdue:false,orderedStages:false,progressSync:false},courseIds:[courses[0]]});
 await cmd(definitions,{action:'stages',id:impossible.id,stages:[{title:'已过截止才开放',courseIds:[courses[0]],startAfterDays:2}]});await cmd(definitions,{action:'seal',id:impossible.id});
 const before=(await get()).records.length;await cmd(assignments,{action:'assign',definitionId:impossible.id,employeeId:f.e.id},400);assert.equal((await get()).records.length,before);


});
