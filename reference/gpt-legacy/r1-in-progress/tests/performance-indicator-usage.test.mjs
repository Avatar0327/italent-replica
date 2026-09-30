import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,get,expect,request} from './support/foundation-scenario.mjs';
import {perf,cycleInput,goals,change,moveEmployee} from './support/performance-scenario.mjs';
const api=await import('../app/api/performance-indicators/route.ts');
const indicator=async(command,status=200)=>expect(await api.POST(request('/api/performance-indicators',{revision:(await get()).revision,command})),status);
async function readUsage(id,status=200,page='1'){return expect(await api.GET(request('/api/performance-indicators?'+new URLSearchParams({usageId:id,page}))),status);}
test('indicator usage separates versions and pending references, retains frozen published sources and respects current HR scope',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const d=await indicator({action:'create',orgId:f.org.id,indicator:{type:'qualitative',code:'USAGE',title:'合成引用指标',category:'合成分类',description:'引用情况原站列对应的独立追溯实现',metric:'按照合成证据核对质量'}});await indicator({action:'seal',id:d.id});
 const cy=await perf(cycleInput(f.org.id,'USAGE-ONE'));await perf({action:'startCycle',id:cy.id});act('employee');const p=await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals:goals.map(g=>({...g,indicatorId:d.id}))});
 act('manager');await perf({action:'confirmGoals',id:p.id});act('employee');await perf({action:'selfReview',id:p.id,evidence:'合成引用完整成果记录'});act('manager');await perf({action:'evaluate',id:p.id,scores:[70,80],evidence:'独立核验合成引用来源'});act('owner');await perf({action:'publishPerformance',id:p.id,evidence:'按冻结指标发布合成结果'});
 const newer=await indicator({action:'revise',id:d.id});await indicator({action:'seal',id:newer.id});const cy2=await perf(cycleInput(f.org.id,'USAGE-TWO'));await perf({action:'startCycle',id:cy2.id});act('employee');const p2=await perf({action:'goals',employeeId:f.e.id,cycleId:cy2.id,goals:goals.map(g=>({...g,indicatorId:d.id}))});act('manager');await perf({action:'confirmGoals',id:p2.id});act('employee');await change({action:'request',planId:p2.id,goals:goals.map(g=>({...g,indicatorId:newer.id})),evidence:'显式切换合成新版来源'});
 await readUsage(d.id,403);act('manager');await readUsage(d.id,403);act('owner');await indicator({action:'archive',id:d.id,reason:'归档原版本保留已有来源'});act('hr');let u=await readUsage(d.id);assert.deepEqual(u.counts,{plans:2,pendingChanges:0,publishedResults:1});assert.equal(u.total,3);assert.ok(u.items.every(r=>r.occurrences===2));assert.ok(!JSON.stringify(u).includes('scores'));assert.deepEqual((await readUsage(newer.id)).counts,{plans:0,pendingChanges:1,publishedResults:0});await readUsage(d.id,400,'0');assert.equal((await readUsage(d.id,200,'2')).items.length,0);
 await moveEmployee(f,'transfer');act('hr');u=await readUsage(d.id);assert.equal(u.total,0);assert.deepEqual(u.counts,{plans:0,pendingChanges:0,publishedResults:0});
 act('owner');assert.equal((await readUsage(d.id)).total,3);
});
