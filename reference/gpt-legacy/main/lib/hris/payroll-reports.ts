import {payrollAttendanceIssues} from './payroll-attendance';
import {scopedOrgs} from './authorization';
import type {DevelopmentRecord as R} from './development';
import type {DevelopmentContext} from './development-repository';
import {payrollStaff} from './payroll-access';
import {payrollTotals} from './payroll';
import {HttpError} from './http';
import type {Cell} from './reports';

export function payrollReport(ctx:DevelopmentContext,dataset:'payrollOperations'|'payrollReconciliation'|'payrollAttendanceReferences'){
 if(!payrollStaff(ctx.member))throw new HttpError(403,'仅薪酬岗位可查看薪酬管理报表');
 // Use managed records only: an employee's own masked slip is not a management grant.
 const scope=scopedOrgs(ctx.state,ctx.member),batches=ctx.records.filter(r=>r.kind==='payBatch'&&(ctx.member.role==='admin'||scope.has(r.payload.orgId!))),batchById=new Map(batches.map(b=>[b.id,b]));
 const slips=ctx.records.filter(r=>r.kind==='paySlip'&&r.status!=='cancelled'&&batchById.has(r.referenceId!)),slipIds=new Set(slips.map(s=>s.id)),slipsByBatch=new Map<string,R[]>(),adjustmentsBySlip=new Map<string,R[]>(),orgNames=new Map(ctx.state.orgs.map(o=>[o.id,o.name]));
 for(const s of slips){const group=slipsByBatch.get(s.referenceId!)??[];group.push(s);slipsByBatch.set(s.referenceId!,group);}
 if(dataset==='payrollReconciliation')for(const a of ctx.records){if(a.kind==='payAdjustment'&&a.status==='published'&&slipIds.has(a.referenceId!)){const group=adjustmentsBySlip.get(a.referenceId!)??[];group.push(a);adjustmentsBySlip.set(a.referenceId!,group);}}
 const statuses:Record<string,string>={draft:'草稿',submitted:'待复核',approved:'已批准待发布',published:'已发布',cancelled:'已取消'};
 const keys=['grossCents','deductionCents','netCents','employerCents'] as const;
 const sum=(values:ReturnType<typeof payrollTotals>[])=>keys.map(k=>values.reduce((n,v)=>{const total=n+v[k];if(!Number.isSafeInteger(total))throw new HttpError(400,'汇总金额超出安全整数范围，请缩小业务范围');return total;},0));
 if(dataset==='payrollAttendanceReferences'){
  const rows:Cell[][]=slips.flatMap(s=>(s.payload.payrollAttendance??[]).map(p=>{const current=ctx.records.find(r=>r.kind==='attendancePeriod'&&r.id===p.id);return [batchById.get(s.referenceId!)!.id,s.id,s.payload.period??'',s.payload.employeeSnapshot?.code??'',s.payload.employeeSnapshot?.name??'',statuses[batchById.get(s.referenceId!)!.status]??'',p.id,p.start,p.end,p.version,current?.payload.version??null,current?.status??'不可用',payrollAttendanceIssues({...s,payload:{...s.payload,payrollAttendance:[p]}},ctx.records).length?'来源已变化':'引用一致',p.plannedMinutes,p.approvedLeaveMinutes,p.uncoveredMinutes];}));
  return {title:'可见范围工资考勤引用核对',columns:['批次编号','工资条编号','计薪月份','工号快照','姓名快照','批次状态','考勤期间编号','开始业务日','结束业务日','引用冻结版本','当前冻结版本','当前期间状态','一致性','引用计划分钟','引用批准请假分钟','引用未覆盖分钟'],rows};
 }
 if(dataset==='payrollOperations'){
  const rows:Cell[][]=batches.map(b=>{const active=slipsByBatch.get(b.id)??[];return [b.id,b.payload.name??'',b.payload.period??'',orgNames.get(b.payload.orgId!)??'',statuses[b.status]??b.status,active.length,...sum(active.map(s=>payrollTotals(s.payload.payItems??[])))];});
  return {title:'可见范围薪酬批次办理',columns:['批次编号','批次名称','期间','批次组织','状态','有效明细数','明细应发（分）','明细扣款（分）','明细净额（分）','单位承担（分）'],rows};
 }
 const rows:Cell[][]=slips.filter(s=>batchById.get(s.referenceId!)?.status==='published').map(s=>{
  const b=batchById.get(s.referenceId!)!,adjustments=adjustmentsBySlip.get(s.id)??[],adjustmentTotals=adjustments.map(a=>payrollTotals(a.payload.payItems??[]));
  const original=payrollTotals(s.payload.payItems??[]),delta=sum(adjustmentTotals),total=sum([original,...adjustmentTotals]),snapshot=s.payload.employeeSnapshot;
  return [b.id,s.id,b.payload.period??'',snapshot?.code??'',snapshot?.name??'',snapshot?.orgName??'',...keys.map(k=>original[k]),adjustments.length,...delta,...total];
 });
 return {title:'可见范围已发布工资对账',columns:['批次编号','工资条编号','期间','工号快照','姓名快照','组织快照','原应发（分）','原扣款（分）','原净额（分）','原单位承担（分）','已发布补差数','补差应发（分）','补差扣款（分）','补差净额（分）','补差单位承担（分）','对账应发（分）','对账扣款（分）','对账净额（分）','对账单位承担（分）'],rows};
}
