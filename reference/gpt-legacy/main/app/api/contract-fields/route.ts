import {z} from 'zod';
import {developmentContext,visibleDevelopment,saveDevelopment} from '@/lib/hris/development-repository';
import {applyContractField} from '@/lib/hris/contract-fields';
import {scopedOrgs} from '@/lib/hris/authorization';
import {json,failure,readBody} from '@/lib/hris/http';
export async function GET(){try{const c=await developmentContext(['contractFieldDefinition'],['admin','hr']),scope=scopedOrgs(c.state,c.member);return json({records:visibleDevelopment(c),orgs:c.state.orgs.filter(o=>scope.has(o.id)).map(o=>({id:o.id,name:o.name,status:o.status})),revision:c.row.revision});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const b=z.object({revision:z.number().int().nonnegative(),command:z.unknown()}).parse(await readBody(request)),c=await developmentContext(['contractFieldDefinition'],['admin','hr']),r=applyContractField(c.records,c.state,c.member,b.command);await saveDevelopment(c,b.revision,r,'合同字段：'+String((b.command as {action:string}).action));return json({id:r.id,revision:b.revision+1});}catch(e){return failure(e);}}
