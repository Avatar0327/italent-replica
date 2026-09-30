import {reportContext} from '@/lib/hris/r1-report-context';
import {runSavedReport} from '@/lib/hris/r1-report-run';
import {json,failure} from '@/lib/hris/http';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const p=new URL(request.url).searchParams,version=p.has('version')?Number(p.get('version')):undefined;p.delete('version');return json(await runSavedReport(await reportContext(),(await params).id,version,p));}catch(e){return failure(e);}}
