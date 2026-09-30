import {memberContext} from '@/lib/hris/context';
import {json,failure} from '@/lib/hris/http';
import {readM01} from '@/lib/hris/r1-m01-read';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{return json(await readM01(await memberContext(),new URL(request.url).searchParams));}catch(e){return failure(e);}}
