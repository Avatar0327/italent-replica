import {reportContext} from '@/lib/hris/r1-report-context';
import {readSubscriptionResult} from '@/lib/hris/r1-report-subscriptions';
import {json,failure,HttpError} from '@/lib/hris/http';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const p=new URL(request.url).searchParams;if([...p.keys()].some(k=>k!=='cursor'))throw new HttpError(400,'未知结果参数','INVALID_INPUT');return json(await readSubscriptionResult(await reportContext(),(await params).id,p.get('cursor')??undefined));}catch(e){return failure(e);}}
