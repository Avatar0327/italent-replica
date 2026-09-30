import {reportContext} from '@/lib/hris/r1-report-context';
import {readReportJob} from '@/lib/hris/r1-report-jobs';
import {reportRuntimeCapability} from '@/lib/hris/r1-report-runtime';
import {json,failure} from '@/lib/hris/http';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{await readReportJob(await reportContext(),(await params).id);return json({error:'后台执行能力尚未核实，任务已保存待执行',...reportRuntimeCapability},503);}catch(e){return failure(e);}}
