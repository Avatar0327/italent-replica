import type {DevelopmentRecord as R} from './development';
import type {State} from './model';
import {businessDate} from './business-time';

// Resource versions remain distinct: embedded exams are course evidence;
// standalone exams have their own task and immutable attempt evidence.
export type LearningRequirement={id:string;kind:'course'|'exam'|'homework';resourceId:string};
export function courseRequirements(courseIds:string[],previous:LearningRequirement[]=[]):LearningRequirement[]{
 return courseIds.map(resourceId=>({id:previous.find(r=>r.kind==='course'&&r.resourceId===resourceId)?.id??`course:${resourceId}`,kind:'course',resourceId}));
}
export function resourceRequirements(courseIds:string[],examIds:string[],previous:LearningRequirement[]=[],homeworkIds:string[]=[]):LearningRequirement[]{return [...courseRequirements(courseIds,previous),...examIds.map(resourceId=>({id:previous.find(r=>r.kind==='exam'&&r.resourceId===resourceId)?.id??`exam:${resourceId}`,kind:'exam' as const,resourceId})),...homeworkIds.map(resourceId=>({id:previous.find(r=>r.kind==='homework'&&r.resourceId===resourceId)?.id??`homework:${resourceId}`,kind:'homework' as const,resourceId}))];}
export function learningRequirements(record:R):LearningRequirement[]{
 return record.payload.learningRequirements??resourceRequirements(record.payload.courseIds??[],record.payload.examIds??[],[],record.payload.homeworkIds??[]);
}
export function learningAssignmentCurrent(assignment:R,state:State){
 const employee=state.employees.find(e=>e.id===assignment.employeeId);
 return !!employee&&employee.status!=='离职'&&employee.orgId===assignment.payload.orgId&&state.orgs.some(o=>o.id===employee.orgId&&o.status==='启用');
}
export function learningRequirementProgress(assignment:R,records:R[]){
 const requirements=learningRequirements(assignment),courseIds=[...(assignment.payload.courseIds??[]),...(assignment.payload.examIds??[]),...(assignment.payload.homeworkIds??[])];
 const valid=requirements.length>0&&requirements.length===courseIds.length&&new Set(requirements.map(r=>r.id)).size===requirements.length&&new Set(requirements.map(r=>r.resourceId)).size===requirements.length&&requirements.every(r=>(r.kind==='course'?assignment.payload.courseIds:r.kind==='exam'?assignment.payload.examIds:r.kind==='homework'?assignment.payload.homeworkIds:[])?.includes(r.resourceId));
 const tasks=records.filter(r=>['enrollment','learningExamTask','homeworkTask'].includes(r.kind)&&r.payload.learningAssignmentId===assignment.id&&!r.payload.requirementRetiredAt);
 const items=requirements.map(requirement=>{
  const matches=tasks.filter(t=>t.referenceId===requirement.resourceId&&t.kind===(requirement.kind==='course'?'enrollment':requirement.kind==='exam'?'learningExamTask':'homeworkTask'));
  const task=matches.length===1?matches[0]:undefined;
  const bound=!!task&&task.employeeId===assignment.employeeId&&(!task.payload.learningRequirementId||task.payload.learningRequirementId===requirement.id);
  const attempt=bound&&requirement.kind==='exam'?records.find(a=>a.kind==='learningExamAttempt'&&a.referenceId===task.id&&a.employeeId===assignment.employeeId&&a.payload.examId===requirement.resourceId&&a.payload.passed&&Number.isFinite(a.payload.score)&&a.payload.score!>=task.payload.passingScore!):undefined;
  const submission=bound&&requirement.kind==='homework'?records.find(a=>a.kind==='homeworkSubmission'&&a.id===task.payload.submissionId&&a.referenceId===task.id&&a.employeeId===assignment.employeeId&&a.status==='passed'&&a.payload.passed===true&&a.payload.verifiedBy===task.payload.verifiedBy&&a.payload.verifiedAt===task.payload.verifiedAt):undefined;
  const complete=bound&&task.status==='completed'&&(requirement.kind==='exam'?!!attempt:requirement.kind==='homework'?!!submission&&!!task.payload.verifiedBy&&!!task.payload.verifiedAt:!!task.payload.verifiedBy&&!!task.payload.verifiedAt);
  return {kind:requirement.kind,attemptId:attempt?.id??null,requirementId:requirement.id,resourceId:requirement.resourceId,taskId:bound?task.id:null,complete,verifiedBy:complete?task.payload.verifiedBy:null,verifiedAt:complete?task.payload.verifiedAt:null,sourceEnrollmentId:complete?task.payload.sourceEnrollmentId??null:null};
 });
 const stages=(assignment.payload.trainingStages??[]).map(stage=>{
  const optional=new Set(stage.optionalCourseIds??[]),required=stage.courseIds.filter(id=>!optional.has(id));
  const done=(ids:string[])=>ids.filter(id=>items.some(i=>i.resourceId===id&&i.complete)).length;
  const requiredMinimum=stage.requiredMinimum??required.length,optionalMinimum=stage.optionalMinimum??optional.size;
  return {title:stage.title,courseIds:stage.courseIds,required:done(required),optional:done([...optional]),requiredMinimum,optionalMinimum,complete:done(required)>=requiredMinimum&&done([...optional])>=optionalMinimum};
 });
 return {items,stages,total:requirements.length,completed:items.filter(i=>i.complete).length,complete:valid&&tasks.length===requirements.length&&(stages.length?stages.every(s=>s.complete):items.every(i=>i.complete))};
}
export function learningStageStartsOn(assignment:R,stage:NonNullable<R['payload']['trainingStages']>[number]){
 const origin=assignment.payload.learningMode?.mode==='fixed'?assignment.payload.learningMode.start:assignment.payload.learningMode?.mode==='recurring'&&assignment.payload.previousAssignmentId?assignment.payload.start!:businessDate(assignment.createdAt),date=new Date(origin+'T00:00:00Z');
 date.setUTCDate(date.getUTCDate()+(stage.startAfterDays??0));
 const scheduled=date.toISOString().slice(0,10);
 return assignment.payload.start&&assignment.payload.start>scheduled?assignment.payload.start:scheduled;
}
export function learningStageOpen(task:R,records:R[],at=new Date().toISOString(),state?:State){
 if(task.payload.requirementRetiredAt)return false;
 if(!task.payload.learningAssignmentId)return true;
 const assignment=records.find(r=>r.kind==='learningAssignment'&&r.id===task.payload.learningAssignmentId);
 if(!assignment||assignment.status!=='active'||!learningRequirements(assignment).some(r=>r.resourceId===task.referenceId&&(!task.payload.learningRequirementId||r.id===task.payload.learningRequirementId)))return false;
 if(state&&!learningAssignmentCurrent(assignment,state))return false;
 if(!assignment.payload.trainingStages?.length)return true;
 const stage=assignment.payload.trainingStages.find(s=>s.courseIds.includes(task.referenceId!));
 if(!stage||businessDate(at)<learningStageStartsOn(assignment,stage))return false;
 const progress=learningRequirementProgress(assignment,records);
 if(assignment.payload.learningMode?.orderedStages){
  const index=progress.stages.findIndex(s=>s.courseIds.includes(task.referenceId!));
  if(index<0||!progress.stages.slice(0,index).every(s=>s.complete))return false;
 }
 if(!stage.orderedTasks)return true;
 const index=stage.courseIds.indexOf(task.referenceId!);
 return index>=0&&stage.courseIds.slice(0,index).every(resourceId=>{
  const item=progress.items.find(i=>i.resourceId===resourceId);
  if(item?.complete)return true;
  if(item?.kind==='homework'&&stage.homeworkSubmissionUnlock&&item.taskId){const predecessor=records.find(r=>r.id===item.taskId);return !!predecessor&&['active','submitted','returned','completed'].includes(predecessor.status)&&records.some(s=>s.kind==='homeworkSubmission'&&s.referenceId===item.taskId&&s.employeeId===assignment.employeeId&&!!s.payload.submissionVersion);}
  if(!stage.examSubmissionUnlock||item?.kind!=='exam'||!item.taskId)return false;
  const predecessor=records.find(r=>r.id===item.taskId);
  if(!predecessor||!['active','failed','completed'].includes(predecessor.status))return false;
  return records.some(a=>a.kind==='learningExamAttempt'&&a.referenceId===item.taskId&&a.employeeId===assignment.employeeId&&a.payload.examId===resourceId&&Number.isFinite(a.payload.score)&&a.payload.score!>=0&&a.payload.score!<=100);
 });
}


