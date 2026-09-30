import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,get,send,act,expect,request} from './support/foundation-scenario.mjs';
const plans=await import('../app/api/learning-plans/route.ts'),assign=await import('../app/api/learning-assignments/route.ts'),credits=await import('../app/api/learning-credits/route.ts');
const {businessDate}=await import('../lib/hris/business-time.ts');
async function cmd(api,command,status=200){const d=await expect(await api.GET());return expect(await api.POST(request('/api/test',{revision:d.revision,command})),status);}
for(const repeatCredit of [false,true])test(`explicit recurrence isolates rounds and keeps repeat-credit ${repeatCredit} idempotent`,async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());
 const course=await send({action:'course',code:'RECUR',title:'合成周期认证课程',description:'轮次与学分独立',content:'每一轮使用新的合成实践成果，接受独立核验，保留所有历史记录。'});await send({action:'publishCourse',id:course.id});await cmd(credits,{action:'policy',courseId:course.id,creditUnits:100,validityDays:30,evidence:'合成循环课程固定学分规则'});
 const definition=await cmd(plans,{action:'create',title:'显式循环学习',orgId:f.org.id,courseIds:[course.id],config:{mode:'recurring',durationDays:10,allowOverdue:false,orderedStages:false,progressSync:true,repeatCredit,repeatPoints:false}});await cmd(plans,{action:'seal',id:definition.id});await cmd(assign,{action:'assign',definitionId:definition.id,employeeId:f.e.id});
 let rows=(await get()).records;const first=rows.find(r=>r.kind==='learningAssignment'),firstTask=rows.find(r=>r.kind==='enrollment');
 await cmd(assign,{action:'nextRound',id:first.id,start:businessDate()},400);
 async function complete(task){act('employee');await send({action:'submitLearning',id:task.id,evidence:'本轮合成实践成果已经完成'});act('hr');await send({action:'verifyLearning',id:task.id,accepted:true,evidence:'独立核验本轮实践成果符合要求'});}
 await complete(firstTask);await cmd(assign,{action:'closeAssignment',id:first.id});await cmd(credits,{action:'award',enrollmentId:firstTask.id,evidence:'核验完成登记首轮学分'});
 await cmd(assign,{action:'nextRound',id:first.id,start:'2020-01-01'},400);
 const before=(await get()).records.length,revision=(await get()).revision;
 f.sqlite.exec("CREATE TRIGGER recurrence_audit_failure BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic recurrence audit failure'); END");await cmd(assign,{action:'nextRound',id:first.id,start:businessDate()},503);f.sqlite.exec('DROP TRIGGER recurrence_audit_failure');assert.equal((await get()).records.length,before);assert.equal((await get()).revision,revision);
 await cmd(assign,{action:'nextRound',id:first.id,start:businessDate()});await cmd(assign,{action:'nextRound',id:first.id,start:businessDate()},400);
 rows=(await get()).records;const second=rows.find(r=>r.kind==='learningAssignment'&&r.payload.round===2),secondTask=rows.find(r=>r.kind==='enrollment'&&r.payload.learningAssignmentId===second.id);assert.equal(second.payload.previousAssignmentId,first.id);assert.notEqual(first.payload.assignmentKey,second.payload.assignmentKey);assert.equal(secondTask.status,'active');assert.equal(secondTask.payload.sourceEnrollmentId,undefined);
 await complete(secondTask);await cmd(credits,{action:'award',enrollmentId:secondTask.id,evidence:'整轮未结项不能授予重复学分'},400);await cmd(assign,{action:'closeAssignment',id:second.id});await cmd(credits,{action:'award',enrollmentId:secondTask.id,evidence:'本轮结项后按冻结规则登记学分'},repeatCredit?200:400);await cmd(credits,{action:'award',enrollmentId:secondTask.id,evidence:'重复请求不得额外登记学分'},400);
 rows=(await get()).records;assert.equal(rows.filter(r=>r.kind==='learningCredit').length,repeatCredit?2:1);assert.equal(rows.find(r=>r.id===firstTask.id).status,'completed');
 if(repeatCredit){const award=rows.find(r=>r.kind==='learningCredit'&&r.referenceId===secondTask.id);assert.equal(award.payload.round,2);assert.equal(award.payload.learningAssignmentId,second.id);assert.equal(award.payload.repeatCreditApplied,true);act('owner');await cmd(credits,{action:'reverse',awardId:award.id,evidence:'其他管理员核验撤销合成重复学分'});await cmd(credits,{action:'award',enrollmentId:secondTask.id,evidence:'撤销不清除本轮授予唯一性'},400);}
 act('hr');const latest=await expect(await assign.GET());act('employee');await expect(await assign.POST(request('/api/test',{revision:latest.revision,command:{action:'nextRound',id:second.id,start:businessDate()}})),403);
});
