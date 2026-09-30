import {memberContext} from '@/lib/hris/context';
import {readWorkflows} from '@/lib/hris/r1-workflow-read';
import {json,failure} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return json(await readWorkflows(await memberContext(),new URL(request.url).searchParams));}catch(e){return failure(e);}}
