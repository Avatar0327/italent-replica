import {projectR1Catalogs} from './r1-compatibility';
import {commitLegacy} from './r1-command';
import {HttpError} from './http';
import type {State,Org,Employee,Approval,ApprovalStep,Workflow,Position,Grade} from './model.ts';
import type {Member} from './authorization.ts';
export type WorkspaceRow={data:string;revision:number;storageVersion:number};
const rows=<T>(r:D1Result)=>r.results as T[];
export async function readWorkspace(db:D1Database,tenant:string):Promise<WorkspaceRow>{
 const result=await db.batch([
 db.prepare('SELECT data,revision,storage_version AS storageVersion FROM hris_workspaces WHERE owner=?').bind(tenant),
 db.prepare("SELECT id,name,coalesce(parent_id,'') AS parentId,city,leader,status FROM hris_orgs WHERE tenant_id=? ORDER BY name,id").bind(tenant),
 db.prepare('SELECT id,code,name,org_id AS orgId,job,level,joined,status,email FROM hris_employees WHERE tenant_id=? ORDER BY code,id').bind(tenant),
 db.prepare('SELECT id,employee_id AS employeeId,kind,org_id AS orgId,reason,status,created,created_by AS createdBy,decided,decided_by AS decidedBy,current_step AS currentStep,workflow_version AS workflowVersion,details FROM hris_approvals WHERE tenant_id=? ORDER BY created DESC,id').bind(tenant),
 db.prepare('SELECT approval_id AS approvalId,position,user_id AS userId,name,decision,at FROM hris_approval_steps WHERE tenant_id=? ORDER BY approval_id,position').bind(tenant),
 db.prepare('SELECT kind,version FROM hris_workflows WHERE tenant_id=? AND version=(SELECT max(w.version) FROM hris_workflows w WHERE w.tenant_id=hris_workflows.tenant_id AND w.kind=hris_workflows.kind)').bind(tenant),
 db.prepare('SELECT kind,version,position,user_id AS userId,name FROM hris_workflow_steps WHERE tenant_id=? ORDER BY kind,version,position').bind(tenant),
 db.prepare('SELECT id,actor_id AS actorId,action,subject,at FROM hris_audit_events WHERE tenant_id=? ORDER BY revision DESC,at DESC,id DESC LIMIT 100').bind(tenant),
 db.prepare('SELECT id,code,name,org_id AS orgId,family,responsibilities,status FROM hris_positions WHERE tenant_id=? ORDER BY code').bind(tenant),
 db.prepare('SELECT id,code,name,sequence,status FROM hris_grades WHERE tenant_id=? ORDER BY sequence,code').bind(tenant),
 db.prepare('SELECT employee_id AS employeeId,position_id AS positionId,grade_id AS gradeId FROM hris_employee_positions WHERE tenant_id=?').bind(tenant),
 db.prepare('SELECT approval_id AS approvalId,position_id AS positionId,grade_id AS gradeId FROM hris_assignment_requests WHERE tenant_id=?').bind(tenant),
 ]);
 const row=rows<WorkspaceRow>(result[0])[0];if(!row)throw Error('企业不存在');if(row.storageVersion===0)return row;
 const approvals=rows<Approval>(result[3]);const steps=rows<ApprovalStep&{approvalId:string}>(result[4]);
 for(const a of approvals){if(typeof a.details==='string')a.details=JSON.parse(a.details);if(a.details===null)delete a.details;a.steps=steps.filter(s=>s.approvalId===a.id).map(({userId,name,decision,at})=>({userId,name,...(decision?{decision,at}: {})}));}
 const workflows:State['workflows']={};
 const ws=rows<{kind:Approval['kind'];version:number;userId:string;name:string}>(result[6]);
 for(const w of rows<{kind:Approval['kind'];version:number}>(result[5]))workflows[w.kind]={version:w.version,steps:ws.filter(s=>s.kind===w.kind&&s.version===w.version).map(({userId,name})=>({userId,name}))};
 const employeeRows=rows<Employee>(result[2]);for(const link of rows<{employeeId:string;positionId:string|null;gradeId:string|null}>(result[10])){const e=employeeRows.find(e=>e.id===link.employeeId);if(e){e.positionId=link.positionId;e.gradeId=link.gradeId;}}
 for(const link of rows<{approvalId:string;positionId:string|null;gradeId:string|null}>(result[11])){const a=approvals.find(a=>a.id===link.approvalId);if(a){a.positionId=link.positionId;a.gradeId=link.gradeId;}}
 const state:State={positions:rows<Position>(result[8]),grades:rows<Grade>(result[9]),orgs:rows<Org>(result[1]),employees:employeeRows,approvals,workflows,audit:rows<State['audit'][number]>(result[7])};
 const gate=await db.prepare('SELECT features_enabled AS enabled FROM r1_schema_state WHERE tenant_id=?').bind(tenant).first<{enabled:number}>();
 return {...row,data:JSON.stringify(gate?.enabled?await projectR1Catalogs(db,tenant,state):state)};
}
function orderedOrgs(orgs:Org[]){const ordered:Org[]=[];const visited=new Set<string>(),visiting=new Set<string>();const visit=(o:Org)=>{if(visited.has(o.id))return;if(visiting.has(o.id))throw Error('组织存在循环');visiting.add(o.id);if(o.parentId){const parent=orgs.find(p=>p.id===o.parentId);if(!parent)throw Error('上级组织不存在');visit(parent);}visiting.delete(o.id);visited.add(o.id);ordered.push(o);};orgs.forEach(visit);return ordered;}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Every data statement is gated by the same successful compare-and-swap token. */
export function stateStatements(db:D1Database,tenant:string,token:string,before:State,after:State,actor:string,at:string){
 const out:D1PreparedStatement[]=[];
 const put=(table:string,columns:string[],values:unknown[],keys:string[],immutable=false)=>{
  const all=['tenant_id',...columns],update=columns.filter(c=>!keys.includes(c)).map(c=>`${c}=excluded.${c}`).join(',');
  const conflict=immutable?'DO NOTHING':`DO UPDATE SET ${update}`;
  out.push(db.prepare(`INSERT INTO ${table} (${all.join(',')}) SELECT owner,${columns.map(()=>'?').join(',')} FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,${keys.join(',')}) ${conflict}`).bind(...values.map(v=>v??null),tenant,token));
 };
 for(const o of orderedOrgs(after.orgs)){if(equal(o,before.orgs.find(x=>x.id===o.id)))continue;put('hris_orgs',['id','name','parent_id','city','leader','status'],[o.id,o.name,o.parentId||null,o.city,o.leader,o.status],['id']);}
 for(const g of after.grades??[]){if(equal(g,before.grades?.find(x=>x.id===g.id)))continue;put('hris_grades',['id','code','name','sequence','status'],[g.id,g.code,g.name,g.sequence,g.status],['id']);}
 for(const p of after.positions??[]){if(equal(p,before.positions?.find(x=>x.id===p.id)))continue;put('hris_positions',['id','code','name','org_id','family','responsibilities','status'],[p.id,p.code,p.name,p.orgId,p.family,p.responsibilities,p.status],['id']);}
 for(const e of after.employees){const old=before.employees.find(x=>x.id===e.id);if(equal(e,old))continue;
 put('hris_employees',['id','code','name','org_id','job','level','joined','status','email'],[e.id,e.code,e.name,e.orgId,e.job,e.level,e.joined,e.status,e.email],['id']);
 put('hris_employee_positions',['employee_id','position_id','grade_id'],[e.id,e.positionId,e.gradeId],['employee_id']);
 if(!old||old.positionId!==e.positionId||old.gradeId!==e.gradeId||old.orgId!==e.orgId||old.status!==e.status||old.job!==e.job||old.level!==e.level)put('hris_employment_history',['id','employee_id','event_id','at','actor_id','from_org_id','to_org_id','from_status','to_status','job','level'],[`${token}:${e.id}`,e.id,token,at,actor,old?.orgId,e.orgId,old?.status,e.status,e.job,e.level],['id'],true);
 }
 for(const [kind,w] of Object.entries(after.workflows??{}) as [Approval['kind'],Workflow][]){if(equal(w,before.workflows?.[kind]))continue;
 put('hris_workflows',['kind','version'],[kind,w.version],['kind','version'],true);
 w.steps.forEach((step,i)=>put('hris_workflow_steps',['kind','version','position','user_id','name'],[kind,w.version,i,step.userId,step.name],['kind','version','position'],true));
 }
 for(const a of after.approvals){const old=before.approvals.find(x=>x.id===a.id);if(equal(a,old))continue;
 put('hris_approvals',['id','employee_id','kind','org_id','reason','status','created','created_by','decided','decided_by','current_step','workflow_version','details'],[a.id,a.employeeId,a.kind,a.orgId,a.reason,a.status,a.created,a.createdBy,a.decided,a.decidedBy,a.currentStep,a.workflowVersion,a.details?JSON.stringify(a.details):null],['id']);
 put('hris_assignment_requests',['approval_id','position_id','grade_id'],[a.id,a.positionId,a.gradeId],['approval_id']);
 a.steps?.forEach((step,i)=>put('hris_approval_steps',['approval_id','position','user_id','name','decision','at'],[a.id,i,step.userId,step.name,step.decision,step.at],['approval_id','position']));
 }
 for(const event of after.audit){if(before.audit.some(a=>a.id===event.id))continue;
 out.push(db.prepare('INSERT INTO hris_audit_events(tenant_id,id,actor_id,action,subject,at,revision) SELECT owner,?,?,?,?,?,revision FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,id) DO NOTHING').bind(event.id,event.actorId??'legacy-unattributed',event.action,event.subject,event.at,tenant,token));
 }
 return out;
}
export async function commitState(db:D1Database,member:Member,revision:number,before:State,after:State){
 const event=after.audit[0];
 await commitLegacy(db,member,revision,event.action,token=>stateStatements(db,member.tenantId,token,before,after,member.userId,event.at));return true;
}

export async function migrateWorkspace(db:D1Database,member:Member,row:WorkspaceRow):Promise<boolean>{
 throw new HttpError(409,'旧迁移入口已关闭，请使用有界迁移器','CLIENT_UPGRADE_REQUIRED');
}
