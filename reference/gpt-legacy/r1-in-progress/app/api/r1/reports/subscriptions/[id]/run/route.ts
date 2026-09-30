import {reportContext} from '@/lib/hris/r1-report-context';
import {json,failure} from '@/lib/hris/http';
export async function POST(){try{await reportContext();return json({error:'后台调度能力尚未核实，订阅配置已保存',state:'blocked_runtime',reasonCode:'DEP-PLATFORM-01'},503);}catch(e){return failure(e);}}
