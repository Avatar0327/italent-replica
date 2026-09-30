import {memberContext,readConsistent} from '@/lib/hris/context';
import {permittedEmployeeIds} from '@/lib/hris/authorization';
import {json,failure,HttpError} from '@/lib/hris/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
 const c=await memberContext();const params=new URL(request.url).searchParams;const id=params.get('employeeId');
 if(!id||!permittedEmployeeIds(JSON.parse(c.row.data),c.member).has(id))throw new HttpError(403,'没有此员工的任职记录访问权限');
 const page=Number(params.get('page')??1);if(!Number.isSafeInteger(page)||page<1||page>10000)throw new HttpError(400,'页码无效');
 const [history,count]=await readConsistent(c,[
 c.db.prepare('SELECT h.id,h.at,h.from_status AS fromStatus,h.to_status AS toStatus,h.job,h.level,a.name AS fromOrg,b.name AS toOrg FROM hris_employment_history h LEFT JOIN hris_orgs a ON a.tenant_id=h.tenant_id AND a.id=h.from_org_id JOIN hris_orgs b ON b.tenant_id=h.tenant_id AND b.id=h.to_org_id WHERE h.tenant_id=? AND h.employee_id=? ORDER BY h.at DESC,h.id DESC LIMIT 20 OFFSET ?').bind(c.member.tenantId,id,(page-1)*20),
 c.db.prepare('SELECT count(*) AS count FROM hris_employment_history WHERE tenant_id=? AND employee_id=?').bind(c.member.tenantId,id),
 ]);return json({items:history.results.map((r:any)=>({...r,level:c.member.role==='admin'||c.member.viewLevel?r.level:''})),page,total:(count.results[0] as {count:number}).count});
 }catch(e){return failure(e);}}
