import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyTrainingSession} from '@/lib/hris/training-sessions';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['instructorCertification','trainingSession','trainingAttendance','training','course','enrollment'] as const;
export async function GET(){try{const ctx=await developmentContext(kinds);return json({records:visibleDevelopment(ctx),revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request));const ctx=await developmentContext(kinds),r=applyTrainingSession(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,r,'培训场次：'+String((body.command as {action:string}).action));return json({id:r.id,revision:body.revision+1});}catch(e){return failure(e);}}
