import {learningTaskStageDeadline} from '@/lib/hris/learning-requirements';
import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopmentMany} from '@/lib/hris/development-repository';
import {applyHomework,homeworkTaskOpen,canReviewHomework} from '@/lib/hris/learning-homework';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['learningAssignment','enrollment','learningExamTask','learningExamAttempt','homeworkDefinition','homeworkTask','homeworkSubmission'] as const;
export async function GET(){try{const c=await developmentContext(kinds),records=visibleDevelopment(c);return json({records,availability:records.filter(r=>r.kind==='homeworkTask').map(r=>({id:r.id,stageDeadline:learningTaskStageDeadline(r,c.records),canSubmit:r.employeeId===c.member.employeeId&&homeworkTaskOpen(r,c.state,undefined,c.records),canReview:canReviewHomework(r,c.state,c.member,c.records)})),revision:c.row.revision,role:c.member.role,employeeId:c.member.employeeId});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).strict().parse(await readBody(request)),c=await developmentContext(kinds),records=applyHomework(c.records,c.state,c.member,b.command);await saveDevelopmentMany(c,b.revision,records,'独立作业：'+String((b.command as {action:string}).action));return json({ids:records.map(r=>r.id),revision:c.row.revision+1});}catch(e){return failure(e);}}
