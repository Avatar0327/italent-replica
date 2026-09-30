import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {businessDate} from '@/lib/hris/workforce';
import {applyFeedback} from '@/lib/hris/feedback';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['feedbackProject','feedbackInvite','feedbackReply','feedbackReport','surveyTemplate'] as const;
export async function GET(){try{const ctx=await developmentContext(kinds);return json({records:visibleDevelopment(ctx),canRespondIds:visibleDevelopment(ctx).filter(r=>r.kind==='feedbackInvite'&&r.status==='assigned'&&r.employeeId===ctx.member.employeeId&&ctx.state.employees.some(e=>e.id===ctx.member.employeeId&&e.status!=='离职')&&ctx.records.some(p=>p.kind==='feedbackProject'&&p.id===r.referenceId&&p.status==='open'&&p.payload.start!<=businessDate()&&p.payload.end!>=businessDate())).map(r=>r.id),revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request));const ctx=await developmentContext(kinds),r=applyFeedback(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,r,'360评估：'+String((body.command as {action:string}).action));return json({id:r.id,revision:body.revision+1});}catch(e){return failure(e);}}
