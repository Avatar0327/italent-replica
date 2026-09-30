import {m01DomainEvents} from './r1-domain-events';
import {z} from 'zod';
import {applyCommand,commandSchema,type State} from './model';
import {authorizeCommand,scopedOrgs,visibleState,type Member} from './authorization';
import {authorizeTuple} from './r1-authorization';
import {commitCommand,replayCommand,securityStamp,type CommandIntent} from './r1-command';
import {m01Entity,m01Write,type Entity} from './r1-m01';
import {catalogTimeline,previousDay} from './r1-temporal';
import {stateStatements} from './repository';
import {businessDate} from './business-time';
import {HttpError} from './http';
import {transferChangesGrade} from './personnel-transfer';

const input=z.object({operation:z.literal('transfer'),command:commandSchema}).strict();
function fail(message:string,code='INVALID_TRANSFER'):never{throw new HttpError(400,message,code);}
/** D7 remains exactly two independent approvals. The new command transaction also writes stable primary-assignment history. */
export async function executeR1Transfer(ctx:{db:D1Database;member:Member;row:{revision:number;data:string}},intent:CommandIntent){
 const {command:raw}=input.parse(intent.payload),{db,member:m}=ctx,tenant=m.tenantId,stamp=await securityStamp(db,tenant),at=new Date().toISOString(),today=businessDate(at),before=JSON.parse(ctx.row.data) as State;
 if(!stamp.featuresEnabled)throw new HttpError(409,'新能力等待迁移与恢复核验','FEATURE_NOT_READY');
 if(!['request','workflow','decide','withdraw','executeTransfer','cancelTransfer'].includes(raw.action))fail('该入口只接受调动办理');
 if('kind' in raw&&raw.kind!=='transfer')fail('该入口只接受调动办理');
 // Current policy and scope still run before replay; terminal business state runs after replay.
 const existing='id' in raw?before.approvals.find(a=>a.id===raw.id):undefined;
 const personId=raw.action==='request'?raw.employeeId:existing?.employeeId??'';
 const person=before.employees.find(e=>e.id===personId);
 const sourceOrg=existing?.details?.transfer?.source.orgId??person?.orgId;
 const targetOrg=raw.action==='request'?raw.orgId:existing?.details?.transfer?.target.orgId;
 const grant=async(member:Member,orgId:string,field='record')=>authorizeTuple(db,member,{objectType:'M01',action:'transfer.'+raw.action,orgId,personId,field,historyMode:'current'});
 const scope=scopedOrgs(before,m);
 if(raw.action==='workflow'){for(const orgId of scope)await grant(m,orgId);}
 else {
  const orgs=raw.action==='decide'?[existing?.currentStep===1?targetOrg:sourceOrg]:[sourceOrg,targetOrg];
  for(const org of new Set(orgs)){if(!org||!scope.has(org))throw new HttpError(403,'没有当前步骤组织权限','FORBIDDEN');await grant(m,org);}
 }
 const replay=await replayCommand(db,m,stamp,intent);if(replay)return replay;
 const c=authorizeCommand(before,raw,m);
 if(existing&&(!existing.details?.transfer||existing.kind!=='transfer'))fail('历史原单缺少D7约定，不能直接办理');
 if(personId){const fence=await db.prepare('SELECT command_id AS commandId FROM r1_exit_fences WHERE tenant_id=? AND person_id=?').bind(tenant,personId).first<{commandId:string}>();
  if(fence){const employment=await db.prepare("SELECT 1 FROM r1_m01_entities WHERE tenant_id=? AND person_id=? AND kind='employment' AND status='active' AND json_extract(payload,'$.exitFenceObserved')=?").bind(tenant,personId,fence.commandId).first();
   if(!employment||existing?.details?.transfer?.exitFenceObserved!==fence.commandId&&c.action!=='request')fail('退出代次的原单已阻断','BLOCKED_BY_EXIT');
  }
 }
 if(c.action==='request'&&!c.effectiveOn)fail('调动必须指定业务生效日');
 if(c.action==='request'&&c.previousApprovalId&&!visibleState(before,m).approvals.some(a=>a.id===c.previousApprovalId))throw new HttpError(403,'无原单读取权限','FORBIDDEN');
 if(c.action==='workflow'||c.action==='request'){
  const steps=c.action==='workflow'?c.steps:before.workflows?.transfer?.steps;if(steps?.length!==2||steps[0].userId===steps[1].userId)fail('调动必须配置两名独立审批人');
  for(const [i,step] of steps.entries()){
   const reviewer=await db.prepare('SELECT user_id AS userId,tenant_id AS tenantId,employee_id AS employeeId,role,org_scope AS orgScope,view_email AS viewEmail,view_level AS viewLevel,active FROM hris_memberships WHERE tenant_id=? AND user_id=? AND active=1').bind(tenant,step.userId).first<Member>();
   if(!reviewer||!['admin','manager','approver'].includes(reviewer.role))fail('审批人未激活或角色无效');
   reviewer.securityStamp=stamp;
   if(c.action==='request'){
    const orgId=i===0?sourceOrg!:targetOrg!;
    if(reviewer.userId===m.userId||reviewer.employeeId===personId||!scopedOrgs(before,reviewer).has(orgId))fail('审批人不独立或不覆盖步骤组织');
    await authorizeTuple(db,reviewer,{objectType:'M01',action:'transfer.decide',orgId,personId,field:'record',historyMode:'current'});
    if(c.gradeId&&(c.gradeId!==person?.gradeId)){
     if(!reviewer.viewLevel)fail('职级变化必须对两级审批人可见');
     await authorizeTuple(db,reviewer,{objectType:'M01',action:'transfer.decide',orgId,personId,field:'level',historyMode:'current'});
    }
   }
  }
 }
 const changedGrade=c.action==='request'&&c.gradeId&&c.gradeId!==person?.gradeId||existing&&transferChangesGrade(existing);
 if(changedGrade){if(!m.viewLevel)throw new HttpError(403,'职级变化不可盲审或办理','FORBIDDEN');for(const org of new Set(c.action==='decide'?[existing?.currentStep===1?targetOrg:sourceOrg]:[sourceOrg,targetOrg]))if(org)await grant(m,org,'level');}
 let primary:Entity|null=null;
 if(c.action==='request'){
  const found=await db.prepare("SELECT id FROM r1_m01_entities WHERE tenant_id=? AND kind='assignment' AND person_id=? AND status='active' AND json_extract(payload,'$.type')='primary' ORDER BY id LIMIT 2").bind(tenant,personId).all<{id:string}>();
  if(found.results.length!==1)fail('当前主职尚未可靠映射','PRIMARY_MAPPING_REQUIRED');primary=await m01Entity(db,tenant,found.results[0].id);
  if(primary.orgId!==sourceOrg||primary.payload.positionId!==(person?.positionId??null))fail('主职与兼容主档不一致','PRIMARY_MAPPING_REQUIRED');
  const pending=await db.prepare("SELECT 1 FROM r1_m01_entities WHERE tenant_id=? AND person_id=? AND kind IN ('assignment_request','exit_request') AND status IN ('pending','approved','waiting','failed') AND NOT EXISTS(SELECT 1 FROM r1_exit_cleanup x WHERE x.tenant_id=r1_m01_entities.tenant_id AND x.business_id=r1_m01_entities.id) LIMIT 1").bind(tenant,personId).first();if(pending)fail('已有在途人事事项');
 }
 let after:State;try{after=applyCommand(before,c,at,m.userId);}catch(e){fail(e instanceof Error?e.message:'调动状态无效');}
 const changes:Entity[]=[],result:Record<string,unknown>={};
 if(c.action==='request'){
  const approval=after.approvals.find(a=>!before.approvals.some(b=>b.id===a.id))!,t=approval.details!.transfer!;
  t.sourceAssignmentId=primary!.id;t.sourceAssignmentVersion=primary!.revision;t.exitFenceObserved=primary!.payload.exitFenceObserved??null;result.approvalId=approval.id;
 }
 if(c.action==='executeTransfer'){
  const approval=after.approvals.find(a=>a.id===c.id)!,t=approval.details!.transfer!;
  if(t.execution==='applied'){
   let reason:string|null=null;
   try{
    if(!t.sourceAssignmentId||!Number.isSafeInteger(t.sourceAssignmentVersion))fail('原单没有冻结主职版本','PRIMARY_MAPPING_REQUIRED');
    primary=await m01Entity(db,tenant,t.sourceAssignmentId);
    if(primary.revision!==t.sourceAssignmentVersion||primary.status!=='active')fail('来源任职版本已变化，需重新完整审批');
    const orgs=await catalogTimeline(db,tenant,'org');for(const orgId of [t.source.orgId,t.target.orgId])if(!orgs.some(o=>o.id===orgId&&o.status==='active'&&o.payload.validFrom<=today&&(!o.payload.validTo||o.payload.validTo>=today)))fail('来源或目标组织当前版本无效');
    const catalogs=await catalogTimeline(db,tenant,'position'),position=catalogs.find(p=>p.id===t.target.positionId&&p.status==='active'&&p.payload.validFrom<=today&&(!p.payload.validTo||p.payload.validTo>=today));
    if(!position||position.orgId!==t.target.orgId||position.payload.name!==t.target.job)fail('目标岗位当前版本无效');
    const budget=await db.prepare("SELECT payload FROM r1_m01_entities WHERE tenant_id=? AND kind='budget_policy' AND org_id=? AND status='active' LIMIT 1").bind(tenant,t.target.orgId).first<{payload:string}>();if(budget&&JSON.parse(budget.payload).strongBlocking)fail('金额预算服务未接通，强阻断链不可执行','EXTERNAL_BUDGET_REQUIRED');result.budgetStatus='not_checked';
    const plans=await db.prepare("SELECT id,payload FROM hris_development_records WHERE tenant_id=? AND kind='staffingPlan' AND position_id=? AND status='approved' AND json_extract(payload,'$.start')<=? AND json_extract(payload,'$.end')>=? LIMIT 201").bind(tenant,t.target.positionId,today,today).all<{id:string;payload:string}>();if(plans.results.length>200)throw new HttpError(503,'编制版本需有界核验','BOUNDED_QUERY_REQUIRED');
    const decoded=plans.results.map(p=>({...JSON.parse(p.payload),id:p.id})),active=decoded.filter(p=>!decoded.some(x=>x.supersedes===p.id));
    const count=await db.prepare("SELECT COUNT(*) n FROM r1_m01_entities WHERE tenant_id=? AND kind='assignment' AND status='active' AND id<>? AND json_extract(payload,'$.type')='primary' AND json_extract(payload,'$.positionId')=?").bind(tenant,primary.id,t.target.positionId).first<{n:number}>();
    if(primary.payload.positionId!==t.target.positionId&&active.length&&count!.n>=Math.min(...active.map(p=>p.headcount)))fail('目标编制已满');
   }catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;reason=error.message;}
   if(reason){after.employees=structuredClone(before.employees);t.execution='failed';t.failure=reason;delete t.appliedAt;delete t.appliedBy;}
   else {
    changes.push({...primary!,revision:primary!.revision+1,status:'ended',payload:{...primary!.payload,validTo:primary!.payload.validFrom===today?today:previousDay(today),dayProjectionExcluded:primary!.payload.validFrom===today,effectiveToAt:at,endedAt:at,occupancy:0,executionId:intent.commandId}});
    const assignment:Entity={id:crypto.randomUUID(),kind:'assignment',personId,orgId:t.target.orgId,code:null,revision:1,status:'active',payload:{...primary!.payload,orgId:t.target.orgId,positionId:t.target.positionId,gradeId:t.target.gradeId,validFrom:today,validTo:null,dayProjectionExcluded:false,effectiveToAt:null,endedAt:null,effectiveFromAt:at,appliedAt:at,plannedEffectiveOn:t.effectiveOn,occupancy:1,approvalId:approval.id,executionId:intent.commandId}};
    changes.push(assignment);const person=await m01Entity(db,tenant,personId);if(person.kind!=='person')fail('人员稳定身份映射无效','PRIMARY_MAPPING_REQUIRED');changes.push({...person,orgId:t.target.orgId,revision:person.revision+1,payload:{...person.payload,orgId:t.target.orgId,currentPrimaryId:assignment.id}});result.assignmentId=assignment.id;
   }
  }
  result.effectStatus=t.execution;result.approvalId=c.id;
 }
 if('id' in c)result.approvalId=c.id;
 const domainEvents=await m01DomainEvents(db,tenant,intent,changes);
 return commitCommand(db,m,stamp,intent,token=>[...stateStatements(db,tenant,token,before,after,m.userId,at),...changes.flatMap(e=>m01Write(db,tenant,token,e,intent.commandId,at)),...domainEvents(token)],result);
}
