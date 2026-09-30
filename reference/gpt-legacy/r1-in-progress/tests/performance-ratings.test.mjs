import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,grant,get,act,expect,request} from './support/foundation-scenario.mjs';
import {perf,performance,cycleInput,goals,post} from './support/performance-scenario.mjs';
const api=await import('../app/api/performance-ratings/route.ts');
const {ratingLevelsSchema,performanceRatingAt}=await import('../lib/hris/performance-ratings.ts');
const levels=[{label:'卓越',min:4,max:5,minInclusive:true,maxInclusive:true,description:'',talentBand:3},{label:'良好',min:3,max:4,minInclusive:true,maxInclusive:false,description:'',talentBand:3},{label:'合格',min:2,max:3,minInclusive:true,maxInclusive:false,description:'',talentBand:2},{label:'待提升',min:-1,max:2,minInclusive:true,maxInclusive:false,description:'',talentBand:1}];
const cmd=(c,s=200,r)=>post(api,'/api/performance-ratings',c,s,r);
async function definition(f){const d=await cmd({action:'create',title:'合成五分评级',orgId:f.org.id,levels});await cmd({action:'seal',id:d.id});return d;}
async function evaluated(f,d,period='SCHEME'){act('owner');const cy=await perf({...cycleInput(f.org.id,period),ratingDefinitionId:d.id});await perf({action:'startCycle',id:cy.id});act('employee');const p=await perf({action:'goals',cycleId:cy.id,employeeId:f.e.id,goals});act('manager');await perf({action:'confirmGoals',id:p.id});act('employee');await perf({action:'selfReview',id:p.id,evidence:'提交合成非百分制目标成果'});act('manager');return {cy,p};}
test('grade intervals reject overlap, duplicate names and ambiguous ordering; exact brackets and uncovered gaps remain explicit',()=>{
 assert.equal(ratingLevelsSchema.safeParse(levels).success,true);
 for(const bad of [levels.map((l,i)=>i===1?{...l,maxInclusive:true}:l),levels.map((l,i)=>i===1?{...l,label:'卓越'}:l),[...levels].reverse()])assert.equal(ratingLevelsSchema.safeParse(bad).success,false);
 const payload={ratingScheme:{id:'d',rootId:'d',version:1,title:'测试',levels}};
 assert.deepEqual(performanceRatingAt(payload,4),{label:'卓越',band:3});assert.deepEqual(performanceRatingAt(payload,3),{label:'良好',band:3});assert.deepEqual(performanceRatingAt(payload,-1),{label:'待提升',band:1});assert.throws(()=>performanceRatingAt(payload,5.01),/未唯一匹配/);
 const gap={ratingScheme:{...payload.ratingScheme,levels:levels.map((l,i)=>i===1?{...l,max:3.9}:l)}};assert.throws(()=>performanceRatingAt(gap,3.95),/未唯一匹配/);
});
test('versioned ratings enforce scope and immutable drafts, CAS, snapshot publication and independent appeal after scheme revision',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const d=await definition(f);
 await cmd({action:'edit',id:d.id,title:'不能覆盖',orgId:f.org.id,levels},400);
 act('manager');await expect(await api.GET(),403);await cmd({action:'revise',id:d.id},403);
 act('hr');await cmd({action:'create',title:'跨组织',orgId:f.otherOrg.id,levels},403);
 act('employee');assert.ok(!(await expect(await performance.GET())).records.some(r=>r.kind==='performanceRatingDefinition'));
 act('owner');await perf({...cycleInput(f.otherOrg.id),ratingDefinitionId:d.id},400);
 const {cy,p}=await evaluated(f,d);await perf({action:'evaluate',id:p.id,scores:[100,4],evidence:'不得把百分制评分写入五分制'},400);await perf({action:'evaluate',id:p.id,scores:[4,4],evidence:'按合成五分制独立评价'});
 act('owner');const revision=(await get()).revision,next=await cmd({action:'revise',id:d.id});await cmd({action:'revise',id:d.id},400);await cmd({action:'edit',id:next.id,title:'旧修订拒绝',orgId:f.org.id,levels},409,revision);
 const changed=levels.map(l=>({...l,label:l.label+'新版',talentBand:1}));await cmd({action:'edit',id:next.id,title:'五分制第二版',orgId:f.org.id,levels:changed});await cmd({action:'seal',id:next.id});await cmd({action:'archive',id:d.id});
 const result=await perf({action:'publishPerformance',id:p.id,evidence:'核对第一版冻结评分规则并发布'});await perf({action:'publishPerformance',id:p.id,evidence:'重复请求不能创建第二个结果'},400);
 let rows=(await expect(await performance.GET())).records,r=rows.find(r=>r.id===result.id);assert.equal(r.payload.originalRating,'卓越');assert.equal(r.payload.band,3);assert.equal(r.payload.performanceSnapshot.cycle.ratingScheme.version,1);assert.equal(rows.find(r=>r.id===cy.id).payload.ratingScheme.levels[0].label,'卓越');
 await grant('independentHr','hr',null,[f.org.id]);act('employee');const appeal=await perf({action:'appeal',resultId:result.id,evidence:'原始评分需按成果证据更正'});act('independentHr');await perf({action:'reviewAppeal',id:appeal.id,accepted:true,scores:[3,3],evidence:'按原版标准独立复核合成证据'});await perf({action:'publishCorrection',id:appeal.id,evidence:'复核人不得自发更正结果'},403);
 act('owner');const correction=await perf({action:'publishCorrection',id:appeal.id,evidence:'独立检查合成复核意见并发布'});rows=(await expect(await performance.GET())).records;r=rows.find(r=>r.id===correction.id);assert.equal(r.payload.originalRating,'良好');assert.equal(r.payload.band,3);assert.equal(r.payload.performanceSnapshot.cycle.ratingScheme.version,1);assert.equal(rows.find(r=>r.id===result.id).payload.originalRating,'卓越');
});
test('legacy scores remain 0–100 and gaps cannot silently publish even when individual scores fit the scale',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const {planFor}=await import('./support/performance-scenario.mjs');const legacy=await planFor(f,'submitted','LEGACY');act('manager');await perf({action:'evaluate',id:legacy.p.id,scores:[-1,3],evidence:'旧版百分制仍拒绝负分'},400);
 act('owner');const gapped=levels.map((l,i)=>i===1?{...l,max:3.9}:l),d=await cmd({action:'create',title:'有空隙等级',orgId:f.org.id,levels:gapped});await cmd({action:'seal',id:d.id});const {p}=await evaluated(f,d,'GAP');await perf({action:'evaluate',id:p.id,scores:[3.95,3.95],evidence:'评分落入人为配置的未覆盖区间'});act('owner');const before=(await get()).revision;await perf({action:'publishPerformance',id:p.id,evidence:'未匹配总分不得自动划档'},400);assert.equal((await get()).revision,before);
});
