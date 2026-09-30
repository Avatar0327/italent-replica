import {readConsistent} from '@/lib/hris/context';
import {scopedOrgs,type Member} from '@/lib/hris/authorization';
import type {DevelopmentContext} from '@/lib/hris/development-repository';
import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyInterviewSchedule,appointmentLive,canEvaluateAppointment} from '@/lib/hris/interview-schedule';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['interviewAppointment','interviewDefinition','candidate','requisition'] as const;
async function eligible(c:DevelopmentContext){const [result]=await readConsistent(c,[c.db.prepare("SELECT user_id AS userId,tenant_id AS tenantId,employee_id AS employeeId,role,active,org_scope AS orgScope FROM hris_memberships WHERE tenant_id=? AND active=1 AND role IN ('admin','hr','manager') AND employee_id IS NOT NULL").bind(c.member.tenantId)]);const scope=scopedOrgs(c.state,c.member);return (result.results as Member[]).filter(m=>{const e=c.state.employees.find(e=>e.id===m.employeeId);return !!e&&e.status!=='离职'&&scope.has(e.orgId)&&scopedOrgs(c.state,m).has(e.orgId);}).map(m=>m.employeeId!);}
export async function GET(){try{const c=await developmentContext(kinds,['admin','hr','manager']),records=visibleDevelopment(c);return json({records,revision:c.row.revision,role:c.member.role,employeeId:c.member.employeeId,eligibleInterviewerIds:await eligible(c),availability:records.filter(r=>r.kind==='interviewAppointment').map(r=>({id:r.id,live:appointmentLive(r,c.records,c.state),canEvaluate:canEvaluateAppointment(r,c.records,c.state,c.member)}))});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).strict().parse(await readBody(request)),c=await developmentContext(kinds,['admin','hr']),r=applyInterviewSchedule(c.records,c.state,c.member,b.command,await eligible(c));await saveDevelopment(c,b.revision,r,'内部面试排期：'+String((b.command as {action:string}).action));return json({id:r.id,revision:b.revision+1});}catch(e){return failure(e);}}
