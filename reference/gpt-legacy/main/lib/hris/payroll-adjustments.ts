import {payrollStaff,payrollWriter,payrollReviewer,payrollRecordAccess} from './payroll-access';
import {z} from 'zod';
import {HttpError} from './http';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {payrollTotals} from './payroll';
import type {State} from './model';
import type {Member} from './authorization';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(2000);
const item=z.object({name:text,category:z.enum(['earning','deduction','employer']),amountCents:z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(n=>n!==0),source:evidence});
export const adjustmentCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('query'),slipId:id,evidence}),
 z.object({action:z.literal('withdrawQuery'),id,evidence}),
 z.object({action:z.literal('answerQuery'),id,evidence,adjustmentId:id.optional()}),
 z.object({action:z.literal('adjustment'),slipId:id,name:text,reason:evidence,items:z.array(item).min(1).max(40)}),
 z.object({action:z.literal('approveAdjustment'),id,evidence}),
 z.object({action:z.literal('rejectAdjustment'),id,evidence}),
 z.object({action:z.literal('publishAdjustment'),id,evidence}),
 z.object({action:z.literal('cancelAdjustment'),id,evidence}),
]);
export function adjustedTotals(slip:R,records:R[]){return records.filter(r=>r.kind==='payAdjustment'&&r.referenceId===slip.id&&r.status==='published').reduce((a,r)=>({grossCents:a.grossCents+(r.payload.grossCents??0),deductionCents:a.deductionCents+(r.payload.deductionCents??0),netCents:a.netCents+(r.payload.netCents??0),employerCents:a.employerCents+(r.payload.employerCents??0)}),payrollTotals(slip.payload.payItems??[]));}
export function applyPayrollAdjustment(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=adjustmentCommand.parse(input),admin=payrollStaff(member);
 const fail=(s:string):never=>{throw new HttpError(400,s);},deny=(s:string):never=>{throw new HttpError(403,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const slip=(id:string)=>{const r=get(id,'paySlip');if(r.status==='cancelled'||!records.some(b=>b.id===r.referenceId&&b.kind==='payBatch'&&b.status==='published'))fail('只可针对已发布工资条办理');return r;};
 const make=(kind:R['kind'],payload:R['payload'],source:R,status:string):R=>({id:crypto.randomUUID(),kind,payload,employeeId:source.employeeId,positionId:null,referenceId:source.id,status,createdBy:member.userId,createdAt:at,updatedAt:at});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 if(c.action==='query'){const s=slip(c.slipId);if(s.employeeId!==member.employeeId)deny('仅员工本人可提交工资条异议');if(records.some(r=>r.kind==='payQuery'&&r.referenceId===s.id&&r.status==='submitted'))fail('该工资条已有待答复异议');return make('payQuery',{period:s.payload.period,employeeSnapshot:s.payload.employeeSnapshot,evidence:c.evidence},s,'submitted');}
 if(c.action==='withdrawQuery'){const r=get(c.id,'payQuery');if(r.employeeId!==member.employeeId||r.createdBy!==member.userId)deny('仅本人可撤回异议');if(r.status!=='submitted')fail('异议已处理');return change(r,'withdrawn',{closedReason:c.evidence});}
 if(!admin)deny('没有薪酬管理权限');if(['approveAdjustment','rejectAdjustment'].includes(c.action)?!payrollReviewer(member):!payrollWriter(member))deny('当前薪酬角色无此操作权限');
 if(c.action==='answerQuery'){const r=get(c.id,'payQuery');if(!payrollRecordAccess(r,records,state,member))deny('没有此组织的薪酬权限');if(r.employeeId===member.employeeId||r.createdBy===member.userId)deny('不能答复本人工资异议');if(r.status!=='submitted')fail('异议已经答复或撤回');if(c.adjustmentId){const a=get(c.adjustmentId,'payAdjustment');if(a.referenceId!==r.referenceId||a.status!=='published')fail('只能关联本工资条已发布的补差记录');}return change(r,'answered',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at,source:c.adjustmentId});}
 if(c.action==='adjustment'){const s=slip(c.slipId);if(!payrollRecordAccess(s,records,state,member))deny('没有此组织的薪酬权限');if(s.employeeId===member.employeeId)deny('不能编制本人的补差记录');if(new Set(c.items.map(i=>i.name)).size!==c.items.length)fail('补差项目名称不得重复');if(records.some(r=>r.kind==='payAdjustment'&&r.referenceId===s.id&&['submitted','approved'].includes(r.status)))fail('该工资条已有在途补差，请先处理');const totals=payrollTotals(c.items);return make('payAdjustment',{name:c.name,reason:c.reason,payItems:c.items,...totals,period:s.payload.period,currency:s.payload.currency,employeeSnapshot:s.payload.employeeSnapshot},s,'submitted');}
 const r=get(c.id,'payAdjustment');if(!payrollRecordAccess(r,records,state,member))deny('没有此组织的薪酬权限');slip(r.referenceId!);if(r.employeeId===member.employeeId)deny('不能处理本人的补差记录');
 switch(c.action){
 case 'approveAdjustment':case 'rejectAdjustment':{if(r.status!=='submitted')fail('补差已经复核或取消');if(r.createdBy===member.userId)deny('须由其他薪酬管理人员独立复核');return change(r,c.action==='approveAdjustment'?'approved':'rejected',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});}
 case 'cancelAdjustment':{if(r.createdBy!==member.userId)deny('仅编制人可取消未发布补差');if(!['submitted','approved'].includes(r.status))fail('已发布、驳回或取消的补差不能再次取消');return change(r,'cancelled',{closedReason:c.evidence});}
 case 'publishAdjustment':{if(r.status!=='approved')fail('须先通过独立复核');return change(r,'published',{publishedBy:member.userId,publishedAt:at,evidence:c.evidence});}
 default:return fail('不支持的补差操作');
 }
}
