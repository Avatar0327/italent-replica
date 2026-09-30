import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,expect,hris,dev,act,request,anchors,due,grant} from './support/foundation-scenario.mjs';
const sessions=await import('../app/api/training-sessions/route.ts');
const credits=await import('../app/api/learning-credits/route.ts');
const profiles=await import('../app/api/cadre-profiles/route.ts');

// H003: real route calls over the existing isolated synthetic SQLite fixture.
test('G1-03 H003：同员工计划与两阶段考试、强制出勤、独立核验、恢复及学分来源闭环',async t=>{
 const {sqlite,e,org,otherOrg}=await setup();t.after(()=>sqlite.close());
 const snapshot=()=>['hris_workspaces','hris_development_records','hris_development_events','hris_audit_events'].map(table=>sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
 async function rejected(call,pattern){const before=snapshot();const error=await call();assert.match(error.error,pattern);assert.deepEqual(snapshot(),before);}
 async function post(api,path,command,status=200){return expect(await api.POST(request(path,{revision:(await get()).revision,command})),status);}
 const session=(command,status)=>post(sessions,'/api/training-sessions',command,status);
 const credit=(command,status)=>post(credits,'/api/learning-credits',command,status);
 const record=async id=>(await get()).records.find(r=>r.id===id);
 const evidence='合成证据：按两阶段要求核实实践成果';
 const beforeEmployee=(await expect(await hris.GET())).state.employees.find(x=>x.id===e.id);
 const standard=await send({action:'standard',code:'H003-ABILITY',name:'合成两阶段能力',anchors});
 const plan=await send({action:'plan',employeeId:e.id,standardId:standard.id,target:3,title:'合成两阶段发展行动',actionPlan:'先通过基础考试和出勤，再完成实践阶段并独立核验',due});
 const courses=[],policies=[];
 for(let i=0;i<2;i++){
  const c=await send({action:'course',code:'H003-COURSE-'+i,title:'合成阶段课程'+i,standardId:standard.id,description:'同一标准版本的阶段课程',content:'阅读合成案例，完成考试和必修场次，提交实践证据供独立管理者核验。'});
  await send({action:'exam',courseId:c.id,questions:[{prompt:'合成案例应如何处理？',options:['记录并核实证据','忽略证据'],correct:0}],passingScore:100,maxAttempts:2});
  policies.push(await credit({action:'policy',courseId:c.id,creditUnits:100*(i+1),validityDays:30,evidence}));
  await send({action:'publishCourse',id:c.id});courses.push(c.id);
 }
 const training=await send({action:'training',name:'H003合成两阶段项目',orgId:org.id,period:'H003',start:'2026-01-01',end:due,instructor:'合成讲师',courseIds: courses});
 const stages=courses.map((id,i)=>({title:'阶段'+(i+1),courseIds:[id]}));
 await send({action:'trainingStages',id:training.id,stages});await send({action:'publishTraining',id:training.id});
 const meetings=[];
 for(let i=0;i<2;i++)meetings.push(await session({action:'session',trainingId:training.id,courseId:courses[i],title:'合成必修场次'+i,startAt:`2026-01-0${i+2}T01:00:00Z`,endAt:`2026-01-0${i+2}T02:00:00Z`,location:'合成教室',instructor:'合成讲师',mandatory:true}));
 const enroll=courseId=>({action:'enroll',employeeId:e.id,planId:plan.id,trainingId:training.id,courseId,due});
 await rejected(()=>send(enroll(courses[1]),400),/此前阶段/);
 const first=await send(enroll(courses[0]));
 await grant('learningOutside','hr',null,[otherOrg.id]);act('learningOutside');
 await rejected(()=>send({action:'cancelEnrollment',id:first.id,reason:evidence},403),/权限/);
 act('employee');await rejected(()=>send({action:'submitLearning',id:first.id,evidence},400),/考试/);
 const failed=await send({action:'attemptExam',enrollmentId:first.id,answers:[1]});
 const failedRecord=await record(failed.id);assert.equal(failedRecord.payload.passed,false);
 act('manager');await send({action:'cancelEnrollment',id:first.id,reason:evidence});
 await rejected(()=>send(enroll(courses[0]),400),/已领取/);
 await send({action:'restoreEnrollment',id:first.id,due,evidence});
 await rejected(()=>send({action:'restoreEnrollment',id:first.id,due,evidence},400),/取消/);
 assert.deepEqual(await record(failed.id),failedRecord);
 let restored=await record(first.id);assert.equal(restored.payload.planId,plan.id);assert.equal(restored.payload.trainingId,training.id);
 act('employee');await rejected(()=>send({action:'submitLearning',id:first.id,evidence},400),/考试/);
 await send({action:'attemptExam',enrollmentId:first.id,answers:[0]});
 assert.equal((await get()).records.filter(r=>r.kind==='attempt'&&r.referenceId===first.id).length,2);
 await rejected(()=>send({action:'attemptExam',enrollmentId:first.id,answers:[0]},400),/已通过/);
 await send({action:'submitLearning',id:first.id,evidence});
 await rejected(()=>send({action:'verifyLearning',id:first.id,accepted:true,evidence},403),/核验|本人|权限/);
 act('hr');await rejected(()=>credit({action:'award',enrollmentId:first.id,evidence},400),/独立核验/);
 act('manager');await rejected(()=>send({action:'verifyLearning',id:first.id,accepted:true,evidence},400),/必修/);
 await rejected(()=>send(enroll(courses[1]),400),/此前阶段/);
 // A managerial submitter cannot verify their own attendance submission.
 act('hr');const attendance=await session({action:'recordAttendance',sessionId:meetings[0].id,employeeId:e.id,present:true,evidence});
 await rejected(()=>session({action:'verifyAttendance',id:attendance.id,accepted:true,evidence},403),/不能自审/);
 act('manager');await rejected(()=>send({action:'verifyLearning',id:first.id,accepted:true,evidence},400),/必修/);
 await session({action:'verifyAttendance',id:attendance.id,accepted:true,evidence});
 await send({action:'verifyLearning',id:first.id,accepted:true,evidence});
 await rejected(()=>send({action:'verifyLearning',id:first.id,accepted:true,evidence},400),/已经处理/);
 act('owner');await rejected(()=>send({action:'closeTraining',id:training.id},400),/未结束的培训场次/);
 const second=await send(enroll(courses[1]));
 act('employee');await send({action:'attemptExam',enrollmentId:second.id,answers:[0]});
 await send({action:'submitLearning',id:second.id,evidence:'H003取消前实践成果保留在历史'});
 act('manager');await send({action:'cancelEnrollment',id:second.id,reason:evidence});await send({action:'restoreEnrollment',id:second.id,due,evidence});
 restored=await record(second.id);assert.equal(restored.status,'active');assert.equal(restored.payload.submittedBy,undefined);
 assert.equal((await get()).records.filter(r=>r.kind==='attempt'&&r.referenceId===second.id&&r.payload.passed).length,1);
 await rejected(()=>send({action:'verifyLearning',id:second.id,accepted:true,evidence},400),/尚未提交/);
 // A learner with a manager role still cannot verify their own submission.
 await grant('employee','manager',e.id,[org.id],true);act('employee');await send({action:'submitLearning',id:second.id,evidence});
 await rejected(()=>send({action:'verifyLearning',id:second.id,accepted:true,evidence},403),/核验|本人|提交/);
 act('employee');const attendance2=await session({action:'declare',sessionId:meetings[1].id,evidence});
 await send({action:'submitPlan',id:plan.id,evidence});
 act('manager');await rejected(()=>send({action:'verifyPlan',id:plan.id,accepted:true,evidence},400),/关联学习/);
 await rejected(()=>send({action:'verifyLearning',id:second.id,accepted:true,evidence},400),/必修/);
 await session({action:'verifyAttendance',id:attendance2.id,accepted:true,evidence});
 await send({action:'verifyLearning',id:second.id,accepted:true,evidence});await send({action:'verifyPlan',id:plan.id,accepted:true,evidence});
 for(const actor of ['manager','hr']){
  act(actor);const p=await expect(await profiles.GET(request('/api/cadre-profiles?employeeId='+e.id)));
  for(const [key,id] of [['plans',plan.id],['learning',first.id],['learning',second.id]])assert.equal(p.sections.find(s=>s.key===key).items.find(x=>x.id===id).status,'已完成');
  assert.deepEqual(p.sections.find(s=>s.key==='qualifications').items,[]);
 }
 act('owner');assert.deepEqual((await expect(await hris.GET())).state.employees.find(x=>x.id===e.id),beforeEmployee);
 const awards=[];
 for(const [i,task] of [first,second].entries()){
  const award=await credit({action:'award',enrollmentId:task.id,evidence});awards.push(award);
  await rejected(()=>credit({action:'award',enrollmentId:task.id,evidence},400),/重复授予/);
  const r=(await expect(await credits.GET())).records.find(r=>r.id===award.id);
  assert.equal(r.referenceId,task.id);assert.equal(r.payload.source,policies[i].id);assert.equal(r.payload.validityDays,30);assert.equal(r.payload.verifiedBy,'manager');
  assert.equal(Date.parse(r.payload.validUntil)-Date.parse(r.payload.awardedOn),29*86400000);
 }
 let summary=(await expect(await credits.GET())).summary.find(x=>x.employeeId===e.id);assert.equal(summary.availableUnits,300);
 await rejected(()=>credit({action:'reverse',awardId:awards[0].id,evidence},403),/其他/);
 act('hr');await credit({action:'reverse',awardId:awards[0].id,evidence});
 await rejected(()=>credit({action:'reverse',awardId:awards[0].id,evidence},400),/已经撤销/);
 await rejected(()=>credit({action:'award',enrollmentId:first.id,evidence},400),/重复授予/);
 summary=(await expect(await credits.GET())).summary.find(x=>x.employeeId===e.id);
 assert.deepEqual([summary.awardedUnits,summary.reversedUnits,summary.netUnits,summary.expiredUnits,summary.availableUnits],[300,100,200,0,200]);
 assert.equal((await record(first.id)).status,'completed');
 act('owner');for(const meeting of meetings)await session({action:'closeSession',id:meeting.id,evidence});await send({action:'closeTraining',id:training.id});assert.equal((await record(training.id)).status,'closed');
 const history=await expect(await dev.GET(request('/api/development?id='+second.id)));
 assert.ok(history.items.some(x=>x.snapshot.payload.evidence==='H003取消前实践成果保留在历史'));
 assert.ok(history.items.some(x=>x.snapshot.status==='cancelled'));assert.ok(history.items.some(x=>x.snapshot.payload.restoredBy==='manager'));
 const records=(await get()).records;
 assert.equal(records.filter(r=>r.kind==='enrollment'&&r.employeeId===e.id).length,2);
 assert.equal(records.filter(r=>r.kind==='attempt'&&[first.id,second.id].includes(r.referenceId)).length,3);
 t.diagnostic('H003: two stages completed; attempts 2+1 retained; credits 300 awarded/100 reversed/200 available; rejection snapshots unchanged.');
});
