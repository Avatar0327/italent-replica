import {livePerformancePlanIds} from '@/lib/hris/performance-availability';
import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyPerformanceCheckin} from '@/lib/hris/performance-checkins';
import {visibleState} from '@/lib/hris/authorization';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['performanceCheckin','performanceGoalChange','performancePlan','performanceCycle','performance'] as const;
export async function GET(){try{const ctx=await developmentContext(kinds),state=visibleState(ctx.state,ctx.member);return json({livePlanIds:livePerformancePlanIds(ctx.state,ctx.records,ctx.member),records:visibleDevelopment(ctx),employees:state.employees.map(e=>({id:e.id,name:e.name,status:e.status})),revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request)),ctx=await developmentContext(kinds),record=applyPerformanceCheckin(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,record,'目标执行跟进：'+String((body.command as {action:string}).action));return json({id:record.id,revision:body.revision+1});}catch(e){return failure(e);}}
