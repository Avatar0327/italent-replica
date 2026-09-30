import {memberContext} from '@/lib/hris/context';
import {json,failure,readBody} from '@/lib/hris/http';
import {executeWorkflowBatch} from '@/lib/hris/r1-workflow-batch';
export async function POST(request:Request){try{return json(await executeWorkflowBatch(memberContext,await readBody(request)));}catch(e){return failure(e);}}
