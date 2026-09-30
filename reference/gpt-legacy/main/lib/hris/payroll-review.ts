import type {DevelopmentRecord as R} from './development';
import type {Member} from './authorization';
/** Removing a line or resubmitting a batch does not erase prior participation. */
export function payrollBatchIndependent(batch:R,records:R[],member:Pick<Member,'userId'|'employeeId'>){
 if(batch.createdBy===member.userId||batch.payload.submittedBy===member.userId||batch.payload.contributors?.includes(member.userId))return false;
 return !records.some(r=>r.kind==='paySlip'&&r.referenceId===batch.id&&(r.createdBy===member.userId||r.payload.contributors?.includes(member.userId)||r.status!=='cancelled'&&r.employeeId===member.employeeId));
}
