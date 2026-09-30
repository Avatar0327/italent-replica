import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const qualificationCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('standard'),code:text,name:text,criteria:evidence,requirements:z.array(z.object({standardId:id,target:z.number().int().min(1).max(5)})).min(1).max(20)}),
 z.object({action:z.literal('publishStandard'),id}),z.object({action:z.literal('archiveStandard'),id}),
 z.object({action:z.literal('apply'),standardId:id,employeeId:id,evidence}),
 z.object({action:z.literal('withdraw'),id,evidence}),
 z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence,validUntil:date.optional()}),
 z.object({action:z.literal('revoke'),id,evidence}),
]);
export function qualificationEvidence(records:R[],employeeId:string,standard:R){return (standard.payload.qualificationRequirements??[]).map(q=>{const a=records.filter(r=>r.kind==='assessment'&&r.referenceId===q.standardId&&r.employeeId===employeeId).sort((a,b)=>(b.payload.assessedOn??'').localeCompare(a.payload.assessedOn??'')||b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];return {...q,assessmentId:a?.id??null,rating:a?.payload.rating??null,assessedOn:a?.payload.assessedOn??null,evidence:a?.payload.evidence??null,met:!!a&&(a.payload.rating??0)>=q.target};});}
export function applyQualification(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=qualificationCommand.parse(input),scope=scopedOrgs(state,member),today=businessDate(at),hr=['admin','hr'].includes(member.role),manager=hr||member.role==='manager';
 const invalid=(s:string):never=>{throw new HttpError(400,s);},deny=(s:string):never=>{throw new HttpError(403,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const employee=(id:string)=>{const e=state.employees.find(e=>e.id===id);if(!e||!(hr&&scope.has(e.orgId)||id===member.employeeId))deny('只能为本人或HR管理范围内员工申请');if(e!.status==='离职')invalid('离职员工不能新申请认证');return e!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 const independent=(r:R)=>{const e=state.employees.find(e=>e.id===r.employeeId);if(!manager||!e||!scope.has(e.orgId)||r.employeeId===member.employeeId||r.createdBy===member.userId)deny('须由其他有权限的评审者办理，不能自审或评审本人资格');};
 switch(c.action){
 case 'standard':{if(!hr)deny('仅HR或管理员可维护资格标准');if(new Set(c.requirements.map(q=>q.standardId)).size!==c.requirements.length)invalid('能力标准不得重复');const requirements=c.requirements.map(q=>{const s=get(q.standardId,'standard');return {...q,name:s.payload.name!,version:s.payload.version!};});if(new Set(requirements.map(q=>records.find(r=>r.id===q.standardId)?.payload.code)).size!==requirements.length)invalid('同一能力不能同时选入多个版本');return make('qualificationStandard',{code:c.code,name:c.name,criteria:c.criteria,qualificationRequirements:requirements,version:1+Math.max(0,...records.filter(r=>r.kind==='qualificationStandard'&&r.payload.code===c.code).map(r=>r.payload.version??0))});}
 case 'publishStandard':case 'archiveStandard':{if(!hr)deny('仅HR或管理员可发布和停用资格标准');const r=get(c.id,'qualificationStandard');if(c.action==='publishStandard'){if(r.status!=='draft')invalid('仅草稿可发布');return change(r,'published',{publishedBy:member.userId,publishedAt:at});}if(r.status!=='published')invalid('标准尚未发布或已停用');return change(r,'archived');}
 case 'apply':{employee(c.employeeId);const standard=get(c.standardId,'qualificationStandard');if(standard.status!=='published')invalid('仅已发布资格标准可申请');if(records.some(r=>r.kind==='qualificationApplication'&&r.employeeId===c.employeeId&&r.referenceId===standard.id&&(r.status==='submitted'||r.status==='certified'&&(!r.payload.validUntil||r.payload.validUntil>=today))))invalid('已有待评审申请或本版本有效认证');return make('qualificationApplication',{name:standard.payload.name,version:standard.payload.version,evidence:c.evidence,qualificationSnapshot:{...standard.payload},submittedBy:member.userId,submittedAt:at},{employeeId:c.employeeId,referenceId:standard.id,status:'submitted'});}
 case 'withdraw':{const r=get(c.id,'qualificationApplication');if(r.createdBy!==member.userId)deny('仅申请提交人可撤回');if(r.status!=='submitted')invalid('只有待评审申请可撤回');return change(r,'withdrawn',{closedReason:c.evidence});}
 case 'review':{const r=get(c.id,'qualificationApplication');independent(r);if(r.status!=='submitted')invalid('申请已经处理');const standard=get(r.referenceId!,'qualificationStandard');const proof=qualificationEvidence(records,r.employeeId!,standard);if(c.accepted){if(state.employees.find(e=>e.id===r.employeeId)?.status==='离职')invalid('员工已离职，不能新授予认证');if(!proof.every(p=>p.met))invalid('仍有能力标准未评定或未达到要求，请先完成同版本能力评估');if(c.validUntil&&c.validUntil<today)invalid('认证有效期不能早于今天');}return change(r,c.accepted?'certified':'rejected',{qualificationProof:proof,verification:c.evidence,verifiedBy:member.userId,verifiedAt:at,validUntil:c.accepted?c.validUntil:undefined,certificateNumber:c.accepted?'IQ-'+crypto.randomUUID():undefined});}
 case 'revoke':{const r=get(c.id,'qualificationApplication');if(!hr)deny('仅HR或管理员可撤销内部认证');independent(r);if(r.status!=='certified')invalid('仅已认证记录可撤销');return change(r,'revoked',{revokedBy:member.userId,revokedAt:at,revocationReason:c.evidence});}
 }
}
