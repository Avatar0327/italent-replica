import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,act,get,expect,request,core,hris} from './support/foundation-scenario.mjs';
const api=await import('../app/api/recruitment/route.ts');
const recruit=async(command,status=200)=>expect(await api.POST(request('/api/recruitment',{revision:(await get()).revision,command})),status);
for(const [stage,target] of [['interview','position'],['approveOffer','position'],['acceptOffer','position'],['approveOffer','grade'],['acceptOffer','grade']])test(`${stage} rejects disabled ${target} and permits explicit cleanup`,async t=>{
 const f=await setup();t.after(()=>f.sqlite.close());let grade;
 if(target==='grade'){await core({action:'grade',code:'SYN-GRADE',name:'合成职级',family:'合成序列',sequence:1,status:'启用'});grade=(await expect(await hris.GET())).state.grades.find(g=>g.code==='SYN-GRADE');}
 const q=await recruit({action:'requisition',positionId:f.position.id,title:'合成停用状态招聘',headcount:1,reason:'复现招聘推进阶段有效性检查',submit:true});act('manager');await recruit({action:'approveRequisition',id:q.id});act('owner');const c=await recruit({action:'candidate',requisitionId:q.id,name:'合成候选人',email:'',source:'合成状态一致性测试'});
 if(stage!=='interview'){await recruit({action:'interview',candidateId:c.id,rating:4,recommendation:'advance',evidence:'合成面试完成建议推进'});await recruit({action:'offer',id:c.id,joined:'2026-01-01',...(grade?{gradeId:grade.id}:{}),evidence:'合成录用进入独立审批'});}
 if(stage==='acceptOffer'){act('manager');await recruit({action:'approveOffer',id:c.id});act('owner');}
 await core(target==='position'?{action:'position',...f.position,status:'停用'}:{action:'grade',...grade,status:'停用'});
 if(stage==='approveOffer')act('manager');assert.equal((await expect(await api.GET())).targetValidity[c.id].offer,false);const before=await get();const command=stage==='interview'?{action:'interview',candidateId:c.id,rating:4,recommendation:'advance',evidence:'停用岗位不允许推进面试'}:stage==='approveOffer'?{action:'approveOffer',id:c.id}:{action:'acceptOffer',id:c.id,evidence:'停用目标不允许推进接受录用'};
 await recruit(command,400);assert.deepEqual(await get(),before);
 if(stage==='approveOffer'){await recruit({action:'returnOffer',id:c.id,reason:'目标失效退回并核对录用条件'});assert.equal((await get()).records.find(r=>r.id===c.id).status,'screening');}
 act('owner');await recruit({action:'rejectCandidate',id:c.id,reason:'合成流程明确结束保留历史'});assert.equal((await get()).records.find(r=>r.id===c.id).status,'rejected');
});
