import {memberContext} from '@/lib/hris/context';
import {workflowOptions} from '@/lib/hris/r1-workflow-options';
import {json,failure,HttpError} from '@/lib/hris/http';
export async function GET(request:Request){try{const orgId=new URL(request.url).searchParams.get('orgId');if(!orgId||orgId.length>100)throw new HttpError(400,'请选择组织');return json(await workflowOptions(await memberContext(),orgId));}catch(e){return failure(e);}}
