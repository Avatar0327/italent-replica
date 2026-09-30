import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyCadreInterview} from '@/lib/hris/cadre-interviews';
import {permittedEmployeeIds} from '@/lib/hris/authorization';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(request:Request){try{
 const query=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),search:z.string().max(200).default(''),id:z.string().max(100).optional()}).parse(Object.fromEntries(new URL(request.url).searchParams));
 const ctx=await developmentContext(['cadreInterview'],['admin','hr']),ids=permittedEmployeeIds(ctx.state,ctx.member),visible=visibleDevelopment(ctx);
 const records=visible.filter(r=>(!query.id||r.id===query.id)&&(!query.search||[r.payload.cadreInterview?.employeeName,r.payload.cadreInterview?.interviewerName,r.payload.cadreInterview?.type,r.payload.cadreInterview?.role,r.payload.cadreInterview?.date].join(' ').includes(query.search))).reverse();
 return json({records:records.slice((query.page-1)*20,query.page*20),total:records.length,page:query.page,hasMore:query.page*20<records.length,employees:ctx.state.employees.filter(e=>ids.has(e.id)).map(e=>({id:e.id,name:e.name,code:e.code})),employeeId:ctx.member.employeeId,revision:ctx.row.revision});
 }catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request)),ctx=await developmentContext(['cadreInterview'],['admin','hr']),r=applyCadreInterview(ctx.records,ctx.state,ctx.member,b.command);await saveDevelopment(ctx,b.revision,r,'干部访谈：'+String((b.command as {action:string}).action));return json({id:r.id,revision:b.revision+1});}catch(e){return failure(e);}}
