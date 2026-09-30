import {trainingStageCompleted} from './training-stages';
import {z} from 'zod';
import {applyDevelopment,visibleRecord,orgWithin,type DevelopmentRecord as R} from './development';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
const id=z.string().min(1).max(100);
const command=z.object({action:z.literal('dispatchTrainingStage'),id,employeeIds:z.array(id).min(1).max(20),due:z.string()});
export function dispatchTrainingStage(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R[]{
 const c=command.parse(input),training=records.find(r=>r.kind==='training'&&r.id===c.id),scope=scopedOrgs(state,member);
 if(!['admin','hr','manager'].includes(member.role)||!training||!visibleRecord(training,records,state,member)||!scope.has(training.payload.orgId!))throw new HttpError(403,'须有项目组织的管理权限才能批量派课');
 if(training.status!=='active'||!training.payload.trainingStages?.length)throw new HttpError(400,'只可为进行中的课程阶段项目派课');
 if(new Set(c.employeeIds).size!==c.employeeIds.length)throw new HttpError(400,'所选人员不得重复');
 const created:R[]=[];
 for(const employeeId of c.employeeIds){
  const employee=state.employees.find(e=>e.id===employeeId);
  if(!employee||!scope.has(employee.orgId))throw new HttpError(403,'所选人员包含无权管理的员工');
  if(!orgWithin(state,employee.orgId,training.payload.orgId!))throw new HttpError(400,'所选人员不在项目组织范围内');
  if(employee.status==='离职')throw new HttpError(400,'所选人员包含已离职员工');
  const current=training.payload.trainingStages.find(s=>!trainingStageCompleted(training,s,records,employeeId));
  for(const courseId of current?.courseIds??[]){
   if(records.some(r=>r.kind==='enrollment'&&r.employeeId===employeeId&&r.payload.trainingId===training.id&&r.referenceId===courseId&&r.status!=='cancelled'))continue;
   created.push(applyDevelopment([...records,...created],state,member,{action:'enroll',employeeId,trainingId:training.id,courseId,due:c.due},at));
   if(created.length>20)throw new HttpError(400,'单次最多派发20个课程任务，请减少所选人员');
  }
 }
 if(!created.length)throw new HttpError(400,'所选人员的当前阶段已派发或全部阶段已完成');
 return created;
}
