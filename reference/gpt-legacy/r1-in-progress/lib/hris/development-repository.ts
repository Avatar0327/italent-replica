import {commitLegacy} from './r1-command';
import type {Member} from './authorization';
import {payrollRecordAccess} from './payroll-access';
import {memberContext} from './context';
import {HttpError} from './http';
import type {State} from './model';
import {visibleRecord,projectRecord,type DevelopmentRecord} from './development';
export async function developmentContext(kinds?:readonly DevelopmentRecord['kind'][],allowedRoles?:readonly Member['role'][]){
 const ctx=await memberContext();if(allowedRoles&&!allowedRoles.includes(ctx.member.role))throw new HttpError(403,'当前岗位无权访问此管理报表');if(!ctx.row||ctx.row.storageVersion!==1)throw new HttpError(409,'请先完成企业数据迁移');
 const selection=kinds===undefined?null:[...new Set(kinds)];
 const payrollHistory=selection===null||selection.some(kind=>kind==='payBatch'||kind==='paySlip');
 const kindWhere=selection===null?'':selection.length?' AND kind IN ('+selection.map(()=>'?').join(',')+')':' AND 1=0';
 const result=await ctx.db.batch([
  ctx.db.prepare('SELECT id,kind,employee_id AS employeeId,position_id AS positionId,reference_id AS referenceId,status,payload,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt FROM hris_development_records WHERE tenant_id=?'+kindWhere+' ORDER BY created_at,id').bind(ctx.member.tenantId,...(selection??[])),
  ctx.db.prepare('SELECT revision FROM hris_workspaces WHERE owner=?').bind(ctx.member.tenantId),
  ...(payrollHistory?[ctx.db.prepare("SELECT DISTINCT e.record_id AS recordId,e.actor_id AS actorId FROM hris_development_events e JOIN hris_development_records r ON r.tenant_id=e.tenant_id AND r.id=e.record_id WHERE e.tenant_id=? AND r.kind IN ('payBatch','paySlip') AND e.action IN ('薪酬：batch','薪酬：slip','薪酬：removeSlip','薪酬：submit')").bind(ctx.member.tenantId)]:[]),
 ]);
 // Core scope and extension documents must describe the same revision. A concurrent
 // personnel move or role change invalidates the complete read, including downloads.
 if((result[1].results[0] as {revision:number})?.revision!==ctx.row.revision)throw new HttpError(409,'数据或权限已变化，请刷新');
 const records=(result[0].results as (Omit<DevelopmentRecord,'payload'>&{payload:string})[]).map(v=>({...v,payload:JSON.parse(v.payload)})) as DevelopmentRecord[];
 // Include historical authors from immutable events, even when old payloads did not retain them.
 if(payrollHistory){const authors=new Map<string,Set<string>>();for(const e of result[2].results as {recordId:string;actorId:string}[]){if(!authors.has(e.recordId))authors.set(e.recordId,new Set());authors.get(e.recordId)!.add(e.actorId);}for(const r of records){const actors=authors.get(r.id);if(actors)r.payload.contributors=[...new Set([...(r.payload.contributors??[]),...actors])];}}
 return {...ctx,state:JSON.parse(ctx.row.data) as State,records};
}
export type DevelopmentContext=Awaited<ReturnType<typeof developmentContext>>;
export function visibleDevelopment(ctx:DevelopmentContext){return ctx.records.filter(r=>visibleRecord(r,ctx.records,ctx.state,ctx.member)).map(r=>projectRecord(r,ctx.member,payrollRecordAccess(r,ctx.records,ctx.state,ctx.member)));}
// Every state mutation and audit event share one revision-guarded D1 transaction.
// Callbacks receive a fresh, unique token; zero CAS changes make all later writes no-ops.
export async function commitExtension(ctx:DevelopmentContext,revision:number,action:string,subject:string,statements:(token:string)=>D1PreparedStatement[]){
 if(revision!==ctx.row.revision)throw new HttpError(409,'数据已更新，请刷新后重试');
 await commitLegacy(ctx.db,ctx.member,revision,action,statements);
}

export async function saveDevelopment(ctx:DevelopmentContext,revision:number,r:DevelopmentRecord,action:string,extraStatements?:(token:string)=>D1PreparedStatement[]){
 await commitExtension(ctx,revision,action,`${r.kind} · ${r.id}`,token=>[
 ...(extraStatements?.(token)??[]),
 ctx.db.prepare('INSERT INTO hris_development_records(tenant_id,id,kind,employee_id,position_id,reference_id,status,payload,created_by,created_at,updated_at) SELECT owner,?,?,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status,reference_id=excluded.reference_id,payload=excluded.payload,updated_at=excluded.updated_at').bind(r.id,r.kind,r.employeeId,r.positionId,r.referenceId,r.status,JSON.stringify(r.payload),r.createdBy,r.createdAt,r.updatedAt,ctx.member.tenantId,token),
 ctx.db.prepare('INSERT INTO hris_development_events(tenant_id,id,record_id,revision,action,actor_id,at,snapshot) SELECT owner,?,?,revision,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(token,r.id,action,ctx.member.userId,r.updatedAt,JSON.stringify(r),ctx.member.tenantId,token),
 ]);
}

/** Commit a bounded aggregate and each immutable record snapshot under one CAS revision. */
export async function saveDevelopmentMany(ctx:DevelopmentContext,revision:number,records:DevelopmentRecord[],action:string,recordLimit:20|21=20){
 if(!records.length||records.length>recordLimit||new Set(records.map(r=>r.id)).size!==records.length)throw new HttpError(400,'多记录提交数量或标识无效');
 await commitExtension(ctx,revision,action,records.map(r=>`${r.kind} · ${r.id}`).join(' / '),token=>records.flatMap((r,i)=>[
  ctx.db.prepare('INSERT INTO hris_development_records(tenant_id,id,kind,employee_id,position_id,reference_id,status,payload,created_by,created_at,updated_at) SELECT owner,?,?,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status,reference_id=excluded.reference_id,payload=excluded.payload,updated_at=excluded.updated_at').bind(r.id,r.kind,r.employeeId,r.positionId,r.referenceId,r.status,JSON.stringify(r.payload),r.createdBy,r.createdAt,r.updatedAt,ctx.member.tenantId,token),
  ctx.db.prepare('INSERT INTO hris_development_events(tenant_id,id,record_id,revision,action,actor_id,at,snapshot) SELECT owner,?,?,revision,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(token+':'+i,r.id,action,ctx.member.userId,r.updatedAt,JSON.stringify(r),ctx.member.tenantId,token),
 ]));
}
