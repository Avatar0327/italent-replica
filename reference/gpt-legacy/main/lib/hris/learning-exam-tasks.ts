import {scoreObjectiveExam} from './learning-objective-exams';
import {z} from 'zod';
import {scopedOrgs,type Member} from './authorization';
import type {DevelopmentRecord as R} from './development';
import type {State} from './model';
import {businessDate} from './business-time';
import {learningStageSubmissionOpen,learningAssignmentCurrent,learningRequirements,learningStageOpen} from './learning-requirements';
import {HttpError} from './http';
const id=z.string().min(1).max(100),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('assign'),assignmentId:id.optional(),examId:id,employeeId:id,start:date,due:date}).strict(),
 z.object({action:z.literal('submit'),id,answers:z.array(z.union([z.number().int().min(0).max(5),z.array(z.number().int().min(0).max(5)).min(1).max(6)])).min(1).max(20)}).strict(),
 z.object({action:z.literal('cancel'),id,evidence:z.string().trim().min(5).max(3000)}).strict(),
]);
export function examTaskOpen(task:R,state:State,at=new Date().toISOString()){
 return !task.payload.requirementRetiredAt&&task.status==='active'&&learningAssignmentCurrent(task,state)&&businessDate(at)>=task.payload.start!&&(!!task.payload.assignmentAllowOverdue||businessDate(at)<=task.payload.due!);
}
export function applyLearningExamTask(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R[]{
 const c=schema.parse(input),scope=scopedOrgs(state,m),manage=['admin','hr'].includes(m.role);
 const deny=():never=>{throw new HttpError(403,'没有此独立考试任务的办理权限');};
 const fail=(message:string):never=>{throw new HttpError(400,message);};
 if(c.action==='assign'){
  const exam=records.find(r=>r.kind==='learningExamDefinition'&&r.id===c.examId),employee=state.employees.find(e=>e.id===c.employeeId);
  if(!manage||!exam||!employee||!scope.has(exam.payload.orgId!)||!scope.has(employee.orgId)||employee.orgId!==exam.payload.orgId)deny();
  if(exam!.status!=='sealed'||employee!.status==='离职'||!state.orgs.some(o=>o.id===employee!.orgId&&o.status==='启用'))fail('须为定版试卷和启用组织的在职员工');
  if(c.due<c.start||c.due<businessDate(at))fail('考试起止日期无效');
  const assignment=c.assignmentId?records.find(r=>r.kind==='learningAssignment'&&r.id===c.assignmentId):undefined;
  if(c.assignmentId&&(!assignment||assignment.status!=='active'||assignment.employeeId!==c.employeeId||assignment.payload.orgId!==exam!.payload.orgId||!assignment.payload.examIds?.includes(c.examId)||assignment.payload.start!==c.start||assignment.payload.due!==c.due))fail('学习实例、人员、试卷或日期不匹配');
  if(records.some(r=>r.kind==='learningExamTask'&&r.referenceId===exam!.id&&r.employeeId===employee!.id&&r.payload.learningAssignmentId===c.assignmentId))fail('此员工已有该试卷版本的独立考试任务');
  return [{id:crypto.randomUUID(),kind:'learningExamTask',employeeId:c.employeeId,positionId:null,referenceId:c.examId,status:'active',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...(assignment?{learningAssignmentId:assignment.id,learningRequirementId:learningRequirements(assignment).find(r=>r.kind==='exam'&&r.resourceId===c.examId)?.id,assignmentAllowOverdue:assignment.payload.learningMode?.mode!=='fixed'&&assignment.payload.learningMode?.allowOverdue}:{}),title:exam!.payload.title,orgId:employee!.orgId,start:c.start,due:c.due,version:exam!.payload.version,passingScore:exam!.payload.passingScore,maxAttempts:exam!.payload.maxAttempts}}];
 }
 const task=records.find(r=>r.kind==='learningExamTask'&&r.id===c.id),employee=state.employees.find(e=>e.id===task?.employeeId);
 if(!task||!employee)deny();
 if(c.action==='cancel'){
  if(!manage||!scope.has(task!.payload.orgId!)||!scope.has(employee!.orgId))deny();
  if(task!.payload.requirementRetiredAt)fail('此任务已退出计划要求，保留历史且不能继续办理');
  if(task!.status!=='active')fail('仅进行中的考试可取消');
  return [{...task!,status:'cancelled',updatedAt:at,payload:{...task!.payload,closedReason:c.evidence}}];
 }
 if(m.employeeId!==task!.employeeId)deny();
 if(!examTaskOpen(task!,state,at)||!learningStageSubmissionOpen(task!,records,at)||!learningStageOpen(task!,records,at,state))fail('考试已关闭、尚未开始、已过期或人员组织状态已变化');
 const exam=records.find(r=>r.kind==='learningExamDefinition'&&r.id===task!.referenceId);
 if(!exam||!['sealed','archived'].includes(exam.status))fail('试卷版本不可用');
 const attempts=records.filter(r=>r.kind==='learningExamAttempt'&&r.referenceId===task!.id);
 if(attempts.some(r=>r.payload.passed)||attempts.length>=task!.payload.maxAttempts!)fail('已通过或达到作答次数上限');
 const result=scoreObjectiveExam(exam!,c.answers),score=result.score,passed=result.earnedPoints*100>=task!.payload.passingScore!*result.maxPoints;
 const attempt:R={id:crypto.randomUUID(),kind:'learningExamAttempt',employeeId:task!.employeeId,positionId:null,referenceId:task!.id,status:passed?'passed':'failed',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{answers:c.answers.every(a=>typeof a==='number')?c.answers as number[]:undefined,objectiveAnswers:result.answers,earnedPoints:result.earnedPoints,maxPoints:result.maxPoints,score,passed,examId:exam!.id,orgId:task!.payload.orgId}};
 return [attempt,{...task!,status:passed?'completed':attempts.length+1>=task!.payload.maxAttempts!?'failed':'active',updatedAt:at,payload:{...task!.payload,earnedPoints:result.earnedPoints,maxPoints:result.maxPoints,score,passed}}];
}
