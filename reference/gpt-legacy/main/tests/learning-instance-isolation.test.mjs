import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,act,expect,request,due} from './support/foundation-scenario.mjs';
const reports=await import('../app/api/reports/route.ts'),profiles=await import('../app/api/cadre-profiles/route.ts');
const definitions=await import('../app/api/learning-plans/route.ts'),assignments=await import('../app/api/learning-assignments/route.ts'),credits=await import('../app/api/learning-credits/route.ts');
async function cmd(route,command,status=200){const d=await expect(await route.GET());return expect(await route.POST(request('/api/test',{revision:d.revision,command})),status);}
test('same course across plans isolates exams and preserves legacy constraints, rewards and cancellation history',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());
 const c=await send({action:'course',code:'ISOLATED',title:'合成重复学习课程',description:'验证各计划的考试独立与学分去重',content:'阅读合成案例，完成对应计划的实践任务，提交充分成果材料供独立核验。'});
 await send({action:'exam',courseId:c.id,questions:[{prompt:'合成安全案例的正确操作是哪个选项',options:['先核实再执行','跳过核实直接执行'],correct:0}],passingScore:100,maxAttempts:2});await send({action:'publishCourse',id:c.id});
 await cmd(credits,{action:'policy',courseId:c.id,creditUnits:100,evidence:'合成课程固定学分，不重复发放'});
 const legacy=await send({action:'enroll',employeeId:f.e.id,courseId:c.id,due});
 async function complete(task){act('employee');await send({action:'attemptExam',enrollmentId:task.id,answers:[0]});await send({action:'submitLearning',id:task.id,evidence:'该计划独立完成的合成实践材料'});act('hr');await send({action:'verifyLearning',id:task.id,accepted:true,evidence:'独立核实该次学习证据完整有效'});act('owner');}
 await complete(legacy);const award=await cmd(credits,{action:'award',enrollmentId:legacy.id,evidence:'按合成课程规则登记首次学分'});
 async function assign(title,progressSync=false){const d=await cmd(definitions,{action:'create',title,orgId:f.org.id,config:{mode:'relative',durationDays:30,allowOverdue:true,orderedStages:true,progressSync},courseIds:[c.id]});await cmd(definitions,{action:'seal',id:d.id});const a=await cmd(assignments,{action:'assign',definitionId:d.id,employeeId:f.e.id});return (await get()).records.find(r=>r.kind==='enrollment'&&a.ids.includes(r.id));}
 const first=await assign('合成计划一'),second=await assign('合成计划二');assert.notEqual(first.id,second.id);assert.notEqual(first.id,legacy.id);
 await send({action:'enroll',employeeId:f.e.id,courseId:c.id,due},400);
 await send({action:'enroll',assignmentId:'forged',employeeId:f.e.id,courseId:c.id,due},403);
 await send({action:'enroll',assignmentId:first.payload.learningAssignmentId,employeeId:f.other.id,courseId:c.id,due:first.payload.due},400);
 act('employee');await send({action:'submitLearning',id:first.id,evidence:'不能借用此前计划的考试通过结果'},400);await send({action:'attemptExam',enrollmentId:first.id,answers:[1]});
 act('owner');await send({action:'cancelEnrollment',id:first.id,reason:'合成暂停本实例任务保留考试次数'});await send({action:'restoreEnrollment',id:first.id,due:first.payload.due,evidence:'仅恢复原任务，不创建其他计划记录'});
 await complete(first);act('employee');await send({action:'submitLearning',id:second.id,evidence:'第二计划仍须完成自己的课程考试'},400);act('owner');await complete(second);
 const attempts=(await get()).records.filter(r=>r.kind==='attempt');assert.equal(attempts.filter(r=>r.referenceId===legacy.id).length,1);assert.equal(attempts.filter(r=>r.referenceId===first.id).length,2);assert.equal(attempts.filter(r=>r.referenceId===second.id).length,1);
 await cmd(credits,{action:'award',enrollmentId:first.id,evidence:'重复学习不得重复登记课程学分'},400);
 act('hr');await cmd(credits,{action:'reverse',awardId:award.id,evidence:'合成独立撤销原学分并保留来源'});act('owner');await cmd(credits,{action:'award',enrollmentId:second.id,evidence:'撤销原学分不能通过其他实例补领'},400);
 const reused=await assign('合成历史同步计划',true);assert.equal(reused.status,'completed');assert.ok([legacy.id,first.id,second.id].includes(reused.payload.sourceEnrollmentId));assert.ok(reused.payload.sourceVerifiedBy);assert.ok(reused.payload.sourceExamAttemptId);
 assert.equal((await get()).records.filter(r=>r.kind==='attempt').length,4);await cmd(credits,{action:'award',enrollmentId:reused.id,evidence:'历史复用不能再次领取课程学分'},400);await cmd(assignments,{action:'closeAssignment',id:reused.payload.learningAssignmentId});
 const nextCourse=await send({action:'course',code:'ISOLATED',title:'合成新版课程',description:'版本不同不可自动等效',content:'本版案例与旧版不同，需要完成新的学习，不自动认定旧版成绩有效。'});await send({action:'publishCourse',id:nextCourse.id});const def=await cmd(definitions,{action:'create',title:'合成新版同步',orgId:f.org.id,config:{mode:'relative',durationDays:30,allowOverdue:true,orderedStages:true,progressSync:true},courseIds:[nextCourse.id]});await cmd(definitions,{action:'seal',id:def.id});const next=await cmd(assignments,{action:'assign',definitionId:def.id,employeeId:f.e.id});const fresh=(await get()).records.find(r=>r.kind==='enrollment'&&next.ids.includes(r.id));assert.equal(fresh.status,'active');assert.equal(fresh.payload.sourceEnrollmentId,undefined);
 const report=await expect(await reports.GET(request('/api/reports?dataset=learning')));const reuseRow=report.rows.find(row=>row[6]===reused.payload.learningAssignmentId);assert.equal(reuseRow[8],'历史复用');assert.equal(reuseRow[9],reused.payload.sourceEnrollmentId);
 const profile=await expect(await profiles.GET(request('/api/cadre-profiles?employeeId='+f.e.id)));assert.match(profile.sections.find(s=>s.key==='learning').items.find(r=>r.id===reused.id).detail,/引用历史核验完成/);
 const future=await cmd(definitions,{action:'create',title:'合成未来同步计划',orgId:f.org.id,config:{mode:'fixed',start:'2099-01-01',end:due,orderedStages:true,progressSync:true},courseIds:[c.id]});await cmd(definitions,{action:'seal',id:future.id});const later=await cmd(assignments,{action:'assign',definitionId:future.id,employeeId:f.e.id});const laterInstance=(await get()).records.find(r=>r.kind==='learningAssignment'&&later.ids.includes(r.id));await cmd(assignments,{action:'closeAssignment',id:laterInstance.id},400);
 const ledger=(await expect(await credits.GET())).records;assert.equal(ledger.filter(r=>r.kind==='learningCredit').length,1);assert.equal(ledger.filter(r=>r.kind==='creditReversal').length,1);
});

