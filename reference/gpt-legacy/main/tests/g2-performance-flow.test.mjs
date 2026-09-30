import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,get,expect,dev,request,send,grant} from './support/foundation-scenario.mjs';
import {perf,change,checkin,performance,planFor,goals,revisedGoals,cycleInput,moveEmployee} from './support/performance-scenario.mjs';
const reports=await import('../app/api/reports/route.ts');
const profiles=await import('../app/api/cadre-profiles/route.ts');
const evidence='合成核对材料充分，按照明确的目标与事实办理';

test('H004 P02: one employee goal adjustment, checkin, evaluation, appeal and versioned consumers',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const {p,cy}=await planFor(f);
 act('employee');const adjustment=await change({action:'request',planId:p.id,goals:revisedGoals,evidence});
 await perf({action:'selfReview',id:p.id,evidence},400);
 // A manager linked to the subject must still be unable to self-approve.
 await grant('employee','manager',f.e.id,[f.org.id],true);act('employee');
 await change({action:'review',id:adjustment.id,accepted:true,evidence},403);
 await grant('employee','employee',f.e.id,[],true);act('manager');
 const before=await get();
 f.sqlite.exec("CREATE TRIGGER h004_reject_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'H004 audit unavailable'); END");
 await change({action:'review',id:adjustment.id,accepted:true,evidence},503);
 assert.equal((await get()).revision,before.revision);
 assert.deepEqual((await get()).records.find(r=>r.id===p.id).payload.goals,goals);
 assert.equal((await get()).records.find(r=>r.id===adjustment.id).status,'submitted');
 f.sqlite.exec('DROP TRIGGER h004_reject_audit');
 const approved=await change({action:'review',id:adjustment.id,accepted:true,evidence});assert.equal(approved.revision,before.revision+1);
 const fresh=(await get()).records.find(r=>r.id===p.id);assert.equal(fresh.payload.version,2);assert.deepEqual(fresh.payload.goals,revisedGoals);
 await change({action:'review',id:adjustment.id,accepted:true,evidence},400);
 act('employee');const log=await checkin({action:'submit',planId:p.id,goalIndex:0,progress:100,evidence,actionPlan:evidence});
 act('manager');await checkin({action:'feedback',id:log.id,accepted:true,evidence});
 act('employee');await perf({action:'selfReview',id:p.id,evidence});
 await grant('employee','manager',f.e.id,[f.org.id],true);act('employee');await perf({action:'evaluate',id:p.id,scores:[100,100],evidence},403);
 await grant('employee','employee',f.e.id,[],true);act('manager');
 const stale=(await get()).revision;await perf({action:'evaluate',id:p.id,scores:[60,70],evidence});
 act('employee');const privatePlan=(await expect(await performance.GET())).records.find(r=>r.id===p.id);assert.equal(privatePlan.payload.score,undefined);
 const ownHistory=await expect(await dev.GET(request('/api/development?id='+p.id)));assert.ok(ownHistory.items.every(h=>h.snapshot.payload.score===undefined));
 act('owner');await perf({action:'publishPerformance',id:p.id,evidence},409,stale);
 const result=await perf({action:'publishPerformance',id:p.id,evidence});await perf({action:'publishPerformance',id:p.id,evidence},400);
 const original=structuredClone((await get()).records.find(r=>r.id===result.id));assert.equal(original.payload.score,63);assert.equal(original.payload.performanceSnapshot.plan.version,2);
 const review=await send({action:'review',employeeId:f.e.id,period:'H004-SYNTHETIC',performanceId:result.id,potential:2,evidence});await send({action:'publishReview',id:review.id});
 await perf({action:'closeCycle',id:cy.id});
 act('employee');const appeal=await perf({action:'appeal',resultId:result.id,evidence});
 act('owner');await perf({action:'reviewAppeal',id:appeal.id,accepted:true,scores:[90,80],evidence},403);
 act('hr');await perf({action:'reviewAppeal',id:appeal.id,accepted:true,scores:[90,80],evidence});await perf({action:'publishCorrection',id:appeal.id,evidence},403);
 act('owner');const correction=await perf({action:'publishCorrection',id:appeal.id,evidence});await perf({action:'publishCorrection',id:appeal.id,evidence},400);
 const final=(await get()).records;assert.deepEqual(final.find(r=>r.id===result.id),original);
 assert.equal(final.find(r=>r.id===correction.id).payload.score,87);assert.equal(final.find(r=>r.id===correction.id).payload.supersedes,result.id);
 assert.equal(final.find(r=>r.id===review.id).payload.performanceSnapshot.score,63);assert.equal(final.find(r=>r.id===p.id).payload.score,63);
 await send({action:'review',id:review.id,employeeId:f.e.id,period:'H004-SYNTHETIC',performanceId:result.id,potential:2,evidence},400);
 const report=await expect(await reports.GET(request('/api/reports?dataset=performance')));assert.equal(report.total,1);assert.ok(JSON.stringify(report.rows).includes('87'));
 const profile=await expect(await profiles.GET(request('/api/cadre-profiles?employeeId='+f.e.id)));
 assert.deepEqual(profile.sections.find(s=>s.key==='performance').items.map(r=>r.id),[correction.id]);
 act('employee');await perf({action:'appeal',resultId:result.id,evidence},400);
 const history=await expect(await dev.GET(request('/api/development?id='+p.id)));assert.ok(history.items.some(h=>h.snapshot.payload.goals[0].weight===60));assert.ok(history.items.some(h=>h.snapshot.payload.goals[0].weight===70));
 t.diagnostic('H004_CHAIN '+JSON.stringify({employeeId:f.e.id,cycleId:cy.id,planId:p.id,adjustmentId:adjustment.id,checkinId:log.id,resultId:result.id,appealId:appeal.id,correctionId:correction.id,reviewId:review.id,originalScore:63,latestScore:87}));
});

