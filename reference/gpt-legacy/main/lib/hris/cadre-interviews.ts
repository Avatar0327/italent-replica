import {z} from 'zod';
import {HttpError} from './http';
import {businessDate} from './business-time';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import {interviewTypes,interviewRoles} from './cadre-interview-fields';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(3000);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;},'日期无效');
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('save'),id:id.optional(),employeeId:id,interviewerId:id,type:z.enum(interviewTypes),role:z.enum(interviewRoles),date,location:z.string().trim().max(200),content:z.string().trim().min(1).max(200),evidence}).strict(),
 z.object({action:z.literal('cancel'),id,evidence}).strict(),
]);
/** Retrospective HR registration; role labels never grant access or prove reporting relationships. */
export function applyCadreInterview(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),scope=scopedOrgs(state,m),deny=():never=>{throw new HttpError(403,'仅有双方当前组织权限的HR可维护访谈记录');};
 if(!['admin','hr'].includes(m.role))deny();
 const old=c.id?records.find(r=>r.kind==='cadreInterview'&&r.id===c.id):undefined;
 if(c.id&&(!old||!visibleRecord(old,records,state,m)))deny();
 if(old&&old.status!=='active')throw new HttpError(400,'作废记录仅保留历史');
 const employeeId=c.action==='save'?c.employeeId:old!.employeeId;
 if(employeeId===m.employeeId)throw new HttpError(403,'不能维护本人的访谈记录');
 if(c.action==='cancel')return {...old!,status:'cancelled',updatedAt:at,payload:{...old!.payload,closedReason:c.evidence}};
 const employee=state.employees.find(e=>e.id===c.employeeId),interviewer=state.employees.find(e=>e.id===c.interviewerId);
 if(!employee||!interviewer||!scope.has(employee.orgId)||!scope.has(interviewer.orgId))deny();
 if(old&&(old.employeeId!==c.employeeId||old.payload.cadreInterview?.interviewerId!==c.interviewerId))throw new HttpError(400,'更正不能更换人员或访谈人，误选请作废后重登');
 if(c.employeeId===c.interviewerId)throw new HttpError(400,'访谈人与被访谈人不能相同');
 if(c.date>businessDate(at))throw new HttpError(400,'这里只登记已发生访谈，日期不能在未来');
 if(records.some(r=>r.kind==='cadreInterview'&&r.id!==old?.id&&r.status==='active'&&r.employeeId===c.employeeId&&r.payload.cadreInterview?.interviewerId===c.interviewerId&&r.payload.cadreInterview?.type===c.type&&r.payload.cadreInterview?.date===c.date&&r.payload.cadreInterview?.content===c.content))throw new HttpError(400,'相同人员、类型、日期和内容已登记');
 return {id:old?.id??crypto.randomUUID(),kind:'cadreInterview',employeeId:c.employeeId,positionId:null,referenceId:null,status:'active',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{version:(old?.payload.version??0)+1,evidence:c.evidence,cadreInterview:{type:c.type,date:c.date,role:c.role,interviewerId:c.interviewerId,interviewerName:interviewer!.name,employeeName:employee!.name,location:c.location,content:c.content}}};
}
