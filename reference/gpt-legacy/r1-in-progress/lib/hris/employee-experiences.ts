import {z} from 'zod';
import {businessDate} from './business-time';
import {scopedOrgs,type Member} from './authorization';
import {HttpError} from './http';
import type {State} from './model';
import {visibleRecord,type DevelopmentRecord as R} from './development';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),month=z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('save'),id:id.optional(),employeeId:id,category:z.enum(['education','employment','project']),institution:text,title:text,startMonth:month,endMonth:month.optional(),ongoing:z.boolean(),description:evidence,evidence}),
 z.object({action:z.literal('cancel'),id,evidence}),
]);
/** HR registration of supplied history; not an external verification or employment action. */
export function applyEmployeeExperience(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input);if(!['admin','hr'].includes(member.role))throw new HttpError(403,'仅有权限HR可维护人员经历');
 const existing='id'in c&&c.id?records.find(r=>r.kind==='employeeExperience'&&r.id===c.id):undefined;
 if('id'in c&&c.id&&(!existing||!visibleRecord(existing,records,state,member)))throw new HttpError(403,'记录不存在或没有访问权限');
 const employeeId=c.action==='save'?c.employeeId:existing!.employeeId,e=state.employees.find(e=>e.id===employeeId);
 if(!e||!scopedOrgs(state,member).has(e.orgId))throw new HttpError(403,'没有此员工的经历维护权限');
 if(existing&&existing.status!=='active')throw new HttpError(400,'已作废经历保留历史，不可再次修改');
 if(c.action==='cancel')return {...existing!,status:'cancelled',updatedAt:at,payload:{...existing!.payload,closedReason:c.evidence}};
 if(existing&&(existing.employeeId!==c.employeeId||existing.payload.experienceCategory!==c.category))throw new HttpError(400,'更正不能改变所属员工或经历类别');
 const current=businessDate(at).slice(0,7);if(c.startMonth>current||c.ongoing&&c.endMonth||!c.ongoing&&!c.endMonth||c.endMonth&&(c.endMonth<c.startMonth||c.endMonth>current))throw new HttpError(400,'请核对起止月份：进行中不填结束月，已结束须填结束月，不能登记未来经历');
 if(records.some(r=>r.id!==existing?.id&&r.kind==='employeeExperience'&&r.status==='active'&&r.employeeId===c.employeeId&&r.payload.experienceCategory===c.category&&r.payload.institution===c.institution&&r.payload.title===c.title&&r.payload.startMonth===c.startMonth))throw new HttpError(400,'已有相同类别、机构、名称和开始月份的有效经历');
 return {id:existing?.id??crypto.randomUUID(),kind:'employeeExperience',employeeId:c.employeeId,positionId:null,referenceId:null,status:'active',createdBy:existing?.createdBy??member.userId,createdAt:existing?.createdAt??at,updatedAt:at,payload:{experienceCategory:c.category,institution:c.institution,title:c.title,startMonth:c.startMonth,endMonth:c.endMonth,ongoing:c.ongoing,description:c.description,evidence:c.evidence,version:(existing?.payload.version??0)+1}};
}
