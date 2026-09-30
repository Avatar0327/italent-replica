import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyPerformanceRating} from '@/lib/hris/performance-ratings';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const c=await developmentContext(['performanceRatingDefinition'],['admin','hr']);return json({records:visibleDevelopment(c),revision:c.row.revision});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).strict().parse(await readBody(request)),c=await developmentContext(['performanceRatingDefinition'],['admin','hr']),r=applyPerformanceRating(c.records,c.state,c.member,b.command);await saveDevelopment(c,b.revision,r,'绩效等级方案：'+String((b.command as {action:string}).action));return json({id:r.id,revision:c.row.revision+1});}catch(e){return failure(e);}}
