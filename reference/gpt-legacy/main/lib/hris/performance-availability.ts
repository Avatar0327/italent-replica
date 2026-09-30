import {orgWithin,visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import type {Member} from './authorization';
// Lifecycle eligibility only; each command retains its own role and state checks.
export function performancePlanLive(state:State,records:R[],p:R|undefined):boolean{
 if(!p||p.kind!=='performancePlan'||p.status==='cancelled')return false;
 const e=state.employees.find(e=>e.id===p.employeeId),c=records.find(c=>c.id===p.referenceId&&c.kind==='performanceCycle');
 return !!e&&e.status!=='离职'&&c?.status==='active'&&!!c.payload.orgId&&orgWithin(state,e.orgId,c.payload.orgId)&&!records.some(r=>r.kind==='performance'&&r.payload.sourcePlanId===p.id);
}
export function livePerformancePlanIds(state:State,records:R[],member:Member):string[]{return records.filter(p=>performancePlanLive(state,records,p)&&visibleRecord(p,records,state,member)).map(p=>p.id);}
