import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,get,expect,dev,members,request,grant} from './support/foundation-scenario.mjs';
import {perf,change,checkin,performance,changes,checkins,planFor,moveEmployee,revisedGoals} from './support/performance-scenario.mjs';

const inbox=await import('../app/api/work-inbox/route.ts');
const selfService=await import('../app/api/self-service/route.ts');
for(const kind of ['exit','transfer'])test(`H004 P-DEF-01: ${kind} blocks active plan progression, keeps history and cancellation`,async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());
 const draft=await planFor(f,'draft','DRAFT'),confirmed=await planFor(f,'confirmed','CONFIRMED');
 act('employee');const pending=await change({action:'request',planId:confirmed.p.id,goals:revisedGoals,evidence:'合成业务变化申请调整待复核'});
 const logPlan=await planFor(f,'confirmed','CHECKIN');act('employee');const log=await checkin({action:'submit',planId:logPlan.p.id,goalIndex:0,progress:20,evidence:'合成旧组织阶段成果待反馈',actionPlan:'根据反馈继续完善交付成果'});
 const submitted=await planFor(f,'submitted','SUBMITTED'),evaluated=await planFor(f,'evaluated','EVALUATED');
 await moveEmployee(f,kind);
 const revision=(await get()).revision;
 for(const api of [performance,changes,checkins]){
  const view=await expect(await api.GET());assert.ok(!view.livePlanIds.includes(draft.p.id));assert.ok(!view.livePlanIds.includes(logPlan.p.id));
 }
 const queue=await expect(await inbox.GET(request('/api/work-inbox?domain=performance')));
 assert.ok(!queue.items.some(r=>[draft.p.id,submitted.p.id,evaluated.p.id,log.id].includes(r.recordId)));
 act('employee');const self=await expect(await selfService.GET());assert.ok(!self.tasks.some(r=>r.id===logPlan.p.id));act('owner');
 // Admin sees both organizations: access alone must not bypass the cycle's employee bounds.
 for(const c of [
  {action:'confirmGoals',id:draft.p.id},
  {action:'evaluate',id:submitted.p.id,scores:[80,80],evidence:'人员状态变化后不能继续评价'},
  {action:'returnPerformance',id:submitted.p.id,evidence:'人员状态变化后不能重启自评'},
  {action:'publishPerformance',id:evaluated.p.id,evidence:'人员状态变化后不能继续发布'}
 ])await perf(c,400);
 await change({action:'review',id:pending.id,accepted:true,evidence:'人员变化后不能批准旧周期目标'},400);
 await change({action:'request',planId:logPlan.p.id,goals:revisedGoals,evidence:'人员变化后不能申请旧周期调整'},400);
 await checkin({action:'feedback',id:log.id,accepted:true,evidence:'人员变化后不能继续确认旧周期进展'},400);
 assert.equal((await get()).revision,revision);
 act('employee');await perf({action:'selfReview',id:logPlan.p.id,evidence:'人员变化后不能继续提交旧周期自评'},kind==='exit'?400:403);
 await checkin({action:'submit',planId:logPlan.p.id,goalIndex:1,progress:20,evidence:'人员变化后不能继续提交进展',actionPlan:'保留原计划等待管理者关闭'},kind==='exit'?400:403);
 assert.ok((await expect(await dev.GET(request('/api/development?id='+logPlan.p.id)))).items.length);
 if(kind==='transfer'){
  act('manager');for(const api of [performance,changes,checkins])assert.ok(!(await expect(await api.GET())).records.some(r=>r.employeeId===f.e.id));
  await expect(await dev.GET(request('/api/development?id='+log.id)),403);
  await perf({action:'evaluate',id:submitted.p.id,scores:[80,80],evidence:'原组织管理者不得处理调出人员'},403);
  await grant('newHR','hr',null,[f.otherOrg.id]);act('newHR');assert.ok((await expect(await performance.GET())).records.some(r=>r.id===evaluated.p.id));
 }
 act('owner');await change({action:'review',id:pending.id,accepted:false,evidence:'人员变化，退回原周期待审调整'});
 for(const p of [draft,confirmed,logPlan,submitted,evaluated])await perf({action:'cancelPerformance',id:p.p.id,evidence:'人员变化，取消未发布计划保留历史'});
 for(const p of [draft,confirmed,logPlan,submitted,evaluated])await perf({action:'closeCycle',id:p.cy.id});
 assert.equal((await get()).records.find(r=>r.id===log.id).status,'submitted');
 if(kind==='exit'){
  const revision=(await expect(await members.GET())).revision;
  await expect(await members.POST(request('/api/members',{revision,email:'employee@example.com',name:'employee',role:'employee',employeeId:f.e.id,orgScope:[],viewEmail:false,viewLevel:false,active:false})));
  const saved=(await expect(await members.GET())).members.find(m=>m.email==='employee@example.com');assert.equal(saved.active,0);assert.equal(saved.employeeId,f.e.id);
  act('employee');for(const api of [performance,changes,checkins]){
   await expect(await api.GET(),403);await expect(await api.POST(request('/api/performance',{revision:revision+1,command:{action:'selfReview',id:logPlan.p.id,evidence:'停用账号不能继续提交任何业务'}})),403);
  }
  await expect(await dev.GET(request('/api/development?id='+logPlan.p.id)),403);
 }
});
