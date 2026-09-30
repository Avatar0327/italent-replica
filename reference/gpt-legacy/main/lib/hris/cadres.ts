import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(3000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const cadreCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('nominate'),employeeId:id,positionId:id,qualificationId:id.optional(),successionId:id.optional(),evidence}),
 z.object({action:z.literal('decide'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('withdraw'),id,evidence}),
 z.object({action:z.literal('recordAppointment'),id,approvalId:id,evidence}),
 z.object({action:z.literal('observation'),nominationId:id,due:date,objectives:evidence}),
 z.object({action:z.literal('submitReview'),id,evidence}),
 z.object({action:z.literal('returnReview'),id,evidence}),
 z.object({action:z.literal('completeReview'),id,accepted:z.boolean(),evidence}),
]);
export function applyCadre(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=cadreCommand.parse(input),scope=scopedOrgs(state,member),hr=['admin','hr'].includes(member.role),manager=hr||member.role==='manager';
 const deny=(s:string):never=>{throw new HttpError(403,s);},invalid=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const manage=(employeeId:string,positionId:string)=>{const e=state.employees.find(e=>e.id===employeeId),p=state.positions?.find(p=>p.id===positionId);if(!manager||!e||!p||!scope.has(e.orgId)||!scope.has(p.orgId))deny('须同时具备员工和目标岗位的管理权限');return {e:e!,p:p!};};
 const noSelf=(employeeId:string)=>{if(employeeId===member.employeeId)deny('不能为本人作出提名、审议或任用核对');};
 const proof=(r:R)=>{if(r.payload.qualificationId){const q=get(r.payload.qualificationId,'qualificationApplication');if(q.employeeId!==r.employeeId||q.status!=='certified'||q.payload.validUntil&&q.payload.validUntil<businessDate(at))invalid('引用的资格认证已经失效，请重新核实提名');}if(r.payload.successionId){const q=get(r.payload.successionId,'succession');if(q.employeeId!==r.employeeId||q.positionId!==r.positionId||q.status!=='active')invalid('引用的后备记录已失效或不匹配');}};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'submitted',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 const independent=(r:R)=>{manage(r.employeeId!,r.positionId!);noSelf(r.employeeId!);if(r.createdBy===member.userId)deny('须由非发起人独立办理审议或考察核验');};
 switch(c.action){
 case 'nominate':{const {e,p}=manage(c.employeeId,c.positionId);noSelf(e.id);if(e.status==='离职'||p.status!=='启用')invalid('候选员工或目标岗位状态无效');if(records.some(r=>r.kind==='cadreNomination'&&r.employeeId===e.id&&r.positionId===p.id&&['submitted','approved'].includes(r.status)))invalid('同员工同岗位已有在途提名');const r=make('cadreNomination',{evidence:c.evidence,qualificationId:c.qualificationId,successionId:c.successionId,employeeSnapshot:{code:e.code,name:e.name,orgName:state.orgs.find(o=>o.id===e.orgId)?.name??''},targetPositionName:p.name},{employeeId:e.id,positionId:p.id});proof(r);r.payload.nominationProof={qualification:c.qualificationId?{...get(c.qualificationId,'qualificationApplication').payload}:null,succession:c.successionId?{...get(c.successionId,'succession').payload}:null};return r;}
 case 'decide':{const r=get(c.id,'cadreNomination');independent(r);if(!['admin','manager'].includes(member.role))deny('提名审议仅由管理员或经理办理');if(r.status!=='submitted')invalid('提名已处理');if(c.accepted){const {e,p}=manage(r.employeeId!,r.positionId!);if(e.status==='离职'||p.status!=='启用')invalid('候选员工或目标岗位状态已失效，只能拒绝或撤回提名');proof(r);}return change(r,c.accepted?'approved':'rejected',{approvedBy:member.userId,approvedAt:at,verification:c.evidence});}
 case 'withdraw':{const r=get(c.id,'cadreNomination');manage(r.employeeId!,r.positionId!);if(r.createdBy!==member.userId)deny('仅提名发起人可撤回');if(!['submitted','approved'].includes(r.status))invalid('已任用或结束的提名不能撤回');return change(r,'withdrawn',{closedReason:c.evidence});}
 case 'recordAppointment':{if(!hr)deny('任用核对由HR或管理员办理');const r=get(c.id,'cadreNomination');const {e}=manage(r.employeeId!,r.positionId!);noSelf(e.id);if(r.status!=='approved')invalid('提名须先通过独立审议');proof(r);const approval=state.approvals.find(a=>a.id===c.approvalId);if(!approval||approval.kind!=='transfer'||approval.status!=='approved'||(approval.details?.transfer&&approval.details.transfer.execution!=='applied')||approval.employeeId!==r.employeeId||approval.positionId!==r.positionId||approval.created<r.payload.approvedAt!||e.status==='离职'||e.positionId!==r.positionId)invalid('须引用提名审议后发起并终审通过的同员工同岗位调动，且当前任职一致');if(records.some(x=>x.kind==='cadreNomination'&&x.payload.appointmentApprovalId===approval!.id))invalid('该调动审批已关联其他任用记录');return change(r,'appointed',{appointmentApprovalId:approval!.id,appointmentAt:at,appointmentBy:member.userId,appointmentEvidence:c.evidence});}
 case 'observation':{if(!hr)deny('考察计划由HR或管理员建立');const n=get(c.nominationId,'cadreNomination');manage(n.employeeId!,n.positionId!);noSelf(n.employeeId!);if(n.status!=='appointed'||c.due<businessDate(at))invalid('任用尚未核对完成或考察截止日无效');if(records.some(r=>r.kind==='cadreObservation'&&r.referenceId===n.id))invalid('此任用记录已有考察计划');return make('cadreObservation',{name:'任职考察',objectives:c.objectives,due:c.due,targetPositionName:n.payload.targetPositionName},{employeeId:n.employeeId,positionId:n.positionId,referenceId:n.id,status:'active'});}
 case 'submitReview':{const r=get(c.id,'cadreObservation');if(r.employeeId!==member.employeeId)deny('仅被考察员工本人可提交述职');if(!['active','returned'].includes(r.status))invalid('当前状态不能提交述职');return change(r,'submitted',{selfEvidence:c.evidence,submittedBy:member.userId,submittedAt:at});}
 case 'returnReview':case 'completeReview':{const r=get(c.id,'cadreObservation');independent(r);if(r.status!=='submitted')invalid('须先由员工提交述职');return change(r,c.action==='returnReview'?'returned':c.accepted?'completed':'development_needed',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});}
 }
}
