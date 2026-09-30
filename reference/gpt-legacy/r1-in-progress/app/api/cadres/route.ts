import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyCadre} from '@/lib/hris/cadres';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const ctx=await developmentContext(['cadreNomination', 'cadreObservation', 'qualificationApplication', 'succession']);return json({records:visibleDevelopment(ctx).filter(r=>['cadreNomination','cadreObservation','qualificationApplication','succession'].includes(r.kind)),revision:ctx.row.revision,role:ctx.member.role,employeeId:ctx.member.employeeId,userId:ctx.member.userId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const body=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request));const ctx=await developmentContext(['cadreNomination', 'cadreObservation', 'qualificationApplication', 'succession']),r=applyCadre(ctx.records,ctx.state,ctx.member,body.command);await saveDevelopment(ctx,body.revision,r,'干部任用：'+String((body.command as {action:string}).action));return json({id:r.id,revision:body.revision+1});}catch(e){return failure(e);}}
