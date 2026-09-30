import {learningStageSubmissionOpen,learningStageOpen} from './learning-requirements';
import {z} from 'zod';
import type {DevelopmentRecord as R} from './development';
import {visibleRecord} from './development';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {businessDate} from './business-time';
import {HttpError} from './http';
const id=z.string().min(1).max(100),title=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
const fields={title,orgId:id,content:z.string().trim().min(20).max(12000),maxSubmissions:z.number().int().min(1).max(20)};
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),...fields}).strict(),z.object({action:z.literal('edit'),id,...fields}).strict(),
 z.object({action:z.literal('seal'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id}).strict(),
 z.object({action:z.literal('assign'),assignmentId:id.optional(),definitionId:id,employeeId:id,reviewerEmployeeId:id,start:date,due:date}).strict(),
 z.object({action:z.literal('submit'),id,content:z.string().trim().min(20).max(12000)}).strict(),
 z.object({action:z.literal('review'),id,submissionId:id,accepted:z.boolean(),score:z.number().int().min(0).max(100).optional(),evidence}).strict(),
 z.object({action:z.literal('reassignReviewer'),id,reviewerEmployeeId:id,evidence}).strict(),
 z.object({action:z.literal('cancel'),id,evidence}).strict(),z.object({action:z.literal('restore'),id,evidence}).strict(),
]);
export function homeworkTaskCurrent(task:R,state:State){
 const learner=state.employees.find(e=>e.id===task.employeeId),reviewer=state.employees.find(e=>e.id===task.payload.reviewerEmployeeId);
 return !task.payload.requirementRetiredAt&&!!learner&&!!reviewer&&learner.id!==reviewer.id&&learner.status!=='离职'&&reviewer.status!=='离职'&&learner.orgId===task.payload.orgId&&reviewer.orgId===task.payload.orgId&&state.orgs.some(o=>o.id===task.payload.orgId&&o.status==='启用');
}
export function homeworkTaskOpen(task:R,state:State,at=new Date().toISOString(),records:R[]=[]){
 return learningStageSubmissionOpen(task,records,at)&&learningStageOpen(task,records,at,state)&&['active','returned'].includes(task.status)&&homeworkTaskCurrent(task,state)&&businessDate(at)>=task.payload.start!&&(!!task.payload.assignmentAllowOverdue||businessDate(at)<=task.payload.due!)&&(task.payload.submissionVersion??0)<task.payload.maxSubmissions!;
}
export function canReviewHomework(task:R,state:State,m:Member,records:R[]=[],at=new Date().toISOString()){return learningStageOpen(task,records,at,state)&&task.status==='submitted'&&homeworkTaskCurrent(task,state)&&m.employeeId===task.payload.reviewerEmployeeId&&m.employeeId!==task.employeeId&&m.userId!==task.payload.submittedBy&&['admin','hr','manager','employee'].includes(m.role);}
export function applyHomework(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R[]{
 const c=schema.parse(input),scope=scopedOrgs(state,m),manage=['admin','hr'].includes(m.role);
 const deny=():never=>{throw new HttpError(403,'没有此作业的办理权限');};const fail=(s:string):never=>{throw new HttpError(400,s);};
 const make=(kind:R['kind'],status:string,payload:R['payload'],employeeId:string|null=null,referenceId:string|null=null):R=>({id:crypto.randomUUID(),kind,status,payload,employeeId,referenceId,positionId:null,createdBy:m.userId,createdAt:at,updatedAt:at});
 if(['create','edit','seal','revise','archive'].includes(c.action)){
  if(!manage)deny();const command=c as Extract<typeof c,{action:'create'|'edit'|'seal'|'revise'|'archive'}>;
  const old=command.action==='create'?undefined:records.find(r=>r.id===command.id&&r.kind==='homeworkDefinition');
  if(command.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
  const orgId=command.action==='create'||command.action==='edit'?command.orgId:old!.payload.orgId!;
  if(!scope.has(orgId))deny();if(!state.orgs.some(o=>o.id===orgId&&o.status==='启用'))fail('作业所属组织须启用');
  if(command.action==='archive'){if(old!.status==='archived')fail('已归档');return [{...old!,status:'archived',updatedAt:at}];}
  if(command.action==='revise'){if(old!.status!=='sealed'||records.some(r=>r.kind==='homeworkDefinition'&&r.payload.definitionRootId===old!.payload.definitionRootId&&(r.status==='draft'||(r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0)))))fail('仅最新定版且没有后续草稿时可修订');return [{...old!,id:crypto.randomUUID(),referenceId:old!.id,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...records.filter(r=>r.kind==='homeworkDefinition'&&r.payload.definitionRootId===old!.payload.definitionRootId).map(r=>r.payload.version??1))+1}}];}
  if(old&&old.status!=='draft')fail('定版作业不可修改');if(command.action==='seal')return [{...old!,status:'sealed',updatedAt:at}];
  if(old&&old.payload.orgId!==orgId)fail('作业版本不能更换所属组织');
  const record=old??make('homeworkDefinition','draft',{});return [{...record,updatedAt:at,payload:{title:command.title,content:command.content,maxSubmissions:command.maxSubmissions,orgId,definitionRootId:old?.payload.definitionRootId??record.id,version:old?.payload.version??1}}];
 }
 if(c.action==='assign'){
  const d=records.find(r=>r.id===c.definitionId&&r.kind==='homeworkDefinition'),e=state.employees.find(e=>e.id===c.employeeId),reviewer=state.employees.find(e=>e.id===c.reviewerEmployeeId);
  if(!manage||!d||!e||!reviewer||!visibleRecord(d,records,state,m)||!scope.has(e.orgId)||!scope.has(reviewer.orgId))deny();
  if(d!.status!=='sealed'||e!.orgId!==d!.payload.orgId||reviewer!.orgId!==e!.orgId||e!.id===reviewer!.id||e!.status==='离职'||reviewer!.status==='离职'||!state.orgs.some(o=>o.id===e!.orgId&&o.status==='启用'))fail('须为同一启用组织的在职学员和独立批阅人，作业须定版');
  if(c.due<c.start||c.due<businessDate(at))fail('作业起止日期无效');
  const assignment=c.assignmentId?records.find(r=>r.kind==='learningAssignment'&&r.id===c.assignmentId):undefined;
  if(c.assignmentId&&(!assignment||assignment.status!=='active'||assignment.employeeId!==c.employeeId||assignment.payload.orgId!==d!.payload.orgId||!assignment.payload.homeworkIds?.includes(d!.id)||assignment.payload.start!==c.start||assignment.payload.due!==c.due))fail('学习实例、作业要求、人员或日期不匹配');
  if(records.some(r=>r.kind==='homeworkTask'&&r.referenceId===d!.id&&r.employeeId===e!.id&&r.payload.learningAssignmentId===c.assignmentId))fail('已有该作业版本任务，不能重复派发');
  return [make('homeworkTask','active',{...(assignment?{learningAssignmentId:assignment.id,learningRequirementId:assignment.payload.learningRequirements?.find(r=>r.kind==='homework'&&r.resourceId===d!.id)?.id,assignmentAllowOverdue:assignment.payload.learningMode?.mode!=='fixed'&&assignment.payload.learningMode?.allowOverdue}:{}),title:d!.payload.title,content:d!.payload.content,maxSubmissions:d!.payload.maxSubmissions,version:d!.payload.version,orgId:e!.orgId,reviewerEmployeeId:reviewer!.id,reviewerName:reviewer!.name,employeeSnapshot:{name:e!.name,code:e!.code,orgName:state.orgs.find(o=>o.id===e!.orgId)!.name},start:c.start,due:c.due,submissionVersion:0},e!.id,d!.id)];
 }
 const taskId='id' in c?c.id:deny();const task=records.find(r=>r.id===taskId&&r.kind==='homeworkTask');if(!task||!visibleRecord(task,records,state,m))deny();
 if(task!.payload.requirementRetiredAt)fail('此作业已退出计划要求，保留历史且不能继续办理');
 const changed=(status:string,payload:R['payload']={})=>({...task!,status,updatedAt:at,payload:{...task!.payload,...payload}});
 if(c.action==='reassignReviewer'){
  const reviewer=state.employees.find(e=>e.id===c.reviewerEmployeeId),learner=state.employees.find(e=>e.id===task!.employeeId);
  if(!manage||!scope.has(task!.payload.orgId!))deny();
  if(!['active','returned','submitted','cancelled'].includes(task!.status)||!reviewer||reviewer.status==='离职'||reviewer.orgId!==task!.payload.orgId||reviewer.id===task!.employeeId||!learner||learner.status==='离职'||learner.orgId!==task!.payload.orgId||!state.orgs.some(o=>o.id===task!.payload.orgId&&o.status==='启用'))fail('无法转交：任务和双方组织状态须有效');
  if(reviewer!.id===task!.payload.reviewerEmployeeId)fail('批阅人未变化');return [changed(task!.status,{reviewerEmployeeId:reviewer!.id,reviewerName:reviewer!.name,evidence:c.evidence})];
 }
 if(c.action==='cancel'){if(!manage||!scope.has(task!.payload.orgId!))deny();if(!['active','returned','submitted'].includes(task!.status))fail('仅未完成作业可取消');return [changed('cancelled',{homeworkPreviousStatus:task!.status,evidence:c.evidence})];}
 if(c.action==='restore'){if(!manage||!scope.has(task!.payload.orgId!))deny();if(task!.status!=='cancelled'||!homeworkTaskCurrent(task!,state)||!learningStageOpen(task!,records,at,state)||!task!.payload.assignmentAllowOverdue&&businessDate(at)>task!.payload.due!)fail('作业状态、人员或期限不允许恢复');return [changed(task!.payload.homeworkPreviousStatus??'active',{evidence:c.evidence})];}
 if(c.action==='submit'){
  if(m.employeeId!==task!.employeeId)deny();if(!homeworkTaskOpen(task!,state,at,records))fail('作业不可提交：状态、期限、人员或次数不满足');
  const version=(task!.payload.submissionVersion??0)+1,submission=make('homeworkSubmission','submitted',{content:c.content,submissionVersion:version,orgId:task!.payload.orgId},task!.employeeId,task!.id);
  return [submission,changed('submitted',{submissionId:submission.id,submissionVersion:version,submittedBy:m.userId,submittedAt:at,score:undefined,passed:undefined,verifiedBy:undefined,verifiedAt:undefined,verification:undefined})];
 }
 if(c.action==='review'){
  if(!canReviewHomework(task!,state,m,records,at))deny();const submission=records.find(r=>r.id===c.submissionId&&r.kind==='homeworkSubmission'&&r.referenceId===task!.id&&r.employeeId===task!.employeeId);
  if(!submission||submission.status!=='submitted'||task!.payload.submissionId!==c.submissionId)fail('只能批阅当前待审提交版本');
  const proof={verification:c.evidence,verifiedBy:m.userId,verifiedAt:at,score:c.score,passed:c.accepted};
  return [{...submission!,status:c.accepted?'passed':'returned',updatedAt:at,payload:{...submission!.payload,...proof}},changed(c.accepted?'completed':'returned',proof)];
 }
 return deny();
}
