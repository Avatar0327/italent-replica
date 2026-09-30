import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,request,expect,core,hris,dev} from './support/foundation-scenario.mjs';
const inbox=await import('../app/api/work-inbox/route.ts');
const fields=await import('../app/api/employee-fields/route.ts');
async function field(command,status=200){const d=await expect(await fields.GET());return expect(await fields.POST(request('/api/employee-fields',{revision:d.revision,command})),status);}
test('pending field change cannot be approved after employee exit; independent return preserves formal value and audit',async()=>{
 const {sqlite,e}=await setup();try{
 const definition=await field({action:'define',code:'exit_city',name:'合成意向城市',description:'验证离职前后字段复核状态一致性',fieldType:'text',employeeRead:true,employeeEditable:true});
 const value=await field({action:'record',definitionId:definition.id,employeeId:e.id,value:'原正式值',evidence:'合成初始化字段正式值'});
 act('employee');await field({action:'propose',definitionId:definition.id,value:'待批准值',evidence:'离职前提交字段变更申请'});
 act('owner');await core({action:'workflow',kind:'exit',steps:[{userId:'approver',name:'合成审批人'}]});
 let d=await core({action:'request',kind:'exit',employeeId:e.id,orgId:e.orgId,reason:'合成离职流程验证'});const approval=d.state.approvals.find(a=>a.employeeId===e.id&&a.status==='pending');
 act('approver');await core({action:'decide',id:approval.id,decision:'approved'});
 act('hr');const before=await expect(await fields.GET());const audit=sqlite.prepare('SELECT COUNT(*) AS n FROM hris_audit_events').get();
 assert.equal((await expect(await inbox.GET(request('/api/work-inbox')))).items.find(r=>r.recordId===value.id).action,'离职字段申请退回');
 await field({action:'review',id:value.id,accepted:true,evidence:'员工离职后不得批准变更'},400);
 const after=await expect(await fields.GET());assert.equal(after.revision,before.revision);assert.deepEqual(after.records,before.records);assert.deepEqual(sqlite.prepare('SELECT COUNT(*) AS n FROM hris_audit_events').get(),audit);
 await field({action:'review',id:value.id,accepted:false,evidence:'员工已经离职退回待办'});
 const final=await expect(await fields.GET());const row=final.records.find(r=>r.id===value.id);assert.equal(row.status,'active');assert.equal(row.payload.fieldValue,'原正式值');assert.equal(row.payload.pendingValue,undefined);
 assert.ok((await expect(await dev.GET(request('/api/development?id='+value.id)))).items.length>=3);
 }finally{sqlite.close()}
});
