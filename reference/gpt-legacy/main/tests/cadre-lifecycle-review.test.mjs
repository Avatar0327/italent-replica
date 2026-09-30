import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,request,expect,core} from './support/foundation-scenario.mjs';
const inbox=await import('../app/api/work-inbox/route.ts');
const cadres=await import('../app/api/cadres/route.ts');
async function send(command,status=200){const d=await expect(await cadres.GET());return expect(await cadres.POST(request('/api/cadres',{revision:d.revision,command})),status);}
for(const changed of ['employee-exit','position-disabled'])test('nomination approval rechecks '+changed+' without altering pending history',async()=>{
 const {sqlite,e,position}=await setup();try{
 const n=await send({action:'nominate',employeeId:e.id,positionId:position.id,evidence:'合成提名当前在职候选人'});
 if(changed==='employee-exit'){
 await core({action:'workflow',kind:'exit',steps:[{userId:'approver',name:'合成审批人'}]});const d=await core({action:'request',kind:'exit',employeeId:e.id,orgId:e.orgId,reason:'合成候选人离职验证'});act('approver');await core({action:'decide',id:d.state.approvals[0].id,decision:'approved'});
 }else await core({action:'position',...position,status:'停用'});
 act('manager');const before=await expect(await cadres.GET());assert.equal((await expect(await inbox.GET(request('/api/work-inbox')))).items.find(r=>r.recordId===n.id).action,'失效提名处理（拒绝或撤回）');await send({action:'decide',id:n.id,accepted:true,evidence:'失效候选或岗位不能批准'},400);const after=await expect(await cadres.GET());assert.deepEqual(after,before);
 await send({action:'decide',id:n.id,accepted:false,evidence:'状态失效由独立审议人退回'});assert.equal((await expect(await cadres.GET())).records.find(r=>r.id===n.id).status,'rejected');
 }finally{sqlite.close()}
});
