import type {DevelopmentRecord as R} from './development';
import {HttpError} from './http';
export function attendanceShiftFrozen(records:R[],shift:R){return records.some(r=>r.kind==='attendancePeriod'&&r.employeeId===shift.employeeId&&r.status==='frozen'&&r.payload.start!<=shift.payload.date!&&r.payload.end!>=shift.payload.date!);}
export function assertAttendanceUnlocked(records:R[],change:R){
 const shift=change.kind==='shift'?change:['clock','correction','leave'].includes(change.kind)?records.find(r=>r.kind==='shift'&&r.id===change.referenceId):undefined;
 if(!shift)return;
 if(attendanceShiftFrozen(records,shift))throw new HttpError(409,'该员工考勤期间已冻结，请先由HR记录原因重新开放');
}
