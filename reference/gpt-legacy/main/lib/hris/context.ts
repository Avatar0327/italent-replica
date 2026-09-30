import { getChatGPTUser } from '@/app/chatgpt-auth';
import { env } from 'cloudflare:workers';
import { requireMember, type Member } from './authorization';
import { readWorkspace } from './repository';
import { HttpError } from './http';
export async function identity(){const user=await getChatGPTUser();if(!user)throw new HttpError(401,'请先登录');if(!env.DB)throw Error('DB unavailable');return {user,db:env.DB};}
export async function memberContext(admin=false){
 const {user,db}=await identity();
 const member=await db.prepare('SELECT user_id AS userId,tenant_id AS tenantId,role,employee_id AS employeeId,org_scope AS orgScope,view_email AS viewEmail,view_level AS viewLevel,active FROM hris_memberships WHERE user_id=?').bind(user.id).first<Member>();
 requireMember(member);if(admin&&member.role!=='admin')throw new HttpError(403,'仅系统管理员可管理成员');
 const row=await readWorkspace(db,member.tenantId);
 // Re-read membership after the data snapshot: a scope update between the first
 // membership read and snapshot must not authorize using the old scope and new revision.
 const current=await db.prepare('SELECT user_id AS userId,tenant_id AS tenantId,role,employee_id AS employeeId,org_scope AS orgScope,view_email AS viewEmail,view_level AS viewLevel,active FROM hris_memberships WHERE user_id=?').bind(user.id).first<Member>();
 requireMember(current);if(current.tenantId!==member.tenantId||(admin&&current.role!=='admin'))throw new HttpError(403,'成员权限已变化，请刷新');
 return {user,db,member:current,row};
}

/** Keep supplementary history reads on the same authorization/data revision. */
export async function readConsistent(ctx:Awaited<ReturnType<typeof memberContext>>,statements:D1PreparedStatement[]){
 const result=await ctx.db.batch([...statements,ctx.db.prepare('SELECT revision FROM hris_workspaces WHERE owner=?').bind(ctx.member.tenantId)]);
 const latest=result.at(-1)?.results[0] as {revision:number}|undefined;
 if(!latest||latest.revision!==ctx.row.revision)throw new HttpError(409,'数据或权限已变化，请刷新');
 return result.slice(0,-1);
}
