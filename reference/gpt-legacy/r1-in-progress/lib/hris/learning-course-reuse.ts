import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import type {Member} from './authorization';
/** Reuse original completed evidence only; never clone attempts or credit entries. */
export function reuseCompletedCourse(task:R,records:R[],state:State,m:Member,enabled:boolean):R{
 if(!enabled)return task;
 const source=records.filter(r=>r.kind==='enrollment'&&r.employeeId===task.employeeId&&r.referenceId===task.referenceId&&r.status==='completed'&&r.payload.verifiedBy&&r.payload.verifiedAt&&!r.payload.sourceEnrollmentId&&visibleRecord(r,records,state,m)&&(!r.payload.examId||records.some(a=>a.kind==='attempt'&&a.referenceId===r.id&&a.payload.passed))).sort((a,b)=>(b.payload.verifiedAt??'').localeCompare(a.payload.verifiedAt??'')||a.id.localeCompare(b.id))[0];
 const sourceExam=source?.payload.examId?records.find(a=>a.kind==='attempt'&&a.referenceId===source.id&&a.payload.passed):undefined;
 return source?{...task,status:'completed',payload:{...task.payload,sourceEnrollmentId:source.id,sourceVerifiedBy:source.payload.verifiedBy,sourceVerifiedAt:source.payload.verifiedAt,sourceExamAttemptId:sourceExam?.id,verifiedBy:source.payload.verifiedBy,verifiedAt:source.payload.verifiedAt,verification:'引用同员工同课程版本已独立核验的完成记录；未创建本次考试记录'}}:task;
}
