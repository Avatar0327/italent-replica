import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,expect,get,request,core,hris,dev,grant} from './support/foundation-scenario.mjs';
import {moveEmployee} from './support/performance-scenario.mjs';
const api=await import('../app/api/cadre-interviews/route.ts'),profiles=await import('../app/api/cadre-profiles/route.ts');
const save=async(command,status=200,revision)=>expect(await api.POST(request('/api/cadre-interviews',{revision:revision??(await get()).revision,command})),status);
async function fixture(){const f=await setup();act('owner');await core({action:'employee',code:'INTERVIEWER',name:'合成访谈人',orgId:f.org.id,job:'访谈记录测试',level:'',joined:'2026-01-01',email:''});const interviewer=(await expect(await hris.GET())).state.employees.find(e=>e.code==='INTERVIEWER');return {...f,interviewer,input:{action:'save',employeeId:f.e.id,interviewerId:interviewer.id,type:'任前访谈',role:'业务关联方',date:'2026-01-02',location:'合成会议室',content:'仅合成访谈内容，未经核实的关系不产生业务授权。',evidence:'合成记录验证，不使用原站访谈正文'}};}
const history=async(id,status=200)=>expect(await dev.GET(request('/api/development?id='+id)),status);
test('cadre interviews preserve corrections, prevent identity replacement and expose no record to non-HR roles',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());act('hr');const first=await save(f.input);await save(f.input,400);
 await save({...f.input,id:first.id,content:'已更正的合成访谈内容',evidence:'补充核实后的更正依据'});const h=await history(first.id);assert.equal(h.items.length,2);assert.equal(h.items[1].snapshot.payload.cadreInterview.content,f.input.content);assert.equal(h.items[0].snapshot.payload.version,2);
 await save({...f.input,id:first.id,interviewerId:f.other.id},403);await save({...f.input,id:first.id,employeeId:f.interviewer.id},400);
 let profile=await expect(await profiles.GET(request('/api/cadre-profiles?employeeId='+f.e.id)));assert.ok(profile.sections.find(x=>x.key==='interviews').items.some(x=>x.id===first.id));
 for(const role of ['employee','manager','approver']){act(role);await expect(await api.GET(request('/api/cadre-interviews')),403);await save(f.input,403);assert.ok(!(await get()).records.some(r=>r.id===first.id));await history(first.id,403);}
 act('manager');profile=await expect(await profiles.GET(request('/api/cadre-profiles?employeeId='+f.e.id)));assert.ok(!profile.sections.some(s=>s.key==='interviews'));
 act('hr');await save({action:'cancel',id:first.id,evidence:'合成错误记录作废，保留全部历史'});await save({...f.input,id:first.id},400);assert.equal((await history(first.id)).items.length,3);
});
test('current scope applies to subject and interviewer, including historical events after transfer',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());act('hr');await save({...f.input,employeeId:f.other.id},403);await save({...f.input,interviewerId:f.other.id},403);const record=await save(f.input);
 await grant('employee','hr',f.e.id,[f.org.id],true);act('employee');await save({...f.input,content:'不能登记本人的访谈'},403);
 await moveEmployee({...f,e:f.interviewer},'transfer');act('hr');const list=await expect(await api.GET(request('/api/cadre-interviews')));assert.equal(list.total,0);await history(record.id,403);await save({...f.input,id:record.id},403);
 act('owner');assert.equal((await history(record.id)).items.length,1);assert.equal((await expect(await api.GET(request('/api/cadre-interviews')))).total,1);
});
test('invalid fields, stale revisions and audit failure cannot leave partial interview records',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());act('hr');const before=await get();
 for(const patch of [{content:'文'.repeat(201)},{date:'2026-02-30'},{date:'2099-12-31'},{role:'管理员'},{type:'任意访谈'},{interviewerId:f.e.id}])await save({...f.input,...patch},400);
 assert.equal((await get()).revision,before.revision);await save(f.input,409,before.revision-1);
 f.sqlite.exec("CREATE TRIGGER reject_interview_audit BEFORE INSERT ON hris_audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");await save(f.input,503);f.sqlite.exec('DROP TRIGGER reject_interview_audit');assert.equal((await get()).revision,before.revision);assert.ok(!(await get()).records.some(r=>r.kind==='cadreInterview'));
 await save(f.input);assert.equal((await get()).revision,before.revision+1);
});
