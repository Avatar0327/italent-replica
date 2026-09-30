import {livePerformancePlanIds} from '@/lib/hris/performance-availability';
import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopmentMany} from '@/lib/hris/development-repository';
import {applyPerformanceChange} from '@/lib/hris/performance-changes';
import {visibleState} from '@/lib/hris/authorization';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['performanceIndicator','performanceGoalChange','performancePlan','performanceCycle','performance'] as const;
export async function GET(){try{const ctx=await developmentContext(kinds),state=visibleState(ctx.state,ctx.member);return json({livePlanIds:livePerformancePlanIds(ctx.state,ctx.records,ctx.member),records:visibleDevelopment(ctx),employees:state.employees.map(e=>({id:e.id,name:e.name,status:e.status,orgId:e.orgId})),revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request,327680)),ctx=await developmentContext(kinds),records=applyPerformanceChange(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopmentMany(ctx,body.revision,records,'绩效目标调整：'+String((body.command as {action:string}).action));return json({id:records[0].id,revision:body.revision+1});}catch(e){return failure(e);}}
