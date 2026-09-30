import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,core,grant,expect,hris,dev,members,act,request,anchors,due} from './support/foundation-scenario.mjs';
const selfService=await import('../app/api/self-service/route.ts');
import {readProfile,checkProfile,checkOutside} from './support/cadre-checks.mjs';

test('H002 G1-02：离职后的未完成计划和学习保留历史、拒绝新业务，离职账号可保留关联停用并立即撤权',async t=>{
 const {sqlite,e,org,otherOrg}=await setup();t.after(()=>sqlite.close());
 const standard=await send({action:'standard',code:'H002-EXIT',name:'合成离职场景能力',anchors});
 const planInput={action:'plan',employeeId:e.id,standardId:standard.id,target:3,title:'合成未完成发展行动',actionPlan:'合成案例实践及独立核验',due};
 const plan=await send(planInput);
 const course=await send({action:'course',code:'H002-EXIT-COURSE',title:'合成离职场景课程',standardId:standard.id,description:'验证未完成任务离职状态',content:'合成材料用于验证离职后权限，不使用真实人员信息。'});
 await send({action:'publishCourse',id:course.id});
 const enrollment=await send({action:'enroll',employeeId:e.id,planId:plan.id,courseId:course.id,due});
 await grant('exitOutside','hr',null,[otherOrg.id]);
 await core({action:'workflow',kind:'exit',steps:[{userId:'approver',name:'合成独立审批人'}]});
 act('hr');await core({action:'request',employeeId:e.id,kind:'exit',orgId:org.id,reason:'合成未完成任务的离职组合验证'});
 const pending=(await expect(await hris.GET())).state.approvals.find(x=>x.employeeId===e.id&&x.kind==='exit'&&x.status==='pending');
 act('approver');await core({action:'decide',id:pending.id,decision:'approved'});
 for(const role of ['owner','hr','manager']){
  act(role);const p=await checkProfile(e.id,plan.id,enrollment.id,'进行中');assert.equal(p.employee.status,'离职');
  for(const id of [plan.id,enrollment.id]){
   assert.equal((await get()).records.find(r=>r.id===id).status,'active');
   const history=await expect(await dev.GET(request('/api/development?id='+id)));assert.equal(history.items.length,1);assert.equal(history.items[0].snapshot.status,'active');
  }
 }
 await checkOutside('exitOutside',e.id,[plan.id,enrollment.id]);
 act('employee');await readProfile(e.id,403);
 // Employee membership is still active: exit alone does not revoke historical self access.
 for(const id of [plan.id,enrollment.id]){assert.ok((await get()).records.some(r=>r.id===id));assert.equal((await expect(await dev.GET(request('/api/development?id='+id)))).items.length,1);}
 const portal=await expect(await selfService.GET());assert.ok(!portal.tasks.some(task=>[plan.id,enrollment.id].includes(task.id)));
 const revision=(await get()).revision;
 for(const [action,id] of [['submitPlan',plan.id],['submitLearning',enrollment.id]]){
  const error=await send({action,id,evidence:'合成离职人员尝试提交旧任务'},400);assert.match(error.error,/离职/);
 }
 act('hr');assert.match((await send(planInput,400)).error,/离职/);assert.equal((await get()).revision,revision);
 // C-DEF-01 regression: explicit disable preserves historical link and revokes access.
 act('owner');const disable={revision:(await expect(await members.GET())).revision,email:'employee@example.com',name:'employee',role:'employee',employeeId:e.id,orgScope:[],viewEmail:false,viewLevel:false,active:false};
 await expect(await members.POST(request('/api/members',disable)));
 const after=await expect(await members.GET()),saved=after.members.find(m=>m.email==='employee@example.com');
 assert.equal(after.revision,disable.revision+1);assert.equal(saved.active,0);assert.equal(saved.employeeId,e.id);
 assert.equal(sqlite.prepare("SELECT active FROM hris_memberships WHERE user_id='employee'").get().active,0);
 assert.ok(sqlite.prepare('SELECT subject FROM hris_audit_events WHERE revision=?').all(after.revision).some(x=>JSON.parse(x.subject).active===false));
 await expect(await members.POST(request('/api/members',disable)),409);
 for(const command of [{...disable,active:true},{...disable,employeeId:'missing'},{...disable,email:'owner@example.com',role:'admin',employeeId:null}]){
  await expect(await members.POST(request('/api/members',{...command,revision:after.revision})),400);
  assert.equal((await expect(await members.GET())).revision,after.revision);
 }
 act('employee');await expect(await hris.GET(),403);await expect(await dev.GET(),403);await readProfile(e.id,403);
 for(const id of [plan.id,enrollment.id])await expect(await dev.GET(request('/api/development?id='+id)),403);
 // A scoped HR without an employee link can be disabled normally; all three read surfaces then reject it.
 act('owner');await expect(await members.POST(request('/api/members',{revision:(await expect(await members.GET())).revision,email:'hr@example.com',name:'hr',role:'hr',employeeId:null,orgScope:[org.id],viewEmail:false,viewLevel:false,active:false})));
 act('hr');await expect(await dev.GET(),403);await readProfile(e.id,403);
 for(const id of [plan.id,enrollment.id])await expect(await dev.GET(request('/api/development?id='+id)),403);
 act('owner');await checkProfile(e.id,plan.id,enrollment.id,'进行中');
});
