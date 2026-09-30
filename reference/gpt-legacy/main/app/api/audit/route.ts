import {memberContext,readConsistent} from '@/lib/hris/context';
import {json,failure,HttpError} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
 const c=await memberContext(true),params=new URL(request.url).searchParams;const page=Number(params.get('page')??1);if(!Number.isSafeInteger(page)||page<1||page>10000)throw new HttpError(400,'页码无效');
 const filter=(params.get('q')??'').trim().slice(0,100);const like='%'+filter.replace(/[\\%_]/g,'\\$&')+'%';
 const [result,count]=await readConsistent(c,[
 c.db.prepare("SELECT a.id,a.action,a.subject,a.at,a.revision,coalesce(g.name,a.actor_id) AS actor FROM hris_audit_events a LEFT JOIN hris_access_grants g ON g.tenant_id=a.tenant_id AND g.claimed_by=a.actor_id WHERE a.tenant_id=? AND (a.action LIKE ? ESCAPE '\\' OR a.subject LIKE ? ESCAPE '\\') ORDER BY a.revision DESC,a.at DESC,a.id DESC LIMIT 20 OFFSET ?").bind(c.member.tenantId,like,like,(page-1)*20),
 c.db.prepare("SELECT count(*) AS count FROM hris_audit_events WHERE tenant_id=? AND (action LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')").bind(c.member.tenantId,like,like),
 ]);return json({items:result.results,total:(count.results[0] as {count:number}).count,page});
 }catch(e){return failure(e);}}
