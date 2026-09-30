import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,act,expect,request} from './support/foundation-scenario.mjs';
const api=await import('../app/api/learning-plans/route.ts');
test('Learning definitions retain immutable versions, reject stale writes and scope leaks',async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());
 const course=await send({action:'course',code:'LP1',title:'合成计划课程',description:'仅用于计划配置验证',content:'阅读案例并完成实践，提交完整成果材料，由独立管理者进行核验。'});
 await send({action:'publishCourse',id:course.id});
 const config={mode:'recurring',progressSync:false,orderedStages:true,durationDays:10,allowOverdue:false,repeatCredit:false,repeatPoints:true};
 const create={action:'create',title:'合成循环计划',orgId:f.org.id,config,courseIds:[course.id]};
 async function command(command,status=200,revision){const d=await expect(await api.GET());return expect(await api.POST(request('/api/learning-plans',{revision:revision??d.revision,command})),status);}
 act('hr');await command({...create,orgId:f.otherOrg.id},403);await command({...create,courseIds:[course.id,course.id]},400);
 const first=await command(create);let d=await expect(await api.GET());const revision=d.revision;
 await command({action:'seal',id:first.id});await command({action:'edit',id:first.id,...Object.fromEntries(Object.entries(create).filter(([k])=>k!=='action'))},400);
 await command({action:'revise',id:first.id},409,revision);
 const second=await command({action:'revise',id:first.id});await command({action:'revise',id:first.id},400);
 const edit={...create,action:'edit',id:second.id,title:'合成计划第二版'};
 await command({...edit,config:{...config,progressSync:true}},400);await command(edit);
 await command({action:'seal',id:second.id});await command({action:'revise',id:first.id},400);
 d=await expect(await api.GET());const originals=d.records.filter(r=>r.kind==='learningDefinition');assert.equal(originals.length,2);assert.equal(originals.find(r=>r.id===first.id).payload.title,create.title);assert.equal(originals.find(r=>r.id===second.id).payload.version,2);
 assert.ok(f.sqlite.prepare('SELECT count(*) AS n FROM hris_development_events WHERE record_id=?').get(second.id).n>=3);
 act('employee');await expect(await api.GET(),403);assert.ok(!(await get()).records.some(r=>r.kind==='learningDefinition'));
 act('manager');await expect(await api.GET(),403);
 act('owner');const other=await command({...create,orgId:f.otherOrg.id});act('hr');d=await expect(await api.GET());assert.ok(!d.records.some(r=>r.id===other.id));await command({action:'archive',id:other.id},403);
});
