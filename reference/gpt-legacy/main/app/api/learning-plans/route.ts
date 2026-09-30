import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyLearningDefinition} from '@/lib/hris/learning-plan-definitions';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const c=await developmentContext(['homeworkDefinition','learningDefinition','course','learningExamDefinition'],['admin','hr']);return json({records:visibleDevelopment(c),revision:c.row.revision,role:c.member.role});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request)),c=await developmentContext(['homeworkDefinition','learningDefinition','course','learningExamDefinition'],['admin','hr']),r=applyLearningDefinition(c.records,c.state,c.member,b.command);await saveDevelopment(c,b.revision,r,'学习计划配置：'+String((b.command as {action:string}).action));return json({id:r.id,revision:c.row.revision+1});}catch(e){return failure(e);}}
