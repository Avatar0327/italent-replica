import type {DevelopmentRecord as R} from './development';
import type {State} from './model';
import {scopedOrgs,type Member} from './authorization';
import {payrollStaff} from './payroll-access';
import {HttpError} from './http';
export type PayrollAttendanceInput={id:string;employeeId:string;version:number;updatedAt:string;start:string;end:string;sourceRevision:number;plannedMinutes:number;approvedLeaveMinutes:number;uncoveredMinutes:number};
export function payrollAttendanceSources(records:R[],state:State,member:Member):PayrollAttendanceInput[]{
 if(!payrollStaff(member))return [];const scope=scopedOrgs(state,member);return records.filter(r=>r.kind==='attendancePeriod'&&r.status==='frozen'&&state.employees.some(e=>e.id===r.employeeId&&scope.has(e.orgId))&&r.payload.attendanceSnapshot?.totals.uncoveredMinutes===0).map(r=>({id:r.id,employeeId:r.employeeId!,version:r.payload.version!,updatedAt:r.updatedAt,start:r.payload.start!,end:r.payload.end!,sourceRevision:r.payload.attendanceSnapshot!.sourceRevision,...r.payload.attendanceSnapshot!.totals,uncoveredMinutes:0}));
}
export function freezePayrollAttendance(records:R[],state:State,member:Member,ids:string[],employeeId:string,period:string){
 if(new Set(ids).size!==ids.length)throw new HttpError(400,'考勤期间引用不能重复');const allowed=payrollAttendanceSources(records,state,member),sources=ids.map(id=>{const p=allowed.find(p=>p.id===id&&p.employeeId===employeeId);if(!p)throw new HttpError(403,'考勤来源不存在、已开放或不在当前人员权限内');if(p.start.slice(0,7)!==period||p.end.slice(0,7)!==period)throw new HttpError(400,'首批考勤引用须完整位于计薪月份内');return p;});for(let i=0;i<sources.length;i++)for(let j=i+1;j<sources.length;j++)if(sources[i].start<=sources[j].end&&sources[i].end>=sources[j].start)throw new HttpError(400,'考勤来源期间不能重叠');return sources;
}
export function payrollAttendanceIssues(slip:R,records:R[]){return (slip.payload.payrollAttendance??[]).flatMap(p=>{const current=records.find(r=>r.kind==='attendancePeriod'&&r.id===p.id);return !current||current.status!=='frozen'||current.employeeId!==slip.employeeId||current.payload.version!==p.version||current.updatedAt!==p.updatedAt?[`考勤期间 ${p.start}—${p.end} 已变化，请退回编制后重新核验来源`]:[];});}
export function assertPayrollAttendance(rows:R[],records:R[]){if(rows.some(s=>payrollAttendanceIssues(s,records).length))throw new HttpError(409,'工资条引用的考勤来源已变化，请退回编制并重新核验；不能沿用旧复核发布');}
