import {reportContext} from '@/lib/hris/r1-report-context';
import {readReportJob} from '@/lib/hris/r1-report-jobs';
import {json,failure} from '@/lib/hris/http';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{return json(await readReportJob(await reportContext(),(await params).id));}catch(e){return failure(e);}}