/** Explicit local calendar policy: scheduled start counts as day one; prerequisites do not reset it. */
export function learningStageDeadline(assignment:R,stage:NonNullable<R['payload']['trainingStages']>[number]):string|null{
 if(!stage.deadline)return null;const date=new Date(learningStageStartsOn(assignment,stage)+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+stage.deadline.days-1);return date.toISOString().slice(0,10);
}
export function learningStageSubmissionOpen(task:R,records:R[],at=new Date().toISOString()){
 if(!task.payload.learningAssignmentId)return true;const assignment=records.find(r=>r.kind==='learningAssignment'&&r.id===task.payload.learningAssignmentId);if(!assignment)return false;const stage=assignment.payload.trainingStages?.find(s=>s.courseIds.includes(task.referenceId!));if(!stage?.deadline||stage.deadline.allowOverdue)return true;return businessDate(at)<=learningStageDeadline(assignment,stage)!;
}
export function expiredIncompleteLearningStages(assignment:R,records:R[],at=new Date().toISOString()){
 const progress=learningRequirementProgress(assignment,records);return (assignment.payload.trainingStages??[]).filter((s,i)=>s.deadline&&!s.deadline.allowOverdue&&businessDate(at)>learningStageDeadline(assignment,s)!&&!progress.stages[i]?.complete).map(s=>s.title);
}
export function learningTaskStageDeadline(task:R,records:R[]){
 const assignment=records.find(r=>r.kind==='learningAssignment'&&r.id===task.payload.learningAssignmentId),stage=assignment?.payload.trainingStages?.find(s=>s.courseIds.includes(task.referenceId!));return assignment&&stage?learningStageDeadline(assignment,stage):null;
}

export function learningTaskDisplayDue(task:R,records:R[]){const stageDue=learningTaskStageDeadline(task,records),planDue=task.payload.due;return stageDue&&planDue?(stageDue<planDue?stageDue:planDue):stageDue??planDue??'';}
