import './support/runtime.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {learningGrade}=await import('../lib/hris/learning-grades.ts');
test('plan grading distinguishes two averages, retains zero, and never borrows other-instance attempts or replaces missing scores',()=>{
 const assignment={id:'plan',employeeId:'e',status:'active',payload:{courseIds:[],examIds:['a','b'],gradeRule:{mode:'allAttemptsAverage',attempts:'all',decimals:2}}};
 const tasks=['a','b'].map(id=>({id:'task-'+id,kind:'learningExamTask',employeeId:'e',referenceId:id,payload:{learningAssignmentId:'plan',learningRequirementId:'exam:'+id}}));
 const attempt=(id,exam,score,passed)=>({id,kind:'learningExamAttempt',employeeId:'e',referenceId:'task-'+exam,payload:{examId:exam,score,passed}});
 const records=[...tasks,attempt('a1','a',0,false),attempt('a2','a',80,true),attempt('b1','b',60,false)];
 assert.equal(learningGrade(assignment,records).score,46.67);
 const rule=mode=>({...assignment,payload:{...assignment.payload,gradeRule:{...assignment.payload.gradeRule,mode}}});
 assert.equal(learningGrade(rule('eachExamHighestAverage'),records).score,70);
 assert.equal(learningGrade(rule('allHighest'),records).score,80);
 assert.equal(learningGrade({...assignment,payload:{...assignment.payload,gradeRule:{mode:'specifiedExamHighest',examId:'b',attempts:'all',decimals:0}}},records).score,60);
 assert.equal(learningGrade({...assignment,payload:{...assignment.payload,gradeRule:{mode:'allHighest',attempts:'passed',decimals:2}}},records).state,'pending');
 assert.equal(learningGrade(assignment,records.filter(r=>r.id!=='b1')).score,null);
 assert.equal(learningGrade(assignment,records.map(r=>r.id==='b1'?{...r,referenceId:'other-task'}:r)).score,null);
 assert.equal(learningGrade(assignment,records.map(r=>r.id==='b1'?{...r,employeeId:'other'}:r)).score,null);
 const single={...assignment,payload:{...assignment.payload,examIds:['a']}};assert.equal(learningGrade(single,[tasks[0],records[2]]).score,0);
 assert.equal(learningGrade({...assignment,status:'completed'},records).state,'final');assert.equal(learningGrade(assignment,records).state,'provisional');
 assert.equal(learningGrade({...assignment,payload:{...assignment.payload,gradeRule:{mode:'none'}}},records).state,'not_configured');
});

test('content weights use actual current evidence, distinguish exam aggregation and keep missing or foreign homework pending',()=>{
 const rule={mode:'contentWeighted',attempts:'all',decimals:2,items:[{requirementId:'exam:e',source:'examAverage',weight:40},{requirementId:'homework:h',source:'homeworkLatest',weight:60}]};
 const plan={id:'p',employeeId:'learner',status:'active',payload:{examIds:['e'],homeworkIds:['h'],gradeRule:rule}},at='2026-09-08T00:00:00Z';
 const exam={id:'et',kind:'learningExamTask',employeeId:'learner',referenceId:'e',payload:{learningAssignmentId:'p',learningRequirementId:'exam:e'}},work={id:'ht',kind:'homeworkTask',employeeId:'learner',referenceId:'h',status:'completed',payload:{learningAssignmentId:'p',learningRequirementId:'homework:h',submissionId:'hs',verifiedBy:'reviewer',verifiedAt:at}};
 const attempts=[20,80].map((score,i)=>({id:'a'+i,kind:'learningExamAttempt',employeeId:'learner',referenceId:'et',payload:{examId:'e',score,passed:i===1}})),submission={id:'hs',kind:'homeworkSubmission',referenceId:'ht',employeeId:'learner',status:'passed',payload:{score:100,passed:true,verifiedBy:'reviewer',verifiedAt:at}};
 const records=[exam,work,...attempts,submission],withRule=gradeRule=>({...plan,payload:{...plan.payload,gradeRule}});
 assert.equal(learningGrade(plan,records).score,80);
 assert.equal(learningGrade(withRule({...rule,items:[{...rule.items[0],source:'examHighest'},rule.items[1]]}),records).score,92);
 assert.equal(learningGrade(withRule({...rule,attempts:'passed'}),records).score,92);
 assert.deepEqual(learningGrade(plan,records).evidenceIds,['a0','a1','hs']);
 assert.equal(learningGrade(plan,records.map(r=>r.id==='hs'?{...r,payload:{...r.payload,score:0}}:r)).score,20);
 for(const changed of [{...submission,payload:{...submission.payload,score:undefined}},{...submission,referenceId:'other-task'},{...submission,employeeId:'other'},{...submission,payload:{...submission.payload,verifiedBy:'other'}}]){const result=learningGrade(plan,records.map(r=>r.id==='hs'?changed:r));assert.equal(result.score,null);assert.deepEqual(result.missingRequirementIds,['homework:h']);}
 assert.equal(learningGrade(plan,records.map(r=>r.id==='ht'?{...r,payload:{...r.payload,submissionId:'new-pending'}}:r)).score,null);
 assert.equal(learningGrade(withRule({...rule,items:[{...rule.items[0],weight:39},rule.items[1]]}),records).score,null);
 assert.equal(learningGrade({...plan,status:'completed'},records).state,'final');
});