test('legacy cancelled task restores with original ID after an independent instance is assigned',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const c=await send({action:'course',code:'LEGACY-RESTORE',title:'合成旧任务恢复',description:'不让新实例阻塞旧任务恢复',content:'保留原任务身份与历史记录，新的学习实例不能让既有取消任务永久失去恢复途径。'});await send({action:'publishCourse',id:c.id});
 const legacy=await send({action:'enroll',employeeId:f.e.id,courseId:c.id,due});await send({action:'cancelEnrollment',id:legacy.id,reason:'先取消旧任务再分配独立实例'});
 const d=await cmd(definitions,{action:'create',title:'合成并行计划',orgId:f.org.id,config:{mode:'relative',durationDays:30,allowOverdue:true,orderedStages:true,progressSync:false},courseIds:[c.id]});await cmd(definitions,{action:'seal',id:d.id});await cmd(assignments,{action:'assign',definitionId:d.id,employeeId:f.e.id});
 await send({action:'restoreEnrollment',id:legacy.id,due,evidence:'恢复原任务，不生成第三条报名记录'});assert.equal((await get()).records.find(r=>r.id===legacy.id).status,'active');assert.equal((await get()).records.filter(r=>r.kind==='enrollment').length,2);await send({action:'enroll',employeeId:f.e.id,courseId:c.id,due},400);
});
