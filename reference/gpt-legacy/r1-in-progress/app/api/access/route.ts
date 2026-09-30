import {securityStamp} from '@/lib/hris/r1-command';
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
 db.prepare('INSERT INTO r1_schema_state(tenant_id) VALUES (?)').bind(tenant),
 ]);return json({ok:true});
 }
 const grant=await db.prepare('SELECT tenant_id AS tenantId FROM hris_access_grants WHERE email=? AND active=1 AND claimed_by IS NULL').bind(user.email.toLowerCase()).first<{tenantId:string}>();
 if(!grant)throw new HttpError(403,'未找到可激活的成员授权');
 const stamp=await securityStamp(db,grant.tenantId),id=crypto.randomUUID(),tenant=grant.tenantId;
 const result=await db.batch([
 db.prepare(`INSERT INTO r1_commands(tenant_id,command_id,actor_id,action,idempotency_key,request_digest,token,status,workspace_revision,authorization_revision,writer_epoch,recovery_epoch,created_at)
 SELECT w.owner,?,?,'member.activate',?,?,?,'processing',w.revision,s.authorization_revision,s.writer_epoch,s.recovery_epoch,?
 FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner JOIN hris_access_grants g ON g.tenant_id=w.owner
 WHERE w.owner=? AND g.email=? AND g.active=1 AND g.claimed_by IS NULL AND s.open_gate=1 AND s.authorization_revision=? AND s.writer_epoch=? AND s.recovery_epoch=?`).bind(id,user.id,id,id,id,now,tenant,user.email.toLowerCase(),stamp.authorizationRevision,stamp.writerEpoch,stamp.recoveryEpoch),
 db.prepare("UPDATE hris_workspaces SET revision=revision+1,last_mutation=? WHERE owner=? AND EXISTS(SELECT 1 FROM r1_commands c WHERE c.tenant_id=hris_workspaces.owner AND c.token=? AND c.status='processing' AND c.workspace_revision=hris_workspaces.revision)").bind(id,tenant,id),
 db.prepare("INSERT INTO hris_memberships(user_id,tenant_id,role,employee_id,active,org_scope,view_email,view_level) SELECT ?,g.tenant_id,g.role,g.employee_id,1,g.org_scope,g.view_email,g.view_level FROM hris_access_grants g JOIN hris_workspaces w ON w.owner=g.tenant_id WHERE g.email=? AND g.active=1 AND g.claimed_by IS NULL AND w.last_mutation=?").bind(user.id,user.email.toLowerCase(),id),
 db.prepare('UPDATE hris_access_grants SET claimed_by=?,updated_at=? WHERE email=? AND claimed_by IS NULL AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(user.id,now,user.email.toLowerCase(),tenant,id),
 db.prepare('INSERT INTO hris_audit_events(tenant_id,id,actor_id,action,subject,at,revision) SELECT owner,?,?,?,?,?,revision FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(id,user.id,'激活企业成员',user.id,now,tenant,id),
 db.prepare("INSERT INTO r1_outbox(tenant_id,event_id,command_id,event_type,workspace_revision,payload) SELECT owner,?,?,'binding.changed',revision,'{}' FROM hris_workspaces WHERE owner=? AND last_mutation=?").bind(id,id,tenant,id),
 db.prepare("UPDATE r1_commands SET status='committed' WHERE tenant_id=? AND token=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)").bind(tenant,id,tenant,id),
 ]);if(!result[1].meta.changes)throw new HttpError(409,'授权或恢复水位已变化');return json({ok:true,commandId:id});
 }catch(e){return failure(e);}}
