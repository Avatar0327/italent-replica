import type {DevelopmentRecord as R} from './development';
import type {LearningRequirement} from './learning-requirements';
export function examGradeAttempts(assignment:R,records:R[],requirement:LearningRequirement|undefined,include:'all'|'passed'){
 if(!requirement||requirement.kind!=='exam'||!assignment.payload.examIds?.includes(requirement.resourceId))return [];
 const tasks=records.filter(r=>r.kind==='learningExamTask'&&!r.payload.requirementRetiredAt&&r.payload.learningAssignmentId===assignment.id&&r.employeeId===assignment.employeeId&&r.referenceId===requirement.resourceId&&r.payload.learningRequirementId===requirement.id);
 return tasks.length===1?records.filter(r=>r.kind==='learningExamAttempt'&&r.referenceId===tasks[0].id&&r.employeeId===assignment.employeeId&&r.payload.examId===requirement.resourceId&&Number.isFinite(r.payload.score)&&r.payload.score!>=0&&r.payload.score!<=100&&(include==='all'||r.payload.passed===true)):[];
}
export function homeworkGradeEvidence(assignment:R,records:R[],requirement:LearningRequirement|undefined,include:'all'|'passed'){
 if(!requirement||requirement.kind!=='homework'||!assignment.payload.homeworkIds?.includes(requirement.resourceId))return undefined;
 const tasks=records.filter(r=>r.kind==='homeworkTask'&&!r.payload.requirementRetiredAt&&r.payload.learningAssignmentId===assignment.id&&r.employeeId===assignment.employeeId&&r.referenceId===requirement.resourceId&&r.payload.learningRequirementId===requirement.id);
 if(tasks.length!==1)return undefined;const task=tasks[0];
 return records.find(r=>r.kind==='homeworkSubmission'&&r.id===task.payload.submissionId&&r.referenceId===task.id&&r.employeeId===assignment.employeeId&&['returned','passed'].includes(r.status)&&!!r.payload.verifiedBy&&!!r.payload.verifiedAt&&r.payload.verifiedBy===task.payload.verifiedBy&&r.payload.verifiedAt===task.payload.verifiedAt&&Number.isFinite(r.payload.score)&&r.payload.score!>=0&&r.payload.score!<=100&&(include==='all'||r.payload.passed===true));
}
