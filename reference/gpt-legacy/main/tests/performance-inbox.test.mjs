import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,expect,request} from './support/foundation-scenario.mjs';
import {perf,change,planFor,revisedGoals,moveEmployee} from './support/performance-scenario.mjs';
const inbox=await import('../app/api/work-inbox/route.ts');
const selfService=await import('../app/api/self-service/route.ts');
const tasks=async()=> (await expect(await inbox.GET(request('/api/work-inbox?domain=performance')))).items;
test('performance inbox follows self-review, pending adjustment, return and lifecycle without exposing another employee task',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const {p}=await planFor(f);
 act('employee');let own=(await tasks()).filter(x=>x.recordId===p.id);assert.equal(own.length,1);assert.equal(own[0].action,'绩效自评');assert.equal(new URL(own[0].href,'https://synthetic.example').searchParams.get('recordId'),p.id);
 const self=(await expect(await selfService.GET())).tasks.find(x=>x.id===p.id);assert.equal(self.href,own[0].href);
 const revision=await change({action:'request',planId:p.id,goals:revisedGoals,evidence:'合成目标修改待审期间暂缓自评'});assert.ok(!(await tasks()).some(x=>x.recordId===p.id));
 act('manager');assert.ok(!(await tasks()).some(x=>x.recordId===p.id&&x.action==='绩效自评'));await change({action:'review',id:revision.id,accepted:false,evidence:'合成调整未获通过保留原目标'});
 act('employee');assert.ok((await tasks()).some(x=>x.recordId===p.id));await perf({action:'selfReview',id:p.id,evidence:'合成自评交付供管理者核实'});assert.ok(!(await tasks()).some(x=>x.recordId===p.id));
 act('manager');const review=(await tasks()).find(x=>x.recordId===p.id);assert.equal(review.action,'绩效评价');assert.equal(new URL(review.href,'https://synthetic.example').searchParams.get('recordId'),p.id);await perf({action:'returnPerformance',id:p.id,evidence:'退回合成自评补充事实依据'});
 act('employee');assert.ok((await tasks()).some(x=>x.recordId===p.id&&x.action==='绩效自评'));
 await moveEmployee(f,'transfer');act('employee');assert.ok(!(await tasks()).some(x=>x.recordId===p.id));act('owner');assert.ok(!(await tasks()).some(x=>x.recordId===p.id));
});
