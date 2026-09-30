import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopmentMany} from '@/lib/hris/development-repository';
import {applyShiftDefinition} from '@/lib/hris/shift-definitions';
import {json,failure,readBody} from '@/lib/hris/http';
const kinds=['shiftDefinition','shift','clock','correction','leave','attendancePeriod'] as const;
export async function GET(){try{const c=await developmentContext(kinds,['admin','hr','manager']);return json({records:visibleDevelopment(c).filter(r=>r.kind==='shiftDefinition'),revision:c.row.revision,role:c.member.role});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).strict().parse(await readBody(request)),c=await developmentContext(kinds,['admin','hr','manager']),records=applyShiftDefinition(c.records,c.state,c.member,b.command);await saveDevelopmentMany(c,b.revision,records,'固定班次：'+String((b.command as {action:string}).action));return json({ids:records.map(r=>r.id),revision:b.revision+1});}catch(e){return failure(e);}}
