import './support/runtime.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {courseRequirements,learningRequirementProgress,learningAssignmentCurrent,learningStageOpen,learningStageStartsOn}=await import('../lib/hris/learning-requirements.ts');
test('requirement completion rejects borrowed identities, duplicates and missing evidence while preserving legacy assignments',()=>{
 const assignment={id:'plan',employeeId:'learner',payload:{courseIds:['course']}};
 const task={id:'task',kind:'enrollment',employeeId:'learner',referenceId:'course',status:'completed',payload:{learningAssignmentId:'plan',verifiedBy:'reviewer',verifiedAt:'2026-09-08T00:00:00Z'}};
 assert.equal(learningRequirementProgress(assignment,[task]).complete,true);
 for(const tasks of [[],[task,{...task,id:'duplicate'}],[{...task,employeeId:'other'}],[{...task,payload:{...task.payload,verifiedAt:undefined}}],[{...task,payload:{...task.payload,learningRequirementId:'wrong'}}],[{...task,status:'cancelled'}]])assert.equal(learningRequirementProgress(assignment,tasks).complete,false);
 const snapshot={...assignment,payload:{...assignment.payload,learningRequirements:courseRequirements(['course'])}};
 assert.equal(learningRequirementProgress(snapshot,[task]).complete,true);
 assert.equal(learningRequirementProgress({...snapshot,payload:{...snapshot.payload,learningRequirements:[]}},[task]).complete,false);
 assert.equal(learningRequirementProgress({...snapshot,payload:{...snapshot.payload,learningRequirements:[{id:'exam',kind:'exam',resourceId:'course'}]}},[task]).complete,false);
 assert.deepEqual(courseRequirements(['new','course'],[{id:'stable',kind:'course',resourceId:'course'}]),[{id:'course:new',kind:'course',resourceId:'new'},{id:'stable',kind:'course',resourceId:'course'}]);
});

test('assignment progression retains history but stops for exit, transfer or disabled organization',()=>{
 const assignment={employeeId:'learner',payload:{orgId:'org'}};
 const state={employees:[{id:'learner',orgId:'org',status:'正式'}],orgs:[{id:'org',status:'启用'}]};
 assert.equal(learningAssignmentCurrent(assignment,state),true);
 for(const employee of [null,{id:'learner',orgId:'org',status:'离职'},{id:'learner',orgId:'other',status:'正式'}])assert.equal(learningAssignmentCurrent(assignment,{...state,employees:employee?[employee]:[]}),false);
 assert.equal(learningAssignmentCurrent(assignment,{...state,orgs:[{id:'org',status:'停用'}]}),false);
});

test('stage opening uses joined business date and fixed plan start without bypassing prerequisites',()=>{
 const assignment={id:'a',kind:'learningAssignment',status:'active',employeeId:'e',createdAt:'2026-09-08T16:30:00Z',payload:{start:'2026-09-09',courseIds:['c'],learningMode:{orderedStages:false},trainingStages:[{title:'延迟阶段',courseIds:['c'],startAfterDays:2}]}};
 const task={id:'t',kind:'enrollment',referenceId:'c',employeeId:'e',payload:{learningAssignmentId:'a'}};
 assert.equal(learningStageStartsOn(assignment,assignment.payload.trainingStages[0]),'2026-09-11');
 assert.equal(learningStageOpen(task,[assignment,task],'2026-09-10T15:59:59Z'),false);
 assert.equal(learningStageOpen(task,[assignment,task],'2026-09-10T16:00:00Z'),true);
 assert.equal(learningStageStartsOn({...assignment,payload:{...assignment.payload,start:'2026-09-20'}},assignment.payload.trainingStages[0]),'2026-09-20');
 assert.equal(learningStageOpen(task,[{...assignment,status:'completed'},task],'2026-09-21T00:00:00Z'),false);
});

test('fixed stages retain plan origin for early and late assignees at China business-day boundary',()=>{
 const stage={title:'固定阶段',courseIds:['c'],startAfterDays:2};
 const plan={id:'fixed',kind:'learningAssignment',status:'active',employeeId:'e',createdAt:'2026-09-14T16:30:00Z',payload:{start:'2026-09-10',courseIds:['c'],learningMode:{mode:'fixed',start:'2026-09-10',end:'2026-09-30',orderedStages:false},trainingStages:[stage]}};
 const task={id:'t',kind:'enrollment',referenceId:'c',employeeId:'e',payload:{learningAssignmentId:'fixed'}};
 assert.equal(learningStageStartsOn(plan,stage),'2026-09-12');
 assert.equal(learningStageStartsOn({...plan,createdAt:'2026-09-01T00:00:00Z'},stage),'2026-09-12');
 assert.equal(learningStageOpen(task,[plan,task],'2026-09-11T15:59:59Z'),false);
 assert.equal(learningStageOpen(task,[plan,task],'2026-09-11T16:00:00Z'),true);
 assert.equal(learningStageStartsOn({...plan,payload:{...plan.payload,learningMode:{mode:'relative',orderedStages:false}}},stage),'2026-09-17');
});

test('explicit future recurrence starts stage delays at the round start, not dispatch time',()=>{
 const stage={title:'下一轮第二天',courseIds:['c'],startAfterDays:2};
 const instance={createdAt:'2026-09-08T00:00:00Z',payload:{start:'2026-10-01',previousAssignmentId:'previous',learningMode:{mode:'recurring'},trainingStages:[stage]}};
 assert.equal(learningStageStartsOn(instance,stage),'2026-10-03');
});
