import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,get,act,expect,request} from './support/foundation-scenario.mjs';
const api=await import('../app/api/learning-exams/route.ts'),generic=await import('../app/api/development/route.ts');
async function cmd(command,status=200,revision){const d=await expect(await api.GET());return expect(await api.POST(request('/api/learning-exams',{revision:revision??d.revision,command})),status);}
test('standalone exam definitions isolate organizations and answers, preserve sealed versions, reject stale edits and never create course exams',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());const create={action:'create',title:'合成独立试卷',orgId:f.org.id,questions:[{prompt:'合成案例的正确处理方式是什么',options:['独立核验','自行核验'],correct:0}],passingScore:80,maxAttempts:2};
 act('hr');await cmd({...create,orgId:f.otherOrg.id},403);await cmd({...create,questions:[{...create.questions[0],correct:2}]},400);await cmd({...create,questions:[{...create.questions[0],options:['重复','重复']}]},400);
 const first=await cmd(create),stale=(await expect(await api.GET())).revision;await cmd({action:'seal',id:first.id});
 await cmd({...create,action:'edit',id:first.id},400);await cmd({action:'revise',id:first.id},409,stale);
 const next=await cmd({action:'revise',id:first.id});await cmd({action:'revise',id:first.id},400);await cmd({...create,action:'edit',id:next.id,passingScore:60});await cmd({action:'seal',id:next.id});await cmd({action:'revise',id:first.id},400);
 const records=(await expect(await api.GET())).records;assert.equal(records.find(r=>r.id===first.id).payload.passingScore,80);assert.equal(records.find(r=>r.id===next.id).payload.passingScore,60);assert.equal(records.find(r=>r.id===next.id).payload.version,2);assert.ok(!(await get()).records.some(r=>['exam','attempt','learningAssignment'].includes(r.kind)));
 for(const role of ['employee','manager']){act(role);await expect(await api.GET(),403);assert.ok(!(await get()).records.some(r=>r.kind==='learningExamDefinition'));await expect(await generic.GET(request('/api/development?id='+first.id)),403);}
 act('owner');const other=await cmd({...create,orgId:f.otherOrg.id});act('hr');assert.ok(!(await expect(await api.GET())).records.some(r=>r.id===other.id));await cmd({action:'archive',id:other.id},403);
});
