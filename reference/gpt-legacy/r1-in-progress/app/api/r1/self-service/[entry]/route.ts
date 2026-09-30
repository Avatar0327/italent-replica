import {memberContext} from '@/lib/hris/context';
import {readPortal} from '@/lib/hris/r1-portal';
import {json,failure} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{entry:string}>}){try{const p=new URL(request.url).searchParams;p.set('entry',(await params).entry);return json(await readPortal(await memberContext(),p));}catch(e){return failure(e);}}
