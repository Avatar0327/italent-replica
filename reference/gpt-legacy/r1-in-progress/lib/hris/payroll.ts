import {freezePayrollAttendance,assertPayrollAttendance} from './payroll-attendance';
import {payrollBatchIndependent} from './payroll-review';
import {payrollStaff,payrollWriter,payrollReviewer,payrollRecordAccess} from './payroll-access';
import {scopedOrgs} from './authorization';
import {z} from 'zod';
import {HttpError} from './http';
import {orgWithin,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import type {Member} from './authorization';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(2000);
const item=z.object({name:text,category:z.enum(['earning','deduction','employer']),amountCents:z.number().int().min(0).max(1_000_000_000),source:evidence});
export const payrollCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('batch'),name:text,orgId:id,period:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),currency:z.literal('CNY'),policyReference:evidence}),
 z.object({action:z.literal('slip'),id:id.optional(),batchId:id,employeeId:id,attendancePeriodIds:z.array(id).max(31).optional(),items:z.array(item).min(1).max(40)}),
 z.object({action:z.literal('removeSlip'),id,reason:evidence}),
 z.object({action:z.literal('submit'),id,evidence}),
 z.object({action:z.literal('approve'),id,evidence}),
 z.object({action:z.literal('return'),id,evidence}),
 z.object({action:z.literal('publish'),id,evidence}),
 z.object({action:z.literal('cancel'),id,evidence}),
]);
export function payrollTotals(items:NonNullable<R['payload']['payItems']>){const sum=(category:string)=>items.filter(i=>i.category===category).reduce((n,i)=>n+i.amountCents,0);const grossCents=sum('earning'),deductionCents=sum('deduction'),employerCents=sum('employer');return {grossCents,deductionCents,netCents:grossCents-deductionCents,employerCents};}
export function applyPayroll(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=payrollCommand.parse(input);if(!payrollStaff(member))throw new HttpError(403,'没有薪酬管理权限');if(['approve','return'].includes(c.action)?!payrollReviewer(member):!payrollWriter(member))throw new HttpError(403,'当前薪酬角色无此操作权限');
 const fail=(s:string):never=>{throw new HttpError(400,s);},deny=(s:string):never=>{throw new HttpError(403,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!payrollRecordAccess(r,records,state,member))deny('薪酬记录不存在或没有此组织的权限');return r!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 const slips=(b:R)=>records.filter(r=>r.kind==='paySlip'&&r.referenceId===b.id&&r.status!=='cancelled');
 const independent=(b:R)=>{if(!payrollBatchIndependent(b,records,member))deny('复核须由未编制本批次且不领取本批次工资的其他薪酬复核人员完成');};
 if(c.action==='batch'){const org=state.orgs.find(o=>o.id===c.orgId);if(!org||!scopedOrgs(state,member).has(c.orgId))deny('没有此组织的薪酬权限');if(org!.status!=='启用')fail('请选择启用组织');if(records.some(r=>r.kind==='payBatch'&&r.payload.orgId===c.orgId&&r.payload.period===c.period&&r.status!=='cancelled'))fail('同组织同期间已有工资批次');return make('payBatch',{contributors:[member.userId],name:c.name,orgId:c.orgId,period:c.period,currency:c.currency,policyReference:c.policyReference});}
 if(c.action==='slip'){const b=get(c.batchId,'payBatch');if(b.status!=='draft')fail('仅草稿批次可编制明细');if(c.employeeId===member.employeeId)deny('不能编制本人工资条');const e=state.employees.find(e=>e.id===c.employeeId);if(!e||!orgWithin(state,e.orgId,b.payload.orgId!))fail('员工不在批次组织范围内');const old=c.id?get(c.id,'paySlip'):undefined;if(old&&(old.employeeId!==c.employeeId||old.referenceId!==b.id||old.status==='cancelled'))fail('不能改变工资条所属人员或批次');if(records.some(r=>r.kind==='paySlip'&&r.employeeId===c.employeeId&&r.status!=='cancelled'&&r.id!==c.id&&records.some(p=>p.id===r.referenceId&&p.kind==='payBatch'&&p.payload.period===b.payload.period&&p.status!=='cancelled')))fail('员工本期已存在工资条，请编辑现有记录');if(new Set(c.items.map(i=>i.name)).size!==c.items.length)fail('工资项目名称不得重复');const totals=payrollTotals(c.items);if(totals.netCents<0)fail('扣款不能超过应发工资');return make('paySlip',{payrollAttendance:freezePayrollAttendance(records,state,member,c.attendancePeriodIds??old?.payload.payrollAttendance?.map(p=>p.id)??[],c.employeeId,b.payload.period!),payItems:c.items,...totals,period:b.payload.period,currency:b.payload.currency,employeeSnapshot:{code:e!.code,name:e!.name,orgName:state.orgs.find(o=>o.id===e!.orgId)?.name??''},contributors:[...new Set([...(old?.payload.contributors??[]),member.userId])]},{employeeId:c.employeeId,referenceId:b.id,...(old?{id:old.id,createdBy:old.createdBy,createdAt:old.createdAt}:{})});}
 if(c.action==='removeSlip'){const r=get(c.id,'paySlip');if(get(r.referenceId!,'payBatch').status!=='draft'||r.status==='cancelled')fail('仅草稿明细可移除');return change(r,'cancelled',{closedReason:c.reason,contributors:[...new Set([r.createdBy,...(r.payload.contributors??[]),member.userId])]});}
 const b=get(c.id,'payBatch'),rows=slips(b);if(['submit','approve','publish'].includes(c.action))assertPayrollAttendance(rows,records);
 switch(c.action){
 case 'submit':{if(b.status!=='draft'||!rows.length)fail('批次须为非空草稿');const totals=rows.reduce((a,r)=>{const t=payrollTotals(r.payload.payItems!);return {grossCents:a.grossCents+t.grossCents,deductionCents:a.deductionCents+t.deductionCents,netCents:a.netCents+t.netCents,employerCents:a.employerCents+t.employerCents};},{grossCents:0,deductionCents:0,netCents:0,employerCents:0});return change(b,'submitted',{contributors:[...new Set([b.createdBy,...(b.payload.contributors??[]),...(b.payload.submittedBy?[b.payload.submittedBy]:[]),member.userId])],...totals,slipCount:rows.length,submittedBy:member.userId,submittedAt:at,evidence:c.evidence,approvedBy:undefined,approvedAt:undefined,verification:undefined});}
 case 'approve':{if(b.status!=='submitted')fail('仅待复核批次可批准');independent(b);return change(b,'approved',{approvedBy:member.userId,approvedAt:at,verification:c.evidence});}
 case 'return':{if(!['submitted','approved'].includes(b.status))fail('仅待复核或已批准批次可退回');independent(b);return change(b,'draft',{verification:c.evidence,approvedBy:undefined,approvedAt:undefined});}
 case 'publish':{if(b.status!=='approved')fail('须先完成独立复核');if(rows.some(r=>r.employeeId===member.employeeId))deny('不能发布包含本人工资的批次');return change(b,'published',{publishedBy:member.userId,publishedAt:at,evidence:c.evidence});}
 case 'cancel':{if(b.status!=='draft')fail('仅草稿批次可取消；已发布记录保留不变');return change(b,'cancelled',{closedReason:c.evidence});}
 default:return fail('不支持的薪酬操作');
 }
}
