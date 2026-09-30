import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyInterviewDefinition} from '@/lib/hris/recruitment-evaluations';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const c=await developmentContext(['interviewDefinition'],['admin','hr','manager']);return json({records:visibleDevelopment(c),revision:c.row.revision,role:c.member.role});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).strict().parse(await readBody(request,196608)),c=await developmentContext(['interviewDefinition'],['admin','hr']),r=applyInterviewDefinition(c.records,c.state,c.member,b.command);await saveDevelopment(c,b.revision,r,'面试评价表：'+String((b.command as {action:string}).action));return json({id:r.id,revision:b.revision+1});}catch(e){return failure(e);}}
