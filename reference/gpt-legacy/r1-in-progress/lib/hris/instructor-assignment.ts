import {z} from 'zod';
import {applyDevelopment,visibleRecord,type DevelopmentRecord as R} from './development';
import {applyInstructorDevelopment} from './instructor-development';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';

const command=z.object({action:z.literal('assign'),profileId:z.string().min(1).max(100),courseId:z.string().min(1).max(100),due:z.string(),mandatory:z.boolean(),evidence:z.string().trim().min(5).max(2000)});
export function assignInstructorCourse(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R[]{
 const c=command.parse(input),profile=records.find(r=>r.kind==='instructorProfile'&&r.id===c.profileId);
 if(!['admin','hr'].includes(member.role)||!profile||!visibleRecord(profile,records,state,member))throw new HttpError(403,'仅有权限HR可安排认证培养课程');
 const employee=state.employees.find(e=>e.id===profile.employeeId);
 if(!employee||!scopedOrgs(state,member).has(employee.orgId)||employee.id===member.employeeId)throw new HttpError(403,'须由非本人的有权限HR安排培养课程');
 if(profile.status!=='submitted'||employee.status==='离职')throw new HttpError(400,'只有在职员工的待复核提名可安排培养课程');
 // Reuse enrollment validation, including course version uniqueness, dates and exam snapshot.
 const enrollment=applyDevelopment(records,state,member,{action:'enroll',employeeId:employee.id,courseId:c.courseId,due:c.due},at);
 const link=applyInstructorDevelopment([...records,enrollment],state,member,{action:'link',profileId:profile.id,enrollmentId:enrollment.id,mandatory:c.mandatory,evidence:c.evidence},at);
 return [enrollment,link];
}
