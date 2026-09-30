import type { Member } from './authorization';
import { requireMember } from './authorization';
import { HttpError } from './http';

export type SecurityStamp = {
 authorizationRevision:number; writerEpoch:number; recoveryEpoch:number;
 openGate:number; phase:string; featuresEnabled:number; externalSecurityEpoch?:number;
};
export async function securityStamp(db:D1Database,tenant:string):Promise<SecurityStamp> {
 const s=await db.prepare('SELECT authorization_revision AS authorizationRevision,writer_epoch AS writerEpoch,recovery_epoch AS recoveryEpoch,open_gate AS openGate,phase,features_enabled AS featuresEnabled FROM r1_schema_state WHERE tenant_id=?').bind(tenant).first<SecurityStamp>();
 if(!s||!s.openGate)throw new HttpError(503,'恢复隔离中或授权水位不可用','RECOVERY_ISOLATED');
 const {assertRuntimeSecurity}=await import('./r1-security-runtime');await assertRuntimeSecurity(db,tenant,s);return s;
}
export function sameStamp(a:SecurityStamp,b:SecurityStamp){return a.authorizationRevision===b.authorizationRevision&&a.writerEpoch===b.writerEpoch&&a.recoveryEpoch===b.recoveryEpoch&&b.openGate===1&&a.externalSecurityEpoch===b.externalSecurityEpoch;}
export function canonical(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 throw new HttpError(400,'不支持的命令值','INVALID_INPUT');
}
export async function digest(value:unknown){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
export type CommandIntent={correlationId?:string;causationId?:string;commandId:string;idempotencyKey:string;action:string;payload:unknown;expectedWorkspaceRevision:number;expectedAuthorizationRevision:number;expectedWriterEpoch:number;expectedRecoveryEpoch:number};
export function commandTrace(intent:CommandIntent){const trace:Record<string,string>={};for(const key of ['correlationId','causationId'] as const)if(intent[key]!==undefined){if(!/^[A-Za-z0-9:_-]{1,100}$/.test(intent[key]!))throw new HttpError(400,'追踪标识无效','INVALID_INPUT');trace[key]=intent[key]!;}return trace;}
type Receipt={commandId:string;requestDigest:string;status:string;result:string;workspaceRevision:number};
export async function replayCommand(db:D1Database,m:Member,stamp:SecurityStamp,intent:CommandIntent){
 requireMember(m);
 if(!sameStamp(stamp,await securityStamp(db,m.tenantId))||intent.expectedAuthorizationRevision!==stamp.authorizationRevision||intent.expectedWriterEpoch!==stamp.writerEpoch||intent.expectedRecoveryEpoch!==stamp.recoveryEpoch)throw new HttpError(409,'权限或写入版本已变化','REVISION_CONFLICT');
 const prior=await db.prepare('SELECT command_id AS commandId,request_digest AS requestDigest,status,result,workspace_revision+1 AS workspaceRevision FROM r1_commands WHERE tenant_id=? AND actor_id=? AND action=? AND idempotency_key=?').bind(m.tenantId,m.userId,intent.action,intent.idempotencyKey).first<Receipt>();
 if(!prior)return null;
 const requestDigest=await digest({...commandTrace(intent),action:intent.action,payload:intent.payload,expectedWorkspaceRevision:intent.expectedWorkspaceRevision,expectedAuthorizationRevision:intent.expectedAuthorizationRevision,expectedWriterEpoch:intent.expectedWriterEpoch,expectedRecoveryEpoch:intent.expectedRecoveryEpoch});
 if(prior.requestDigest!==requestDigest||prior.commandId!==intent.commandId)throw new HttpError(409,'同一命令键内容冲突','IDEMPOTENCY_CONFLICT');
 if(prior.status!=='committed')throw new HttpError(409,'命令未确认或已归档，请查询原回执','COMMAND_RECEIPT_REQUIRED');
 return {...prior,result:JSON.parse(prior.result) as Record<string,unknown>,replayed:true};
}
export async function commandReceipt(db:D1Database,m:Member,commandId:string){
 requireMember(m);const current=await securityStamp(db,m.tenantId);if(m.securityStamp&&!sameStamp(m.securityStamp,current))throw new HttpError(409,'当前授权已变化','REVISION_CONFLICT');
 // Actor-bound receipt contains only IDs; object data must be read through its current policy.
 return db.prepare('SELECT command_id AS commandId,status,result,workspace_revision+1 AS workspaceRevision FROM r1_commands WHERE tenant_id=? AND actor_id=? AND command_id=? AND EXISTS(SELECT 1 FROM hris_memberships m WHERE m.tenant_id=r1_commands.tenant_id AND m.user_id=r1_commands.actor_id AND m.active=1)').bind(m.tenantId,m.userId,commandId).first();
}
/** Only service-validated SQL plans enter here. Callers must authorize the business action. */
async function commitCommandInternal(db:D1Database,m:Member,stamp:SecurityStamp,intent:CommandIntent,plan:(token:string)=>D1PreparedStatement[],result:Record<string,unknown>={},legacyStorage=false,normalizeComplete=false,control?:{phase:string;featuresEnabled:0|1;bumpWriterEpoch:boolean}) {
 requireMember(m);
 if(!sameStamp(stamp,await securityStamp(db,m.tenantId)))throw new HttpError(409,'授权水位已变化','REVISION_CONFLICT');
 for(const v of [intent.expectedWorkspaceRevision,intent.expectedAuthorizationRevision,intent.expectedWriterEpoch,intent.expectedRecoveryEpoch])if(!Number.isSafeInteger(v)||v<0)throw new HttpError(400,'版本号无效','INVALID_INPUT');
 if(!intent.commandId||!intent.idempotencyKey||!intent.action)throw new HttpError(400,'缺少命令标识','INVALID_INPUT');
 if(intent.expectedAuthorizationRevision!==stamp.authorizationRevision||intent.expectedWriterEpoch!==stamp.writerEpoch||intent.expectedRecoveryEpoch!==stamp.recoveryEpoch)throw new HttpError(409,'权限或写入版本已变化','REVISION_CONFLICT');
 const requestDigest=await digest({...commandTrace(intent),action:intent.action,payload:intent.payload,expectedWorkspaceRevision:intent.expectedWorkspaceRevision,expectedAuthorizationRevision:intent.expectedAuthorizationRevision,expectedWriterEpoch:intent.expectedWriterEpoch,expectedRecoveryEpoch:intent.expectedRecoveryEpoch});
 const prior=await db.prepare('SELECT command_id AS commandId,request_digest AS requestDigest,status,result,workspace_revision+1 AS workspaceRevision FROM r1_commands WHERE tenant_id=? AND actor_id=? AND action=? AND idempotency_key=?').bind(m.tenantId,m.userId,intent.action,intent.idempotencyKey).first<Receipt>();
 if(prior){if(prior.requestDigest!==requestDigest||prior.commandId!==intent.commandId)throw new HttpError(409,'同一命令键内容冲突','IDEMPOTENCY_CONFLICT');if(prior.status==='archived')throw new HttpError(409,'命令已归档，请查历史回执','IDEMPOTENCY_ARCHIVED');return {...prior,result:JSON.parse(prior.result),replayed:true};}
 const token=crypto.randomUUID(),at=new Date().toISOString();
 const body=plan(token);if(body.length>74)throw new HttpError(413,'请按受控批次提交','TRANSACTION_TOO_LARGE');
 const tenant=m.tenantId,revision=intent.expectedWorkspaceRevision;
 const event={schemaVersion:1,eventId:token,eventType:'command.committed',tenantId:tenant,source:'BASE',internalId:intent.commandId,externalId:null,entityRevision:1,workspaceRevision:revision+1,definitionVersion:'r1-command-v1',sourceRevision:revision,occurredAt:at,effectiveAt:at,correlationId:intent.correlationId??intent.commandId,causationId:intent.causationId??intent.commandId,digestAlgorithm:'sha256-canonical-json-v1',payload:{commandId:intent.commandId,action:intent.action}};
 const eventPayload=JSON.stringify({...event,digest:await digest(event)});
 const memberScope=typeof m.orgScope==='string'?m.orgScope:JSON.stringify(m.orgScope??[]);
 const {prepareRuntimeSecurityWrite}=await import('./r1-security-runtime');const securityLease=await prepareRuntimeSecurityWrite({tenant,commandId:intent.commandId,requestDigest,authorizationRevision:stamp.authorizationRevision,workspaceRevision:revision,recoveryEpoch:stamp.recoveryEpoch});if(securityLease)m.permissionValidUntil=Math.min(m.permissionValidUntil??Number.MAX_SAFE_INTEGER,securityLease.expiresAt);
 const statements=[
  db.prepare(`INSERT INTO r1_commands(tenant_id,command_id,actor_id,action,idempotency_key,request_digest,token,status,workspace_revision,authorization_revision,writer_epoch,recovery_epoch,created_at)
   SELECT w.owner,?,?,?,?,?,?,'processing',w.revision,s.authorization_revision,s.writer_epoch,s.recovery_epoch,?
   FROM hris_workspaces w JOIN r1_schema_state s ON s.tenant_id=w.owner JOIN hris_memberships m ON m.tenant_id=w.owner
   WHERE w.owner=? AND w.revision=? AND w.storage_version=${legacyStorage?0:1} AND s.open_gate=1 AND s.authorization_revision=? AND s.writer_epoch=? AND s.recovery_epoch=?
   AND m.user_id=? AND m.active=1 AND m.role=? AND m.employee_id IS ? AND m.org_scope=? AND m.view_email=? AND m.view_level=? AND (julianday('now')-2440587.5)*86400000<?`).bind(intent.commandId,m.userId,intent.action,intent.idempotencyKey,requestDigest,token,at,tenant,revision,stamp.authorizationRevision,stamp.writerEpoch,stamp.recoveryEpoch,m.userId,m.role,m.employeeId,memberScope,Number(!!m.viewEmail),Number(!!m.viewLevel),m.permissionValidUntil??Number.MAX_SAFE_INTEGER),
  db.prepare(`UPDATE hris_workspaces SET revision=revision+1,last_mutation=?${normalizeComplete?",storage_version=1":""} WHERE owner=? AND revision=? AND EXISTS(SELECT 1 FROM r1_commands WHERE tenant_id=? AND token=? AND status='processing')`).bind(token,tenant,revision,tenant,token),
  ...body,
  db.prepare('INSERT INTO hris_audit_events(tenant_id,id,actor_id,action,subject,at,revision) SELECT owner,?,?,?,?,?,revision FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(token,m.userId,intent.action,intent.commandId,at,tenant,token),
  db.prepare('INSERT INTO r1_outbox(tenant_id,event_id,command_id,event_type,workspace_revision,payload) SELECT owner,?,?,?,revision,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(token,intent.commandId,intent.action,eventPayload,tenant,token),
  ...(control?[db.prepare('UPDATE r1_schema_state SET phase=?,features_enabled=?,writer_epoch=writer_epoch+? WHERE tenant_id=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)').bind(control.phase,control.featuresEnabled,Number(control.bumpWriterEpoch),tenant,tenant,token)]:[]),
  db.prepare("UPDATE r1_commands SET status='committed',result=? WHERE tenant_id=? AND token=? AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)").bind(JSON.stringify(result),tenant,token,tenant,token),
 ];
 const committed=await db.batch(statements);
 if(!committed[1].meta.changes)throw new HttpError(409,'数据、字段授权或恢复版本已变化','REVISION_CONFLICT');
 if(securityLease)await securityLease.finalize();
 return {commandId:intent.commandId,status:'committed',result,workspaceRevision:revision+1,replayed:false};
}
export async function commitCommand(db:D1Database,m:Member,stamp:SecurityStamp,intent:CommandIntent,plan:(token:string)=>D1PreparedStatement[],result:Record<string,unknown>={}){return commitCommandInternal(db,m,stamp,intent,plan,result);}
export async function commitMigrationTransaction(db:D1Database,m:Member,stamp:SecurityStamp,intent:CommandIntent,plan:(token:string)=>D1PreparedStatement[],result:Record<string,unknown>,options:{storageVersion:0|1;normalizeComplete?:boolean;control?:{phase:string;featuresEnabled:0|1;bumpWriterEpoch:boolean}}){
 if(!intent.action.startsWith('BASE.migration.')||options.storageVersion===0&&stamp.featuresEnabled)throw new HttpError(409,'迁移必须经过专用写屏障','MIGRATION_GATE_REQUIRED');const {authorizeTuple}=await import('./r1-authorization');await authorizeTuple(db,m,{objectType:'BASE',action:'migration.manage',orgId:'__tenant__',personId:'',field:'record',historyMode:'current'});return commitCommandInternal(db,m,stamp,intent,plan,result,options.storageVersion===0,!!options.normalizeComplete,options.control);
}
export async function commitLegacy(db:D1Database,m:Member,revision:number,action:string,plan:(token:string)=>D1PreparedStatement[]){
 const stamp=m.securityStamp;
 if(!stamp)throw new HttpError(409,'请重新读取当前授权','CLIENT_UPGRADE_REQUIRED');
 if(stamp.featuresEnabled||['read_switched','features_enabled','monitored'].includes(stamp.phase))throw new HttpError(409,'请使用新版命令接口','CLIENT_UPGRADE_REQUIRED');
 const id=crypto.randomUUID();
 return commitCommand(db,m,stamp,{commandId:id,idempotencyKey:id,action,payload:{legacyRevision:revision},expectedWorkspaceRevision:revision,expectedAuthorizationRevision:stamp.authorizationRevision,expectedWriterEpoch:stamp.writerEpoch,expectedRecoveryEpoch:stamp.recoveryEpoch},plan);
}
