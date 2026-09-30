import {contractFieldInput,captureContractFields} from './contract-fields';
import {z} from 'zod';
import {businessDate} from './business-time';
export {businessDate} from './business-time';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const workforceCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('staffing'),positionId:id,start:date,end:date,headcount:z.number().int().min(0).max(100000),supersedes:id.optional(),evidence}),
 z.object({action:z.literal('approveStaffing'),id,evidence}),z.object({action:z.literal('rejectStaffing'),id,evidence}),
 z.object({action:z.literal('contract'),employeeId:id,number:text,employerName:text,agreementCategory:z.enum(['labor','service','internship']).optional(),contractType:z.enum(['fixed','open','project']),start:date,end:date.optional(),renewalOf:id.optional(),customFields:contractFieldInput.optional(),evidence}),
 z.object({action:z.literal('classifyContract'),id,agreementCategory:z.enum(['labor','service','internship']),evidence}),
 z.object({action:z.literal('signContract'),id,signedOn:date,evidence}),
 z.object({action:z.literal('cancelContract'),id,evidence}),
 z.object({action:z.literal('endContract'),id,endedOn:date,evidence}),
]);
export function staffingUsage(records:R[],state:State,asOf=businessDate()){
 return records.filter(r=>r.kind==='staffingPlan').map(r=>{const occupied=state.employees.filter(e=>e.status!=='离职'&&e.positionId===r.positionId).length;return {id:r.id,positionId:r.positionId,approved:r.payload.headcount??0,occupied,vacancy:Math.max(0,(r.payload.headcount??0)-occupied),excess:Math.max(0,occupied-(r.payload.headcount??0)),effective:r.status==='approved'&&!records.some(x=>x.kind==='staffingPlan'&&x.status==='approved'&&x.payload.supersedes===r.id)&&r.payload.start!<=asOf&&r.payload.end!>=asOf};});
}
export function assertStaffingCapacity(records:R[],previous:State,next:State,asOf=businessDate()){
 const active=records.filter(r=>r.kind==='staffingPlan'&&r.status==='approved'&&!records.some(x=>x.kind==='staffingPlan'&&x.status==='approved'&&x.payload.supersedes===r.id)&&r.payload.start!<=asOf&&r.payload.end!>=asOf),controlledOrgs=new Set(active.map(r=>next.positions?.find(p=>p.id===r.positionId)?.orgId));
 for(const e of next.employees){const old=previous.employees.find(x=>x.id===e.id);if(e.status!=='离职'&&!e.positionId&&controlledOrgs.has(e.orgId)&&(!old||old.orgId!==e.orgId||!!old.positionId))throw new HttpError(400,'此组织已启用岗位编制，请先关联有效岗位');}
 for(const r of records.filter(r=>r.kind==='staffingPlan'&&r.status==='approved'&&!records.some(x=>x.kind==='staffingPlan'&&x.status==='approved'&&x.payload.supersedes===r.id)&&r.payload.start!<=asOf&&r.payload.end!>=asOf)){
  const count=(s:State)=>s.employees.filter(e=>e.status!=='离职'&&e.positionId===r.positionId).length,before=count(previous),after=count(next);
  if(after>before&&after>r.payload.headcount!)throw new HttpError(400,'目标岗位已达到当前批准编制，须先调整编制或释放岗位名额');
 }
}
export function applyWorkforce(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=workforceCommand.parse(input),scope=scopedOrgs(state,member),today=businessDate(at);
 const invalid=(s:string):never=>{throw new HttpError(400,s);},deny=(s:string):never=>{throw new HttpError(403,s);};
 const hr=()=>{if(!['admin','hr'].includes(member.role))deny('仅管理员或HR可维护此业务');};
 const employee=(id:string)=>{const e=state.employees.find(e=>e.id===id);if(!e||!scope.has(e.orgId))deny('没有此员工的管理权限');return e!;};
 const position=(id:string)=>{const p=state.positions?.find(p=>p.id===id);if(!p||!scope.has(p.orgId))deny('没有此岗位的管理权限');if(p!.status!=='启用')invalid('岗位已停用');return p!;};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 switch(c.action){
 case 'staffing':{hr();position(c.positionId);if(c.end<c.start)invalid('结束日期不能早于开始日期');if(c.supersedes){const old=get(c.supersedes,'staffingPlan');if(old.status!=='approved'||old.positionId!==c.positionId||old.payload.start!==c.start||old.payload.end!==c.end||records.some(x=>x.kind==='staffingPlan'&&x.status==='approved'&&x.payload.supersedes===old.id))invalid('调整须引用同岗位同期间的最新批准编制');}return make('staffingPlan',{start:c.start,end:c.end,headcount:c.headcount,supersedes:c.supersedes,evidence:c.evidence},{positionId:c.positionId});}
 case 'approveStaffing':case 'rejectStaffing':{const r=get(c.id,'staffingPlan');position(r.positionId!);if(!['admin','manager'].includes(member.role)||member.userId===r.createdBy)deny('编制须由其他有权限的管理员或经理审批');if(r.status!=='draft')invalid('编制申请已处理');if(c.action==='approveStaffing'&&records.some(x=>x.id!==r.id&&x.id!==r.payload.supersedes&&!records.some(v=>v.kind==='staffingPlan'&&v.status==='approved'&&v.payload.supersedes===x.id)&&x.kind==='staffingPlan'&&x.positionId===r.positionId&&x.status==='approved'&&x.payload.start!<=r.payload.end!&&x.payload.end!>=r.payload.start!))invalid('同岗位存在日期重叠的已批准编制');return change(r,c.action==='approveStaffing'?'approved':'rejected',{approvedBy:member.userId,approvedAt:at,verification:c.evidence});}
 case 'contract':{hr();employee(c.employeeId);if(c.end&&c.end<c.start)invalid('合同结束日期不能早于开始日期');if(c.contractType==='fixed'&&!c.end)invalid('固定期限合同须登记结束日期');if(c.contractType==='open'&&c.end)invalid('无固定期限合同不填写结束日期');if(records.some(r=>r.kind==='employmentContract'&&r.payload.contractNumber?.toLowerCase()===c.number.toLowerCase()))invalid('合同编号已存在，已作废编号仍保留');if(c.renewalOf){const old=get(c.renewalOf,'employmentContract');if(old.employeeId!==c.employeeId||!['signed','ended'].includes(old.status))invalid('续签须关联同员工已签署合同');const end=old.payload.endedOn??old.payload.end;if(!end||c.start<=end)invalid('续签开始日期须晚于原合同结束日期');if(records.some(r=>r.kind==='employmentContract'&&r.referenceId===old.id&&r.status!=='cancelled'))invalid('原合同已有续签记录');}const custom=captureContractFields(records,state,member,c.employeeId,c.renewalOf?get(c.renewalOf,'employmentContract'):undefined,c.customFields);return make('employmentContract',{...(custom.length?{contractFields:custom}:{}),contractNumber:c.number,employerName:c.employerName,contractType:c.contractType,agreementCategory:c.agreementCategory,start:c.start,end:c.end,evidence:c.evidence},{employeeId:c.employeeId,referenceId:c.renewalOf??null});}
 case 'classifyContract':{hr();const r=get(c.id,'employmentContract');employee(r.employeeId!);if(r.status!=='draft')invalid('仅草稿可登记或更正协议类别');return change(r,'draft',{agreementCategory:c.agreementCategory,categoryEvidence:c.evidence});}
 case 'signContract':{hr();const r=get(c.id,'employmentContract');employee(r.employeeId!);if(r.status!=='draft'||c.signedOn>today)invalid('仅草稿可登记已完成签署，签署日期不能在未来');if(records.some(x=>x.id!==r.id&&x.kind==='employmentContract'&&x.employeeId===r.employeeId&&x.payload.employerName===r.payload.employerName&&['signed','ended'].includes(x.status)&&x.payload.start!<=(r.payload.end??'9999-12-31')&&(x.payload.endedOn??x.payload.end??'9999-12-31')>=r.payload.start!))invalid('同员工同用工主体存在日期重叠的已签合同');return change(r,'signed',{signedOn:c.signedOn,signEvidence:c.evidence,signedRecordedBy:member.userId});}
 case 'cancelContract':{hr();const r=get(c.id,'employmentContract');employee(r.employeeId!);if(r.status!=='draft')invalid('只能作废未登记签署的草稿');return change(r,'cancelled',{closedReason:c.evidence});}
 case 'endContract':{hr();const r=get(c.id,'employmentContract');employee(r.employeeId!);if(member.userId===r.createdBy||member.employeeId===r.employeeId)deny('终止登记须由其他HR或管理员复核，且不能办理本人合同');if(r.status!=='signed'||c.endedOn<r.payload.start!||c.endedOn>today||(r.payload.end&&c.endedOn>r.payload.end))invalid('合同状态或终止日期无效');return change(r,'ended',{endedOn:c.endedOn,verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});}
 }
}
