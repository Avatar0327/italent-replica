import type {Approval,Employee,State} from './model';
import type {Member} from './authorization';

export type TransferSnapshot={orgId:string;orgName:string;positionId:string|null;job:string;gradeId:string|null;level:string;status:string};
export type ApprovalDetails={intent?:'independent'|'correction';previousApprovalId?:string;rejectionReason?:string;transfer?:{
 sourceAssignmentId?:string;sourceAssignmentVersion?:number;exitFenceObserved?:string|null;policy:'two-party-dated-v1';gradeChanged:boolean;effectiveOn:string;eligibleAt:string;employeeName:string;employeeCode:string;
 source:TransferSnapshot;target:TransferSnapshot;
 execution:'waiting'|'failed'|'applied'|'cancelled';attempts:number;lastAttemptAt?:string;failure?:string;appliedAt?:string;appliedBy?:string;cancelledAt?:string;cancelReason?:string;
}};
export function transferSnapshot(state:State,e:Employee):TransferSnapshot{return {orgId:e.orgId,orgName:state.orgs.find(o=>o.id===e.orgId)?.name??'',positionId:e.positionId??null,job:e.job,gradeId:e.gradeId??null,level:e.level,status:e.status};}
export function transferChangesGrade(a:Approval){const t=a.details?.transfer;return !!t&&(t.gradeChanged||t.source.gradeId!==t.target.gradeId||t.source.level!==t.target.level);}
export function transferSourceMatches(a:Approval,e:Employee){const t=a.details?.transfer;return !!t&&e.orgId===t.source.orgId&&(e.positionId??null)===t.source.positionId&&(e.gradeId??null)===t.source.gradeId&&e.job===t.source.job&&e.level===t.source.level&&e.status===t.source.status;}
export function transferAwaitingExecution(a:Approval){return a.status==='approved'&&!!a.details?.transfer&&['waiting','failed'].includes(a.details.transfer.execution);}
export function canReadTransferCase(a:Approval,m:Member,scope:Set<string>){
 const t=a.details?.transfer;if(!t||!['admin','manager','approver'].includes(m.role))return false;
 return !!a.steps?.some((step,i)=>step.userId===m.userId&&(m.role==='admin'||scope.has(i===0?t.source.orgId:t.target.orgId)));
}
export function projectApprovalDetails(a:Approval,m:Member):Approval{
 if(m.role==='admin'||m.viewLevel)return a;
 const t=a.details?.transfer;
 return {...a,gradeId:null,...(t?{details:{...a.details,transfer:{...t,source:{...t.source,gradeId:null,level:''},target:{...t.target,gradeId:null,level:''}}}}:{})};
}
