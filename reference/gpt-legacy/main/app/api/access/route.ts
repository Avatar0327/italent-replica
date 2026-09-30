import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { identity } from '@/lib/hris/context';
import { json, failure, readBody, HttpError } from '@/lib/hris/http';
export const dynamic='force-dynamic';
const ownerEmail=()=>((env as unknown as Record<string,string>).HRIS_SETUP_OWNER_EMAIL??'').trim().toLowerCase();
export async function GET(){try{
 const {db,user}=await identity();
 const member=await db.prepare('SELECT role,active FROM hris_memberships WHERE user_id=?').bind(user.id).first<{role:string;active:number}>();
 const setup=await db.prepare('SELECT name FROM hris_installation WHERE id=?').bind('primary').first<{name:string}>();
 const grant=await db.prepare('SELECT active,claimed_by FROM hris_access_grants WHERE email=?').bind(user.email.toLowerCase()).first<{active:number;claimed_by:string|null}>();
 return json({email:user.email,role:member?.active?member.role:null,canSetup:!setup&&!member&&user.email.toLowerCase()===ownerEmail(),canActivate:!member&&!!grant?.active&&(!grant.claimed_by||grant.claimed_by===user.id),company:setup?.name??null});
 }catch(e){return failure(e);}}
export async function POST(request:Request){try{
 const input=z.discriminatedUnion('action',[z.object({action:z.literal('setup'),name:z.string().trim().min(2).max(100)}),z.object({action:z.literal('activate')})]).parse(await readBody(request));
 const {db,user}=await identity();const now=new Date().toISOString();
 if(input.action==='setup'){
 if(!ownerEmail()||user.email.toLowerCase()!==ownerEmail())throw new HttpError(403,'当前账号无企业初始化权限');
 const existing=await db.prepare('SELECT id FROM hris_installation WHERE id=?').bind('primary').first();if(existing)throw new HttpError(409,'企业已初始化，请刷新');
 const tenant=crypto.randomUUID(),event=crypto.randomUUID();
 await db.batch([
 db.prepare('INSERT INTO hris_workspaces(owner,data,storage_version) VALUES (?,?,1)').bind(tenant,JSON.stringify({orgs:[],employees:[],approvals:[],audit:[]})),
 db.prepare('INSERT INTO hris_installation(id,tenant_id,owner_id,name,created_at) VALUES (?,?,?,?,?)').bind('primary',tenant,user.id,input.name,now),
 db.prepare('INSERT INTO hris_memberships(user_id,tenant_id,role,active) VALUES (?,?,?,1)').bind(user.id,tenant,'admin'),
 db.prepare('INSERT INTO hris_access_grants(email,tenant_id,name,role,active,claimed_by,updated_at) VALUES (?,?,?,?,1,?,?)').bind(user.email.toLowerCase(),tenant,user.displayName,'admin',user.id,now),
 db.prepare('INSERT INTO hris_audit_events(tenant_id,id,actor_id,action,subject,at,revision) VALUES (?,?,?,?,?,?,0)').bind(tenant,event,user.id,'初始化企业',input.name,now),
 ]);return json({ok:true});
 }
 const result=await db.batch([
 db.prepare('INSERT INTO hris_memberships(user_id,tenant_id,role,employee_id,active,org_scope,view_email,view_level) SELECT ?,tenant_id,role,employee_id,1,org_scope,view_email,view_level FROM hris_access_grants WHERE email=? AND active=1 AND claimed_by IS NULL').bind(user.id,user.email.toLowerCase()),
 db.prepare('UPDATE hris_access_grants SET claimed_by=?,updated_at=? WHERE email=? AND claimed_by IS NULL AND EXISTS (SELECT 1 FROM hris_memberships m WHERE m.user_id=? AND m.tenant_id=hris_access_grants.tenant_id)').bind(user.id,now,user.email.toLowerCase(),user.id),
 db.prepare('INSERT INTO hris_audit_events(tenant_id,id,actor_id,action,subject,at,revision) SELECT g.tenant_id,?,?,?,?,?,w.revision FROM hris_access_grants g JOIN hris_workspaces w ON w.owner=g.tenant_id WHERE g.email=? AND g.claimed_by=? AND g.updated_at=?').bind(crypto.randomUUID(),user.id,'激活企业成员',user.email,now,user.email.toLowerCase(),user.id,now),
 ]);if(!result[0].meta.changes)throw new HttpError(403,'未找到可激活的成员授权，请联系管理员');return json({ok:true});
 }catch(e){return failure(e);}}
