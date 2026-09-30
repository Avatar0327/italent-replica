import {scopedOrgs,type Member} from './authorization';
import type {DevelopmentRecord as R} from './development';
import type {State} from './model';
export const payrollStaff=(m:Member)=>['admin','payroll_editor','payroll_reviewer'].includes(m.role);
export const payrollWriter=(m:Member)=>['admin','payroll_editor'].includes(m.role);
export const payrollReviewer=(m:Member)=>['admin','payroll_reviewer'].includes(m.role);
export function payrollRecordAccess(r:R,records:R[],state:State,m:Member){
 if(m.role==='admin')return true;if(!payrollStaff(m))return false;
 const slip=['payAdjustment','payQuery'].includes(r.kind)?records.find(x=>x.id===r.referenceId&&x.kind==='paySlip'):null;
 const batch=r.kind==='payBatch'?r:records.find(x=>x.id===(slip?.referenceId??r.referenceId)&&x.kind==='payBatch');
 return !!batch&&scopedOrgs(state,m).has(batch.payload.orgId!);
}
export function payrollRoster(state:State,m:Member){const scope=scopedOrgs(state,m);return {employees:payrollStaff(m)?state.employees.filter(e=>scope.has(e.orgId)).map(({id,name,code,orgId})=>({id,name,code,orgId})):[],orgs:payrollStaff(m)?state.orgs.filter(o=>scope.has(o.id)).map(({id,name,status})=>({id,name,status})):[]};}
