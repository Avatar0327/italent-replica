import {requireChatGPTUser} from '@/app/chatgpt-auth';
import {reportContext} from '@/lib/hris/r1-report-context';
import {HttpError} from '@/lib/hris/http';
import Reports from './workspace';
import R1Reports from './r1-workspace';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/reports');try{await reportContext();return <R1Reports/>;}catch(e){if(e instanceof HttpError&&e.machineCode==='FEATURE_NOT_READY')return <Reports/>;throw e;}}
