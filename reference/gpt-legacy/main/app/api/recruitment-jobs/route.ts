import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyRecruitmentJob} from '@/lib/hris/recruitment-jobs';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const c=await developmentContext(['recruitmentJob','requisition'],['admin','hr','manager']);return json({records:visibleDevelopment(c).filter(r=>r.kind!=='candidate'),revision:c.row.revision,role:c.member.role});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).strict().parse(await readBody(request,98304)),c=await developmentContext(['recruitmentJob','requisition'],['admin','hr']),r=applyRecruitmentJob(c.records,c.state,c.member,b.command);await saveDevelopment(c,b.revision,r,'内部招聘职位：'+String((b.command as {action:string}).action));return json({id:r.id,revision:b.revision+1});}catch(e){return failure(e);}}
