import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyEmployeeExperience} from '@/lib/hris/employee-experiences';
import {permittedEmployeeIds} from '@/lib/hris/authorization';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const ctx=await developmentContext(['employeeExperience']),hr=['admin','hr'].includes(ctx.member.role),ids=permittedEmployeeIds(ctx.state,ctx.member);return json({records:visibleDevelopment(ctx),employees:ctx.state.employees.filter(e=>hr?ids.has(e.id):e.id===ctx.member.employeeId).map(e=>({id:e.id,name:e.name,code:e.code})),revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request)),ctx=await developmentContext(['employeeExperience'],['admin','hr']),record=applyEmployeeExperience(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,record,'人员经历：'+String((body.command as {action:string}).action));return json({id:record.id,revision:body.revision+1});}catch(e){return failure(e);}}
