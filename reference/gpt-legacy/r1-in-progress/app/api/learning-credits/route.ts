import {businessDate} from '@/lib/hris/business-time';
import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyLearningCredit,learningCreditSummary} from '@/lib/hris/learning-credits';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const ctx=await developmentContext(['learningAssignment','course','enrollment','courseCreditPolicy','learningCredit','creditReversal']),records=visibleDevelopment(ctx),asOf=businessDate();return json({records,summary:learningCreditSummary(records,asOf),asOf,revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request));const ctx=await developmentContext(['learningAssignment','course','enrollment','courseCreditPolicy','learningCredit','creditReversal']),r=applyLearningCredit(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,r,'学习学分：'+String((body.command as {action:string}).action));return json({id:r.id,revision:body.revision+1});}catch(e){return failure(e);}}
