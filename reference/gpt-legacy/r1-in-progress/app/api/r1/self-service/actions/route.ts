import {memberContext} from '@/lib/hris/context';
import {portalAction} from '@/lib/hris/r1-portal';
import {json,failure,readBody} from '@/lib/hris/http';
export async function POST(request:Request){try{return json(await portalAction(await memberContext(),await readBody(request)));}catch(e){return failure(e);}}
