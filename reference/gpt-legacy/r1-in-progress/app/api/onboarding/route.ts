import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyOnboarding} from '@/lib/hris/onboarding';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const ctx=await developmentContext(['onboardingTemplate','onboardingPlan']),records=visibleDevelopment(ctx);return json({records,revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request));const ctx=await developmentContext(['onboardingTemplate','onboardingPlan']),r=applyOnboarding(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,r,'入职融入：'+String((body.command as {action:string}).action));return json({id:r.id,revision:body.revision+1});}catch(e){return failure(e);}}