test('H004 P03: cycle status, dates, exact weights and score thresholds',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const input=cycleInput(f.org.id);
 for(const values of [{start:'2026-02-30'},{end:'2025-12-31'},{lowCut:80},{highLabel:'达成'}])await perf({...input,...values},400);
 // Equal dates are valid. Dates label the period; start/close actions control its lifecycle.
 const cy=await perf({...input,start:'2026-01-01',end:'2026-01-01'});
 await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals},400);await perf({action:'closeCycle',id:cy.id},400);
 await perf({action:'startCycle',id:cy.id});await perf({action:'startCycle',id:cy.id},400);
 for(const weight of [39,41])await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals:[goals[0],{...goals[1],weight}]},400);
 await perf({action:'goals',employeeId:f.other.id,cycleId:cy.id,goals},400);
 const p=await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals});await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals},400);
 await perf({action:'closeCycle',id:cy.id},400);await perf({action:'confirmGoals',id:p.id});
 act('employee');await change({action:'request',planId:p.id,goals:[{...goals[0],weight:59},goals[1]],evidence},400);
 await perf({action:'selfReview',id:p.id,evidence});act('manager');await perf({action:'evaluate',id:p.id,scores:[80],evidence},400);
 await perf({action:'evaluate',id:p.id,scores:[80,80],evidence});act('owner');const high=await perf({action:'publishPerformance',id:p.id,evidence});assert.equal((await get()).records.find(r=>r.id===high.id).payload.band,3);
 await perf({action:'closeCycle',id:cy.id});await perf({action:'startCycle',id:cy.id},400);await perf({action:'goals',employeeId:f.e.id,cycleId:cy.id,goals},400);
 const next=await planFor(f,'submitted','H004-LOW-CUT');act('manager');await perf({action:'evaluate',id:next.p.id,scores:[60,60],evidence});act('owner');const low=await perf({action:'publishPerformance',id:next.p.id,evidence});assert.equal((await get()).records.find(r=>r.id===low.id).payload.band,2);
});

for(const kind of ['exit','transfer'])test(`H004 P03: ${kind} preserves independent correction of published history`,async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const {p,result}=await planFor(f,'published');
 await moveEmployee(f,kind);await grant('historyHR','hr',null,[kind==='transfer'?f.otherOrg.id:f.org.id]);
 act('employee');const appeal=await perf({action:'appeal',resultId:result.id,evidence});
 act('historyHR');await perf({action:'reviewAppeal',id:appeal.id,accepted:true,scores:[90,80],evidence});act('owner');const corrected=await perf({action:'publishCorrection',id:appeal.id,evidence});
 assert.equal((await get()).records.find(r=>r.id===result.id).payload.score,64);assert.equal((await get()).records.find(r=>r.id===corrected.id).payload.score,86);
 assert.equal((await get()).records.find(r=>r.id===p.id).status,'evaluated');
});
