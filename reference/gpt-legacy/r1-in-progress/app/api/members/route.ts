import {commitLegacy} from '@/lib/hris/r1-command';
import { memberContext, readConsistent } from '@/lib/hris/context';
import { json, failure, readBody, HttpError } from '@/lib/hris/http';
import { grantSchema, validateGrant } from '@/lib/hris/member-rules';
export const dynamic='force-dynamic';
export async function GET(){try{const c=await memberContext(true);const [rows]=await readConsistent(c,[c.db.prepare('SELECT email,name,role,employee_id AS employeeId,active,org_scope AS orgScope,view_email AS viewEmail,view_level AS viewLevel,claimed_by AS userId FROM hris_access_grants WHERE tenant_id=? ORDER BY name,email').bind(c.member.tenantId)]);return json({members:rows.results.map((m:any)=>({...m,orgScope:JSON.parse(m.orgScope)})),orgs:JSON.parse(c.row.data).orgs,storageVersion:c.row.storageVersion,revision:c.row.revision,employees:JSON.parse(c.row.data).employees.map((e:{id:string;name:string;status:string})=>({id:e.id,name:e.name,status:e.status}))});}catch(e){return failure(e);}}
export async function POST(request:Request){try{
 const input=grantSchema.parse(await readBody(request));const c=await memberContext(true);
 if(input.revision!==c.row.revision)throw new HttpError(409,'数据已更新，请刷新后重试');
 try{validateGrant(input,JSON.parse(c.row.data),c.user.email);}catch(e){throw new HttpError(400,(e as Error).message);}
 const old=await c.db.prepare('SELECT tenant_id FROM hris_access_grants WHERE email=?').bind(input.email).first<{tenant_id:string}>();
 if(old&&old.tenant_id!==c.member.tenantId)throw new HttpError(409,'该成员无法在此企业重复开通');
 if(input.employeeId&&input.active){const other=await c.db.prepare('SELECT email FROM hris_access_grants WHERE tenant_id=? AND employee_id=? AND active=1 AND email<>?').bind(c.member.tenantId,input.employeeId,input.email).first();if(other)throw new HttpError(409,'此员工已关联其他有效成员');}
 const event=crypto.randomUUID(),now=new Date().toISOString(),tenant=c.member.tenantId;
 await commitLegacy(c.db,c.member,input.revision,'配置成员权限',event=>[
 c.db.prepare('INSERT INTO hris_access_grants(email,tenant_id,name,role,employee_id,active,updated_at,org_scope,view_email,view_level) SELECT ?,owner,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,employee_id=excluded.employee_id,active=excluded.active,updated_at=excluded.updated_at,org_scope=excluded.org_scope,view_email=excluded.view_email,view_level=excluded.view_level WHERE hris_access_grants.tenant_id=excluded.tenant_id').bind(input.email,input.name,input.role,input.employeeId,Number(input.active),now,JSON.stringify(input.orgScope),Number(input.viewEmail),Number(input.viewLevel),tenant,event),
 c.db.prepare('UPDATE hris_memberships SET role=?,employee_id=?,active=?,org_scope=?,view_email=?,view_level=? WHERE tenant_id=? AND user_id=(SELECT claimed_by FROM hris_access_grants WHERE email=? AND tenant_id=?) AND EXISTS (SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(input.role,input.employeeId,Number(input.active),JSON.stringify(input.orgScope),Number(input.viewEmail),Number(input.viewLevel),tenant,input.email,tenant,tenant,event),
 c.db.prepare('INSERT INTO hris_audit_events(tenant_id,id,actor_id,action,subject,at,revision) SELECT owner,?,?,?,?,?,revision FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(event+':member',c.user.id,'配置成员权限',JSON.stringify({email:input.email,role:input.role,active:input.active,employeeId:input.employeeId,orgScope:input.orgScope,viewEmail:input.viewEmail,viewLevel:input.viewLevel}),now,tenant,event),
 ] );return json({ok:true});
 }catch(e){return failure(e);}}
