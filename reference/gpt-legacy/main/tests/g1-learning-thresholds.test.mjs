import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,act,anchors,due,expect,request} from './support/foundation-scenario.mjs';
const reports=await import('../app/api/reports/route.ts');
test('Learning thresholds: optional course counts unlock next stage, invalid minima reject, legacy rules remain',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());
 const standard=await send({action:'standard',code:'THRESHOLD',name:'合成阶段标准',anchors}),courses=[];
 for(let i=0;i<4;i++){const c=await send({action:'course',code:'TH'+i,title:'合成阈值课程'+i,standardId:standard.id,description:'阶段完成规则验证',content:'阅读合成案例，完成实践任务并记录成果，提交充分的材料供独立管理者核验。'});await send({action:'publishCourse',id:c.id});courses.push(c.id);}
 const training=await send({action:'training',name:'合成选必修阶段',orgId:f.org.id,period:'TH',start:'2026-01-01',end:due,instructor:'合成讲师',courseIds:courses});
 const stages=[{title:'基础',courseIds:courses.slice(0,3),optionalCourseIds:courses.slice(1,3),requiredMinimum:1,optionalMinimum:1},{title:'实践',courseIds:[courses[3]]}];
 await send({action:'trainingStages',id:training.id,stages:[{...stages[0],requiredMinimum:2},stages[1]]},400);
 await send({action:'trainingStages',id:training.id,stages});await send({action:'publishTraining',id:training.id});
 const enroll=courseId=>({action:'enroll',employeeId:f.e.id,courseId,trainingId:training.id,due});
 await send(enroll(courses[3]),400);
 async function complete(courseId){act('owner');const task=await send(enroll(courseId));act('employee');await send({action:'submitLearning',id:task.id,evidence:'合成课程实践成果完成供独立核验'});act('hr');await send({action:'verifyLearning',id:task.id,accepted:true,evidence:'独立核验合成材料符合完成要求'});act('owner');}
 await complete(courses[0]);await send(enroll(courses[3]),400);
 await complete(courses[1]);
 await send({action:'dispatchTrainingStage',id:training.id,employeeIds:[f.e.id],due});
 const task=(await get()).records.find(r=>r.kind==='enrollment'&&r.referenceId===courses[3]&&r.payload.trainingId===training.id);assert.ok(task);
 assert.ok(!(await get()).records.some(r=>r.kind==='enrollment'&&r.referenceId===courses[2]));
 act('employee');await send({action:'submitLearning',id:task.id,evidence:'合成实践阶段完成并提交独立核验'});act('hr');await send({action:'verifyLearning',id:task.id,accepted:true,evidence:'独立确认实践阶段全部目标达成'});act('owner');await send({action:'closeTraining',id:training.id});
 assert.equal((await get()).records.find(r=>r.id===training.id).status,'closed');
 const report=await expect(await reports.GET(request('/api/reports?dataset=trainingStageProgress')));assert.equal(report.rows[0][11],'是');assert.equal(report.rows[0][7],3);
});
