import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,get,act,expect,request} from './support/foundation-scenario.mjs';
const reports=await import('../app/api/reports/route.ts');
const exams=await import('../app/api/learning-exams/route.ts'),tasks=await import('../app/api/learning-exam-tasks/route.ts');
const {objectiveQuestionSchema,scoreObjectiveExam}=await import('../lib/hris/learning-objective-exams.ts');
const {businessDate}=await import('../lib/hris/business-time.ts');
async function cmd(api,command,status=200){const d=await expect(await api.GET());return expect(await api.POST(request('/api/test',{revision:d.revision,command})),status);}
const questions=[{type:'single',prompt:'合成单选应选择哪一项',options:['正确做法','错误做法'],correct:[0],points:2},{type:'multiple',prompt:'选择全部符合条件的做法',options:['第一项','错误项','第三项'],correct:[0,2],points:4,partialPoints:1},{type:'trueFalse',prompt:'独立核验应与本人提交分离',options:['正确','错误'],correct:[0],points:1}];
test('objective scoring validates shapes and keeps weighted, partial and wrong-selection results distinct',()=>{
 const exam={payload:{objectiveQuestions:questions}};
 assert.deepEqual(scoreObjectiveExam(exam,[[0],[0],[0]]),{answers:[[0],[0],[0]],earnedPoints:4,maxPoints:7,score:57});
 assert.equal(scoreObjectiveExam(exam,[[0],[2,0],[0]]).score,100);
 assert.equal(scoreObjectiveExam(exam,[[0],[0,1],[0]]).earnedPoints,3);
 for(const answers of [[[0],[],[0]],[[0],[0,0],[0]],[[0,1],[0,2],[0]],[[0],[3],[0]],[[0],[0,2]]])assert.throws(()=>scoreObjectiveExam(exam,answers));
 for(const q of [{...questions[1],partialPoints:4},{...questions[0],correct:[0,1]},{...questions[1],correct:[0]},{...questions[2],options:['是','否']}])assert.equal(objectiveQuestionSchema.safeParse(q).success,false);
 assert.equal(scoreObjectiveExam({payload:{questions:[{prompt:'旧单选',options:['一','二'],correct:1}]}},[1]).score,100);
});
test('mixed objective versions protect answers, retain attempts and reject legacy overwrite or malformed submissions',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const create={action:'create',title:'合成多题型试卷',orgId:f.org.id,objectiveQuestions:questions,passingScore:60,maxAttempts:2};
 await cmd(exams,{...create,questions:[{prompt:'不应双重提供题目结构',options:['一','二'],correct:0}]},400);
 const exam=await cmd(exams,create);await cmd(exams,{action:'edit',id:exam.id,title:create.title,orgId:f.org.id,questions:[{prompt:'旧客户端不能降级覆盖',options:['一','二'],correct:0}],passingScore:60,maxAttempts:2},400);await cmd(exams,{action:'seal',id:exam.id});
 const assigned=await cmd(tasks,{action:'assign',examId:exam.id,employeeId:f.e.id,start:businessDate(),due:'2099-12-31'});const taskId=assigned.ids[0];
 act('employee');const visible=await expect(await tasks.GET());assert.equal(visible.papers[0].payload.objectiveQuestions.length,3);assert.ok(visible.papers[0].payload.objectiveQuestions.every(q=>!Object.hasOwn(q,'correct')));assert.ok(!visible.records.some(r=>r.kind==='learningExamDefinition'));
 await cmd(tasks,{action:'submit',id:taskId,answers:[[0],[0,0],[0]]},400);assert.equal((await expect(await tasks.GET())).records.filter(r=>r.kind==='learningExamAttempt').length,0);
 await cmd(tasks,{action:'submit',id:taskId,answers:[[0],[0],[0]]});let rows=(await expect(await tasks.GET())).records;const first=rows.find(r=>r.kind==='learningExamAttempt');assert.equal(first.payload.score,57);assert.equal(first.payload.earnedPoints,4);assert.equal(first.payload.maxPoints,7);assert.equal(first.payload.passed,false);assert.deepEqual(first.payload.objectiveAnswers,[[0],[0],[0]]);
 await cmd(tasks,{action:'submit',id:taskId,answers:[[0],[2,0],[0]]});await cmd(tasks,{action:'submit',id:taskId,answers:[[0],[2,0],[0]]},400);assert.equal((await expect(await tasks.GET())).records.find(r=>r.id===taskId).status,'completed');
 act('hr');const report=await expect(await reports.GET(request('/api/reports?dataset=learningExams')));assert.equal(report.rows[0][report.columns.indexOf('原始得分')],7);assert.equal(report.rows[0][report.columns.indexOf('原始总分')],7);const next=await cmd(exams,{action:'revise',id:exam.id});await cmd(exams,{...create,action:'edit',id:next.id,objectiveQuestions:[{...questions[0],points:10}]});rows=(await get()).records;assert.deepEqual(rows.find(r=>r.id===exam.id).payload.objectiveQuestions,questions);assert.deepEqual(rows.find(r=>r.id===first.id).payload.objectiveAnswers,[[0],[0],[0]]);
});
test('rounded display cannot turn a weighted near-pass into a passing attempt',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const objectiveQuestions=Array.from({length:20},(_,i)=>({...questions[0],points:i===19?1:100}));
 const exam=await cmd(exams,{action:'create',title:'百分制显示舍入边界',orgId:f.org.id,objectiveQuestions,passingScore:100,maxAttempts:1});await cmd(exams,{action:'seal',id:exam.id});const assigned=await cmd(tasks,{action:'assign',examId:exam.id,employeeId:f.e.id,start:businessDate(),due:'2099-12-31'});act('employee');await cmd(tasks,{action:'submit',id:assigned.ids[0],answers:Array.from({length:20},(_,i)=>[i===19?1:0])});
 const attempt=(await expect(await tasks.GET())).records.find(r=>r.kind==='learningExamAttempt');assert.equal(attempt.payload.score,100);assert.equal(attempt.payload.earnedPoints,1900);assert.equal(attempt.payload.maxPoints,1901);assert.equal(attempt.payload.passed,false);
});
