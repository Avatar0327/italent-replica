import {reuseCompletedCourse} from './learning-course-reuse';
import {applyHomework} from './learning-homework';
import {applyLearningExamTask} from './learning-exam-tasks';
import {expiredIncompleteLearningStages,learningRequirements,learningRequirementProgress,learningAssignmentCurrent,learningStageStartsOn} from './learning-requirements';
import {z} from 'zod';
import {applyDevelopment,visibleRecord,type DevelopmentRecord as R} from './development';
import {learningWindow,learningAssignmentKey} from './learning-plan-model';
import {businessDate} from './business-time';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('assign'),definitionId:id,employeeId:id,homeworkReviewers:z.record(id,id).optional()}).strict(),
 z.object({action:z.literal('nextRound'),id,start:date,homeworkReviewers:z.record(id,id).optional()}).strict(),
 z.object({action:z.literal('closeAssignment'),id}).strict(),
 z.object({action:z.literal('cancelAssignment'),id,evidence:z.string().trim().min(5).max(3000)}).strict(),
 z.object({action:z.literal('restoreAssignment'),id,evidence:z.string().trim().min(5).max(3000)}).strict(),
]);
export function applyLearningAssignment(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R[]{
 const c=command.parse(input),scope=scopedOrgs(state,m);
 const deny=():never=>{throw new HttpError(403,'没有此员工学习实例的管理权限');};
 const fail=(text:string):never=>{throw new HttpError(400,text);};
 if(!['admin','hr'].includes(m.role))deny();
 if(c.action!=='assign'&&c.action!=='nextRound'){
  const r=records.find(r=>r.kind==='learningAssignment'&&r.id===c.id);
  if(!r||!visibleRecord(r,records,state,m)||!scope.has(r.payload.orgId!))deny();
  const tasks=records.filter(t=>['enrollment','learningExamTask','homeworkTask'].includes(t.kind)&&t.payload.learningAssignmentId===r!.id&&!t.payload.requirementRetiredAt);
  if(c.action==='cancelAssignment'){
   if(r!.status!=='active')fail('仅进行中的实例可以取消');
   return [{...r!,status:'cancelled',updatedAt:at,payload:{...r!.payload,evidence:c.evidence}},...tasks.filter(t=>t.status!=='completed').map(t=>({...t,status:'cancelled',updatedAt:at,payload:{...t.payload,closedReason:c.evidence,assignmentCancelled:true,assignmentPreviousStatus:t.status}}))];
  }
  if(c.action==='restoreAssignment'){
   if(r!.status!=='cancelled')fail('仅已取消实例可整体恢复');
   const employee=state.employees.find(e=>e.id===r!.employeeId);
   if(!employee||employee.status==='离职'||employee.orgId!==r!.payload.orgId||!state.orgs.some(o=>o.id===employee.orgId&&o.status==='启用'))fail('恢复须为原组织在职员工');
   const config=r!.payload.learningMode!;
   if((config.mode==='fixed'||!config.allowOverdue)&&businessDate(at)>r!.payload.due!)fail('实例已超过允许学习期限，不能恢复');
   for(const task of tasks.filter(t=>t.payload.assignmentCancelled&&t.payload.assignmentPreviousStatus!=='cancelled'))if(!records.some(resource=>resource.id===task.referenceId&&(task.kind==='enrollment'?resource.kind==='course'&&resource.status==='published':task.kind==='homeworkTask'?resource.kind==='homeworkDefinition'&&['sealed','archived'].includes(resource.status):resource.kind==='learningExamDefinition'&&['sealed','archived'].includes(resource.status))))fail('恢复任务的内容版本须仍可用');
   return [{...r!,status:'active',updatedAt:at,payload:{...r!.payload,evidence:c.evidence}},...tasks.filter(t=>t.payload.assignmentCancelled).map(t=>({...t,status:t.payload.assignmentPreviousStatus==='cancelled'?'cancelled':t.payload.assignmentPreviousStatus==='failed'?'failed':t.kind==='homeworkTask'&&['submitted','returned'].includes(t.payload.assignmentPreviousStatus??'')?t.payload.assignmentPreviousStatus!:'active',updatedAt:at,payload:{...t.payload,assignmentCancelled:false,restorationEvidence:c.evidence}}))];
  }
  if(!learningAssignmentCurrent(r!,state))fail('仅原启用组织的在职员工可推进实例结项，历史记录保留');
  if(r!.status!=='active')fail('仅进行中的实例可结项');if(businessDate(at)<r!.payload.start!)fail('计划尚未开始，不能提前结项');
  if(r!.payload.trainingStages?.some(stage=>businessDate(at)<learningStageStartsOn(r!,stage)))fail('尚有未到开放日期的阶段，不能提前结项');
  if(!learningRequirementProgress(r!,records).complete)fail('须达到所有阶段的独立核验门槛后结项，取消任务不视为完成');
  return [{...r!,status:'completed',updatedAt:at},...tasks.filter(t=>t.status!=='completed'&&t.status!=='cancelled').map(t=>({...t,status:'cancelled',updatedAt:at,payload:{...t.payload,closedReason:'实例已达到各阶段完成门槛并结项，未完成任务关闭；不授予完成记录或学分'}}))];
 }
 const previous=c.action==='nextRound'?records.find(r=>r.id===c.id&&r.kind==='learningAssignment'):undefined;
 if(c.action==='nextRound'){
  if(!previous||!visibleRecord(previous,records,state,m)||!scope.has(previous.payload.orgId!))deny();
  if(previous!.status!=='completed'||previous!.payload.learningMode?.mode!=='recurring')fail('仅已结项的循环实例可显式安排下一轮');
  if(c.start<businessDate(at)||c.start<businessDate(previous!.updatedAt))fail('下一轮开始日不得早于今天或上轮完成日');
  if(records.some(r=>r.kind==='learningAssignment'&&r.referenceId===previous!.referenceId&&r.employeeId===previous!.employeeId&&(r.payload.round??1)>(previous!.payload.round??1)))fail('已有后续轮次，不得从旧轮次重复派发');
 }
 const definitionId=c.action==='assign'?c.definitionId:previous!.referenceId,employeeId=c.action==='assign'?c.employeeId:previous!.employeeId!,round=previous?(previous.payload.round??1)+1:1;
 const definition=records.find(r=>r.id===definitionId&&r.kind==='learningDefinition'),employee=state.employees.find(e=>e.id===employeeId);
 if(!definition||!visibleRecord(definition,records,state,m)||!employee||!scope.has(employee.orgId)||!scope.has(definition.payload.orgId!)||employee.orgId!==definition.payload.orgId)deny();
 if(employee!.status==='离职')fail('离职员工不能分派新学习');
 if(definition!.status!=='sealed'||!state.orgs.some(o=>o.id===definition!.payload.orgId&&o.status==='启用'))fail('计划须已定版且组织启用');
 const config=definition!.payload.learningMode!;
 if(previous&&config.mode!=='recurring')fail('后续轮次须保持循环模式');
 const key=learningAssignmentKey(definition!.id,employeeId,round);
 if(records.some(r=>r.kind==='learningAssignment'&&(r.payload.assignmentKey===key||r.employeeId===employeeId&&(r.payload.round??1)===round&&r.payload.contentDefinitionHistoryIds?.includes(definition!.id))))fail('此员工已获得该计划版本的本轮实例');
 const window=learningWindow(config,c.action==='nextRound'?c.start:businessDate(at));
 if(window.due<businessDate(at))fail('计划已经结束，不能分派');
 const assignment:R={id:crypto.randomUUID(),kind:'learningAssignment',employeeId,positionId:null,referenceId:definition!.id,status:'active',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{title:definition!.payload.title,orgId:definition!.payload.orgId,courseIds:[...definition!.payload.courseIds!],examIds:[...(definition!.payload.examIds??[])],homeworkIds:[...(definition!.payload.homeworkIds??[])],learningRequirements:learningRequirements(definition!).map(r=>({...r})),trainingStages:definition!.payload.trainingStages?structuredClone(definition!.payload.trainingStages):undefined,gradeRule:definition!.payload.gradeRule?structuredClone(definition!.payload.gradeRule):undefined,learningMode:config,version:definition!.payload.version,definitionRootId:definition!.payload.definitionRootId,assignmentKey:key,round,previousAssignmentId:previous?.id,start:window.start,due:window.due}};
 if(!window.allowOverdue&&assignment.payload.trainingStages?.some(stage=>learningStageStartsOn(assignment,stage)>window.due))fail('阶段开放日期晚于计划截止日，请调整草稿的新版本后再派发');
 const homeworkIds=definition!.payload.homeworkIds??[],homeworkReviewers=c.homeworkReviewers??Object.fromEntries(previous?homeworkIds.map(id=>[id,records.find(t=>t.kind==='homeworkTask'&&t.referenceId===id&&t.payload.learningAssignmentId===previous.id)?.payload.reviewerEmployeeId]):[]);
 if(Object.keys(homeworkReviewers).some(id=>!homeworkIds.includes(id))||homeworkIds.some(id=>!homeworkReviewers[id]))fail('须为每项作业指定独立批阅人');
 assignment.payload.homeworkReviewers=homeworkReviewers as Record<string,string>;
 const result:R[]=[assignment];
 for(const courseId of assignment.payload.courseIds!){
  const task=applyDevelopment([...records,...result],state,m,{action:'enroll',assignmentId:assignment.id,employeeId,courseId,due:window.due},at);
  result.push(reuseCompletedCourse(task,records,state,m,config.progressSync&&!previous));
 }
 for(const examId of assignment.payload.examIds??[])result.push(...applyLearningExamTask([...records,...result],state,m,{action:'assign',assignmentId:assignment.id,examId,employeeId,start:window.start,due:window.due},at));
 for(const homeworkId of homeworkIds)result.push(...applyHomework([...records,...result],state,m,{action:'assign',assignmentId:assignment.id,definitionId:homeworkId,employeeId,reviewerEmployeeId:homeworkReviewers[homeworkId],start:window.start,due:window.due},at));
 if(expiredIncompleteLearningStages(assignment,[...records,...result],at).length)fail('存在已经截止且未完成的阶段，请调整后续配置版本再派发');
 return result;
}
