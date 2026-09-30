import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setup,send,get,expect,dev,act,request,anchors,due} from './support/foundation-scenario.mjs';

test('G0 SC-1：计划人员、标准版本与状态异常均不产生记录或审计',async t=>{
 const {sqlite,e,other}=await setup();t.after(()=>sqlite.close());
 const first=await send({action:'standard',code:'G0-V',name:'合成能力版本一',anchors});
 const second=await send({action:'standard',code:'G0-V',name:'合成能力版本二',anchors});
 const planFor=employeeId=>send({action:'plan',employeeId,standardId:first.id,target:3,title:'合成发展行动',actionPlan:'完成合成案例并由独立经理核实成果',due});
 const a=await planFor(e.id),b=await planFor(other.id);
 const makeCourse=async(code,standardId)=>{const c=await send({action:'course',code,title:'合成版本课程',description:'用于验证关联版本与计划边界',content:'完成合成案例，提交实践证据，并由独立核验人员确认。',standardId});await send({action:'publishCourse',id:c.id});return c;};
 const matching=await makeCourse('G0-MATCH',first.id),mismatch=await makeCourse('G0-MISMATCH',second.id);
 const snapshot=()=>['hris_workspaces','hris_development_records','hris_development_events','hris_audit_events'].map(table=>sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
 async function rejected(command){const before=snapshot();await send(command,400);assert.deepEqual(snapshot(),before);}
 const input={action:'enroll',employeeId:e.id,planId:a.id,courseId:matching.id,due};
 await rejected({...input,planId:b.id});
 await rejected({...input,courseId:mismatch.id});
 act('employee');await send({action:'submitPlan',id:a.id,evidence:'合成计划已提交，等待独立核验'});act('owner');
 await rejected(input);
 act('manager');await send({action:'verifyPlan',id:a.id,accepted:false,evidence:'请补充学习实践成果再提交'});
 const enrolled=await send(input);assert.equal((await get()).records.find(r=>r.id===enrolled.id).payload.planId,a.id);
 await send({action:'cancelEnrollment',id:enrolled.id,reason:'合成取消场景用于核实保留原任务'});
 await rejected(input);
 await send({action:'cancelPlan',id:a.id,reason:'合成计划终止，保留原始关联记录'});
 act('owner');
 const fresh=await makeCourse('G0-CANCELLED-PLAN',first.id);
 await rejected({...input,courseId:fresh.id});
});

test('G0 SC-1：历史20条分页保持事件快照，完成计划拒绝新增派课',async t=>{
 const {sqlite,e}=await setup();t.after(()=>sqlite.close());
 const s=await send({action:'standard',code:'G0-HISTORY',name:'合成历史能力',anchors});
 const p=await send({action:'plan',employeeId:e.id,standardId:s.id,target:3,title:'合成历史行动',actionPlan:'合成多轮提交材料，用于检查历史分页快照',due});
 for(let i=0;i<10;i++){
  act('employee');await send({action:'submitPlan',id:p.id,evidence:'合成第'+i+'轮材料提交保留原始事实'});
  act('manager');await send({action:'verifyPlan',id:p.id,accepted:false,evidence:'合成第'+i+'轮独立核验要求补充材料'});
 }
 const page=async n=>expect(await dev.GET(request('/api/development?id='+p.id+'&page='+n)));
 const first=await page(1),second=await page(2);
 assert.equal(first.items.length,20);assert.equal(first.hasMore,true);
 assert.equal(second.items.length,1);assert.equal(second.hasMore,false);
 assert.equal(second.items[0].snapshot.status,'active');assert.equal(second.items[0].snapshot.payload.evidence,undefined);
 const revisions=[...first.items,...second.items].map(x=>x.revision);
 assert.equal(new Set(revisions).size,21);assert.deepEqual(revisions,[...revisions].sort((a,b)=>b-a));
 await expect(await dev.GET(request('/api/development?id='+p.id+'&page=0')),400);
 act('employee');await send({action:'submitPlan',id:p.id,evidence:'合成材料最终补全申请独立确认'});
 act('manager');await send({action:'verifyPlan',id:p.id,accepted:true,evidence:'独立核实发展行动，当前无关联课程'});
 act('owner');const c=await send({action:'course',code:'G0-COMPLETED',title:'合成后续课程',standardId:s.id,description:'已完成计划不能被追加任务',content:'完成状态应保持原有验收范围，不允许新增关联学习任务。'});
 await send({action:'publishCourse',id:c.id});const before=(await get()).revision;
 await send({action:'enroll',employeeId:e.id,courseId:c.id,planId:p.id,due},400);
 assert.equal((await get()).revision,before);
});

test('G0 SC-1：JSON请求、匿名身份、租户注入与错误响应边界',async t=>{
 const {sqlite}=await setup();t.after(()=>sqlite.close());
 const revision=(await get()).revision,command={action:'standard',code:'G0-HTTP',name:'合成请求校验',anchors};
 const body=JSON.stringify({revision,command});
 const cases=[
  [new Request('https://hris.example/api/development',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body}),403],
  [new Request('https://hris.example/api/development',{method:'POST',headers:{Origin:'https://hris.example','Content-Type':'text/plain'},body}),415],
  [new Request('https://hris.example/api/development',{method:'POST',headers:{Origin:'https://hris.example','Content-Type':'application/json'},body:'{'}),400],
  [new Request('https://hris.example/api/development',{method:'POST',headers:{Origin:'https://hris.example','Content-Type':'application/json'},body:' '.repeat(32769)}),413],
 ];
 for(const [req,status] of cases){const error=await expect(await dev.POST(req),status);assert.deepEqual(Object.keys(error),['error']);assert.equal(typeof error.error,'string');assert.equal((await get()).revision,revision);}
 globalThis.p2headers=new Headers();await expect(await dev.GET(),401);act('owner');
 const made=await expect(await dev.POST(request('/api/development',{revision,tenantId:'forged-tenant',command:{...command,tenantId:'forged-tenant'}})));
 const row=sqlite.prepare('SELECT tenant_id FROM hris_development_records WHERE id=?').get(made.id);
 assert.equal(row.tenant_id,sqlite.prepare("SELECT tenant_id FROM hris_memberships WHERE user_id='owner'").get().tenant_id);
 assert.notEqual(row.tenant_id,'forged-tenant');
});

test('G0 SC-1：多记录空批、超限、重复标识拒绝，20条边界原子保存',async t=>{
 const {sqlite}=await setup();t.after(()=>sqlite.close());
 const repo=await import('../lib/hris/development-repository.ts');
 const {applyDevelopment}=await import('../lib/hris/development.ts');
 const ctx=await repo.developmentContext();
 const records=Array.from({length:21},(_,i)=>applyDevelopment(ctx.records,ctx.state,ctx.member,{action:'standard',code:'G0-BATCH-'+i,name:'合成批次标准'+i,anchors}));
 for(const batch of [[],records,[records[0],records[0]]]){
  await assert.rejects(()=>repo.saveDevelopmentMany(ctx,ctx.row.revision,batch,'合成边界验证'),e=>e.status===400);
  assert.equal((await get()).revision,ctx.row.revision);assert.equal(sqlite.prepare('SELECT count(*) n FROM hris_development_records').get().n,0);
 }
 await repo.saveDevelopmentMany(ctx,ctx.row.revision,records.slice(0,20),'合成20条边界');
 assert.equal((await get()).revision,ctx.row.revision+1);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM hris_development_records').get().n,20);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM hris_development_events WHERE revision=?').get(ctx.row.revision+1).n,20);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM hris_audit_events WHERE revision=?').get(ctx.row.revision+1).n,1);
});
