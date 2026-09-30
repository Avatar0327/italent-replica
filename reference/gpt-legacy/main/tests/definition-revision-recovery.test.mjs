import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,get,expect,request,send} from './support/foundation-scenario.mjs';
const rating=await import('../app/api/performance-ratings/route.ts'),homework=await import('../app/api/learning-homework/route.ts'),exam=await import('../app/api/learning-exams/route.ts'),plan=await import('../app/api/learning-plans/route.ts');
const levels=[{label:'通过',min:2,max:4,minInclusive:true,maxInclusive:true,description:'',talentBand:3},{label:'待提高',min:0,max:2,minInclusive:true,maxInclusive:false,description:'',talentBand:1}];
async function post(api,c,status=200){const r=await expect(await api.POST(request('/api/test',{revision:(await get()).revision,command:c})),status);return r.id??r.ids?.[0];}
for(const kind of ['rating','homework','exam','plan'])test(`${kind}: discarded drafts permit a later unique version while live successors still prevent forks`,async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());let api,c;
 if(kind==='rating'){api=rating;c={title:'合成等级归档修订',orgId:f.org.id,levels};}
 if(kind==='homework'){api=homework;c={title:'合成作业归档修订',orgId:f.org.id,content:'用合成任务核对归档草稿后的恢复过程，完整保留版本编号和原始证据。',maxSubmissions:2};}
 if(kind==='exam'){api=exam;c={title:'合成试卷归档修订',orgId:f.org.id,questions:[{prompt:'合成核查需要保留历史吗',options:['需要','不需要'],correct:0}],passingScore:80,maxAttempts:2};}
 if(kind==='plan'){api=plan;const course=await send({action:'course',code:'RECOVER',title:'合成版本核查课程',description:'合成教学任务用于测试版本归档',content:'必须保留原有版本内容与历史证据，后续草稿归档不能破坏继续维护。'});await send({action:'publishCourse',id:course.id});c={title:'合成计划归档修订',orgId:f.org.id,courseIds:[course.id],config:{mode:'relative',durationDays:30,allowOverdue:false,orderedStages:false,progressSync:false}};}
 const first=await post(api,{action:'create',...c});await post(api,{action:'seal',id:first});const second=await post(api,{action:'revise',id:first});await post(api,{action:'revise',id:first},400);await post(api,{action:'archive',id:second});const third=await post(api,{action:'revise',id:first});let records=(await get()).records;
 assert.equal(records.find(r=>r.id===second).payload.version,2);assert.equal(records.find(r=>r.id===third).payload.version,3);assert.equal(records.find(r=>r.id===second).status,'archived');await post(api,{action:'seal',id:third});await post(api,{action:'revise',id:first},400);await post(api,{action:'archive',id:third});const fourth=await post(api,{action:'revise',id:first});records=(await get()).records;assert.equal(records.find(r=>r.id===fourth).payload.version,4);assert.equal(records.find(r=>r.id===first).payload.version,1);assert.equal(records.find(r=>r.id===first).status,'sealed');
});
