import {test} from 'node:test';
import assert from 'node:assert/strict';
import './support/runtime.mjs';
const {learningModeSchema,learningWindow,learningAssignmentKey,learningTaskCurrent,learningTaskOpen}=await import('../lib/hris/learning-plan-model.ts');
const base={progressSync:false,orderedStages:true};
test('learning instance contract rejects mixed modes, invalid dates and missing reward decisions',()=>{
 const fixed={...base,mode:'fixed',start:'2028-02-29',end:'2028-03-01'};
 assert.equal(learningModeSchema.safeParse(fixed).success,true);
 for(const c of [{...fixed,start:'2027-02-29'},{...fixed,end:'2028-02-28'},{...fixed,durationDays:3},{...base,mode:'relative',durationDays:0,allowOverdue:true},{...base,mode:'recurring',durationDays:3,allowOverdue:false}])assert.equal(learningModeSchema.safeParse(c).success,false);
 const recurring={...base,mode:'recurring',durationDays:3,allowOverdue:false,repeatCredit:false,repeatPoints:true};
 assert.deepEqual(learningModeSchema.parse(recurring),recurring);
});
test('learning windows preserve fixed dates and inclusive leap/year boundaries; round keys do not collide',()=>{
 const relative={...base,mode:'relative',durationDays:2,allowOverdue:true};
 assert.deepEqual(learningWindow(relative,'2028-02-28'),{start:'2028-02-28',due:'2028-02-29',allowOverdue:true});
 assert.equal(learningWindow(relative,'2028-12-31').due,'2029-01-01');
 assert.equal(learningWindow({...relative,durationDays:1},'2028-12-31').due,'2028-12-31');
 assert.deepEqual(learningWindow({...base,mode:'fixed',start:'2028-01-01',end:'2028-03-01'},'2028-02-01'),{start:'2028-01-01',due:'2028-03-01',allowOverdue:false});
 assert.throws(()=>learningWindow(relative,'9999-12-31'));
 assert.equal(learningAssignmentKey('p','e',1),learningAssignmentKey('p','e',1));
 assert.notEqual(learningAssignmentKey('p','e',1),learningAssignmentKey('p','e',2));
 assert.notEqual(learningAssignmentKey('p:e','x',1),learningAssignmentKey('p','e:x',1));
 assert.throws(()=>learningAssignmentKey('p','e',0));
});

test('instance availability keeps historical records while rejecting transferred, former and out-of-window learners',()=>{
 const r={payload:{learningAssignmentId:'a',assignmentOrgId:'o',assignmentStart:'2026-09-08',assignmentDue:'2026-09-09',assignmentAllowOverdue:false}},employee={orgId:'o',status:'正式'};
 assert.equal(learningTaskOpen(r,employee,'2026-09-08T00:00:00Z'),true);
 assert.equal(learningTaskOpen(r,employee,'2026-09-10T00:00:00Z'),false);
 assert.equal(learningTaskCurrent(r,{...employee,orgId:'other'}),false);
 assert.equal(learningTaskCurrent(r,{...employee,status:'离职'}),false);
 assert.equal(learningTaskOpen({...r,payload:{...r.payload,assignmentAllowOverdue:true}},employee,'2026-09-10T00:00:00Z'),true);
});
