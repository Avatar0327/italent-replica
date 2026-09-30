import {identity} from './context';
import {requireMember,type Member} from './authorization';
import {securityStamp,sameStamp} from './r1-command';
import {HttpError} from './http';
import {authorizeTuple} from './r1-authorization';
export async function migrationContext(){const {user,db}=await identity(),member=await db.prepare('SELECT user_id AS userId,tenant_id AS tenantId,role,employee_id AS employeeId,org_scope AS orgScope,view_email AS viewEmail,view_level AS viewLevel,active FROM hris_memberships WHERE user_id=?').bind(user.id).first<Member>();requireMember(member);const stamp=await securityStamp(db,member.tenantId);member.securityStamp=stamp;await authorizeTuple(db,member,{objectType:'BASE',action:'migration.manage',orgId:'__tenant__',personId:'',field:'record',historyMode:'current'});const row=await db.prepare('SELECT revision,storage_version AS storageVersion,length(CAST(data AS BLOB)) AS legacyBytes FROM hris_workspaces WHERE owner=?').bind(member.tenantId).first<{revision:number;storageVersion:number;legacyBytes:number}>();if(!row)throw new HttpError(404,'租户不存在','TENANT_NOT_FOUND');if(!sameStamp(stamp,await securityStamp(db,member.tenantId)))throw new HttpError(409,'权限已变化','REVISION_CONFLICT');return {user,db,member,row};}
export type MigrationContext=Awaited<ReturnType<typeof migrationContext>>;
