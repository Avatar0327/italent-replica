import {m01DomainEvents} from './r1-domain-events';
import {z} from 'zod';
import {identityKey,resolveIdentity,prepareIdentityKeys,captureR1ContractFields} from './r1-personnel-data';
import {stateStatements} from './repository';
import {HttpError} from './http';
import {businessDate} from './business-time';
import {commitCommand,securityStamp,digest,replayCommand,type CommandIntent} from './r1-command';
import {authorizeTuple} from './r1-authorization';
import {scopedOrgs,type Member} from './authorization';
import type {State} from './model';
import {catalogTimeline,effectiveVersions,temporalCatalogCheck,previousDay} from './r1-temporal';

const short=z.string().trim().min(1).max(100);
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return !isNaN(+d)&&d.toISOString().slice(0,10)===s;});
const interval={validFrom:date,validTo:date.nullable()};
const catalogKind=z.enum(['org','position','job','job_family','grade','legal_entity']);
const subsetKind=z.enum(['education','employment','family','appraisal','training','reward','certificate','project','skill','language','custom']);
const field=z.object({code:id,type:z.enum(['text','number','date','enum','attachment']),required:z.boolean(),default:z.union([z.string(),z.number().int().safe(),z.null()]),uniqueKey:z.boolean(),readActions:z.array(id).min(1),writeActions:z.array(id).min(1),options:z.array(text).optional(),unit:z.string().optional(),precision:z.number().int().min(0).max(6).optional()}).strict();
export const m01Input=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('regularizeRequest'),personId:id,orgId:id,reason:text}).strict(),
 z.object({operation:z.literal('catalog'),id:id.optional(),kind:catalogKind,closePreviousVersion:z.number().int().positive().optional(),code:short,name:short,orgId:z.string(),parentId:z.string(),status:z.enum(['active','inactive']),...interval,attributes:z.object({abbr:z.string().max(100).optional(),city:z.string().max(100).optional(),jobId:id.optional(),familyId:id.optional(),gradeMinId:id.optional(),gradeMaxId:id.optional(),sequence:z.number().int().min(0).max(999).optional(),establishedOn:date.optional(),newType:z.enum(['New','Backfill']).optional(),responsibilities:z.string().max(4000).optional(),includeDescendants:z.boolean().optional(),dottedParentPositionId:id.optional(),keyPosition:z.boolean().optional(),legacyLeader:z.string().max(100).optional(),orgIds:z.array(id).optional(),extraPersonIds:z.array(id).optional()}).strict()}).strict(),
 z.object({operation:z.literal('identityReview'),personId:id,candidateIds:z.array(id).min(1),identifiers:z.array(identityKey).min(1).max(4).optional(),reason:text,evidenceRef:id}).strict(),
 z.object({operation:z.literal('identityBind'),personId:id,orgId:id,identifiers:z.array(identityKey).min(1).max(4),evidenceRef:id}).strict(),
 z.object({operation:z.literal('contractField'),id:id.optional(),orgId:id,code:z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/),name:text,inheritPrevious:z.boolean(),status:z.enum(['active','archived'])}).strict(),
 z.object({operation:z.literal('person'),code:short,name:short,orgId:id,identifiers:z.array(identityKey).max(4).optional(),templateId:id,entryType:z.enum(['employee_create','prehire','onboard']),fields:z.record(z.unknown())}).strict(),
 z.object({operation:z.literal('employment'),personId:id,orgId:id,identityReviewId:id,predecessorId:id.nullable(),startOn:date,employmentType:z.enum(['employee','internship','retired_rehire'])}).strict(),
 z.object({operation:z.literal('assignmentRequest'),personId:id,employmentId:id,orgId:id,positionId:id,gradeId:id.nullable().optional(),replacesAssignmentId:id.optional(),endAssignmentId:id.optional(),type:z.enum(['primary','part_time','secondment','expatriate']),homePrimaryId:id.nullable(),...interval,reviewerId:id,reason:text}).strict(),
 z.object({operation:z.literal('assignmentCancel'),id,reason:text}).strict(),z.object({operation:z.literal('exitCancel'),id,reason:text}).strict(),z.object({operation:z.literal('assignmentApprove'),id}).strict(),z.object({operation:z.literal('assignmentExecute'),id}).strict(),
 z.object({operation:z.literal('exitRequest'),personId:id,orgId:id,lastWorkingOn:date,reviewerId:id,reason:text}).strict(),z.object({operation:z.literal('exitApprove'),id}).strict(),z.object({operation:z.literal('exitExecute'),id}).strict(),
 z.object({operation:z.literal('exitCleanup'),personId:id,orgId:id,limit:z.number().int().min(1).max(20)}).strict(),
 z.object({operation:z.literal('contract'),id:id.optional(),personId:id,orgId:id,legalEntityId:id,number:short,agreementCategory:z.enum(['labor','service','internship']),contractType:z.enum(['fixed','open','project']),start:date,end:date.nullable(),renewalOf:id.nullable(),fields:z.record(z.union([z.string().max(1000),z.null()]))}).strict(),
 z.object({operation:z.literal('contractSign'),id,signedOn:date,evidence:text}).strict(),z.object({operation:z.literal('contractEnd'),id,endedOn:date,evidence:text}).strict(),
 z.object({operation:z.literal('template'),id:id.optional(),orgId:id,kind:subsetKind,entryType:z.enum(['employee_create','prehire','onboard','subset']),fields:z.array(field).min(1).max(20)}).strict(),
 z.object({operation:z.literal('subsetImport'),personId:id,orgId:id,templateId:id,templateVersion:z.number().int().positive(),batchId:id,rowNo:z.number().int().positive(),attemptVersion:z.number().int().positive(),mode:z.enum(['create','update']),recordId:id.nullable(),fields:z.record(z.unknown())}).strict(),
]);
export type M01Input=z.infer<typeof m01Input>;
export type Entity={id:string;kind:string;personId:string|null;orgId:string|null;code:string|null;revision:number;status:string;payload:Record<string,any>};
export const overlaps=(a:{validFrom:string;validTo:string|null},b:{validFrom:string;validTo:string|null})=>a.validFrom<=(b.validTo??'9999-12-31')&&b.validFrom<=(a.validTo??'9999-12-31');
export const nextDay=(day:string)=>new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10);
export function tenure(segments:{startOn:string|null;lastWorkingOn:string|null;status:string;employmentType:string;historyIncomplete?:boolean}[],asOf:string){
 const ranges: [number,number][]=[];
 for(const s of segments){if(s.historyIncomplete)return {days:null,years:null,reasonCode:'HISTORY_UNVERIFIABLE'};if(s.employmentType==='internship')continue;if(!s.startOn||s.status==='ended'&&!s.lastWorkingOn)return {days:null,years:null,reasonCode:'HISTORY_UNVERIFIABLE'};if(s.status==='cancelled'||s.startOn>asOf)continue;ranges.push([Date.parse(s.startOn),Date.parse(s.lastWorkingOn&&s.lastWorkingOn<asOf?s.lastWorkingOn:asOf)]);}
 ranges.sort((a,b)=>a[0]-b[0]);const merged:[number,number][]=[];for(const [a,b] of ranges){const last=merged.at(-1);if(last&&a<=last[1]+86400000)last[1]=Math.max(last[1],b);else merged.push([a,b]);}
 const days=merged.reduce((n,[a,b])=>n+(b-a)/86400000+1,0);return {days,years:Math.round(days/365*100)/100,reasonCode:null};
}
function invalid(message:string,code='INVALID_INPUT'):never{throw new HttpError(400,message,code);}
const parse=(r:any):Entity=>({...r,payload:JSON.parse(r.payload)});
const select='SELECT id,kind,person_id AS personId,org_id AS orgId,code,revision,status,payload FROM r1_m01_entities';
export async function m01Entity(db:D1Database,tenant:string,entityId:string){const r=await db.prepare(select+' WHERE tenant_id=? AND id=?').bind(tenant,entityId).first();if(!r)throw new HttpError(404,'记录不存在或不可见','NOT_FOUND_OR_NOT_VISIBLE');return parse(r);}
async function rows(db:D1Database,tenant:string,kind:string,personId?:string){const r=await db.prepare(select+' WHERE tenant_id=? AND kind=?'+(personId?' AND person_id=?':'')+' ORDER BY id LIMIT 201').bind(tenant,kind,...(personId?[personId]:[])).all();if(r.results.length>200)throw new HttpError(503,'需要有界版本查询计划','BOUNDED_QUERY_REQUIRED');return r.results.map(parse);}
export function m01Write(db:D1Database,tenant:string,token:string,e:Entity,commandId:string,at:string){
 if(e.payload.migrationObservation)e={...e,payload:{...e.payload,migrationObservation:false,migrationModifiedByCommand:commandId}};
 const occupancy=e.kind==='assignment'?[db.prepare(`INSERT INTO r1_occupancy_events(tenant_id,event_id,assignment_id,person_id,position_id,delta,effective_at,command_id) SELECT owner,?,?,?,?,?-coalesce((SELECT json_extract(payload,'$.occupancy') FROM r1_m01_entities WHERE tenant_id=? AND id=?),0),?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?`).bind(commandId+':'+e.id,e.id,e.personId,e.payload.positionId??null,e.payload.occupancy??0,tenant,e.id,at,commandId,tenant,token)]:[];
 return [...occupancy,db.prepare(`INSERT INTO r1_m01_entities(tenant_id,id,kind,person_id,org_id,code,revision,status,payload) SELECT owner,?,?,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,id) DO UPDATE SET revision=excluded.revision,status=excluded.status,payload=excluded.payload,org_id=excluded.org_id,code=excluded.code`).bind(e.id,e.kind,e.personId,e.orgId,e.code,e.revision,e.status,JSON.stringify(e.payload),tenant,token),
 db.prepare('INSERT INTO r1_m01_versions(tenant_id,entity_id,version,workspace_revision,command_id,recorded_at,valid_from,valid_to,history_quality,payload) SELECT owner,?,?,revision,?,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(e.id,e.revision,commandId,at,e.payload.validFrom??e.payload.startOn??null,e.payload.validTo??e.payload.lastWorkingOn??null,e.payload.historyQuality??'known',JSON.stringify(e),tenant,token)];
}
function templateValues(template:Entity,input:Record<string,unknown>,mode:'create'|'update',old:Record<string,unknown>={}){
 const output:Record<string,unknown>={};const definitions=template.payload.fields as z.infer<typeof field>[];
 if(Object.keys(input).some(k=>!definitions.some(f=>f.code===k)))invalid('模板未声明字段');
 for(const f of definitions){const value=Object.hasOwn(input,f.code)?input[f.code]:mode==='update'?old[f.code]:f.default;
  if(value===null||value===undefined){if(f.required)invalid('缺少必填字段');output[f.code]=null;continue;}
  if(f.required&&typeof value==='string'&&value.trim()==='')invalid('缺少必填字段');
 if(f.type==='number'){const safeInteger=typeof value==='number'&&Number.isSafeInteger(value);const decimal=typeof value==='string'&&/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)&&value.length<=100;if((!safeInteger&&!decimal)||!f.unit||f.precision===undefined||decimal&&(value as string).split('.')[1]?.length>f.precision)invalid('数值须为安全整数或模板声明精度的十进制字符串');}
 else if(typeof value!=='string'||value.length>1000)invalid('字段类型或长度无效');
 else if(f.type==='date'&&!date.safeParse(value).success)invalid('日期无效');
 else if(f.type==='enum'&&!f.options?.includes(value))invalid('枚举值无效');
 output[f.code]=typeof value==='string'?value.trim():value;
 }return output;
}
/** The current member, tenant and actual execution time are server-derived. */
export async function executeM01(ctx:{db:D1Database;member:Member;row:{revision:number;data:string}},intent:CommandIntent){
 const c=m01Input.parse(intent.payload),{db,member:m}=ctx,tenant=m.tenantId,at=new Date().toISOString(),today=businessDate(at),stamp=await securityStamp(db,tenant);
 if(!stamp.featuresEnabled)throw new HttpError(409,'新能力等待迁移与恢复核验','FEATURE_NOT_READY');
 const state=JSON.parse(ctx.row.data) as State,scope=scopedOrgs(state,m),compatibility=structuredClone(state),storedBefore=structuredClone(state);
 if(!['hr','admin'].includes(m.role))throw new HttpError(403,'仅授权HR办理','FORBIDDEN');
 const changes:Entity[]=[],extra:((token:string)=>D1PreparedStatement[])[]=[],result:Record<string,unknown>={};
 const get=(entityId:string)=>m01Entity(db,tenant,entityId);
 const make=(kind:string,orgId:string|null,personId:string|null,payload:Record<string,any>,status='active',code:string|null=null):Entity=>({id:crypto.randomUUID(),kind,orgId,personId,payload,status,code,revision:1});
 const revise=(e:Entity,payload:Record<string,any>,status=e.status):Entity=>({...e,revision:e.revision+1,status,payload:{...e.payload,...payload}});
 const authorize=async(orgId:string,personId:string,fieldName='record')=>{if(!scope.has(orgId))throw new HttpError(403,'没有此组织办理权限','FORBIDDEN');await authorizeTuple(db,m,{objectType:'M01',action:c.operation,orgId,personId,field:fieldName,historyMode:'current'});};
 const activeCatalog=async(entityId:string,kind:string)=>{const candidates=(await catalogTimeline(db,tenant,kind)).filter(e=>e.id===entityId&&e.payload.validFrom<=today&&(!e.payload.validTo||e.payload.validTo>=today));if(candidates.length!==1)invalid('目标目录当前不可用','TARGET_INVALID');const e=candidates[0];if(e.kind!==kind||e.status!=='active'||!e.payload.validFrom||e.payload.validFrom>today||e.payload.validTo&&e.payload.validTo<today)invalid('目标目录当前不可用','TARGET_INVALID');return e;};
 if('orgId' in c)await authorize(c.orgId,'personId' in c?c.personId:'');
 if('id' in c&&c.id){const e=await get(c.id);await authorize(e.orgId??'',e.personId??'');}
 if(c.operation==='identityReview'){const e=await get(c.personId);await authorize(e.orgId??'',e.id);}
 const replay=await replayCommand(db,m,stamp,intent);if(replay)return replay;
 const assertFence=async(personId:string,employmentId?:string,observed?:string)=>{
  const fence=await db.prepare('SELECT command_id AS commandId FROM r1_exit_fences WHERE tenant_id=? AND person_id=?').bind(tenant,personId).first<{commandId:string}>();if(!fence)return;
  if(employmentId){const segment=await get(employmentId);if(segment.kind==='employment'&&segment.personId===personId&&['active','pending'].includes(segment.status)&&segment.payload.exitFenceObserved===fence.commandId)return;}
  else if(observed===fence.commandId)return;
  invalid('人员已退出，此雇佣代次的后续办理已阻断','BLOCKED_BY_EXIT');
 };
 if('id' in c&&c.id&&!['catalog','template','contract','contractField'].includes(c.operation)){const e=await get(c.id);await authorize(e.orgId??'',e.personId??'');if(e.personId)await assertFence(e.personId,e.payload.employmentId,e.payload.exitFenceObserved);}
 if('personId' in c&&!['employment','identityReview','identityBind','exitCleanup'].includes(c.operation)){
  if(c.operation==='assignmentRequest')await assertFence(c.personId,c.employmentId);
  else {const active=(await rows(db,tenant,'employment',c.personId)).find(e=>e.status==='active');await assertFence(c.personId,active?.id);}
 }
 switch(c.operation){
 case 'catalog':{
  if(c.validFrom<today||c.validTo&&c.validTo<c.validFrom)invalid('目录有效日期无效');
  const old=c.id?await get(c.id):null;if(old&&old.kind!==c.kind)invalid('不能改变目录类型');
  if(old&&old.orgId&&old.orgId!==c.orgId)await authorize(old.orgId,'');
  const all=await catalogTimeline(db,tenant,c.kind);
  if(all.some(e=>e.id!==c.id&&e.code===c.code))invalid('编码已存在');
  if(old&&old.code!==c.code)invalid('稳定目录编码不能通过发布改写');
  if(c.kind==='grade'&&c.attributes.sequence===undefined)invalid('职级必须明确序号');
  if(c.kind==='position'&&c.attributes.establishedOn&&c.attributes.establishedOn>c.validFrom)invalid('设立日期晚于生效日期');
  if(c.kind==='position'&&c.attributes.gradeMinId&&c.attributes.gradeMaxId){const a=await get(c.attributes.gradeMinId),b=await get(c.attributes.gradeMaxId);if(a.kind!=='grade'||b.kind!=='grade'||a.payload.attributes.familyId!==b.payload.attributes.familyId||a.payload.attributes.sequence>b.payload.attributes.sequence)invalid('职级上下限无效');}
  let e=old?revise(old,{...c,supersedesVersion:null},c.status):make(c.kind,c.orgId,null,c,c.status,c.code);
  if(old&&overlaps(old.payload as any,c)){
   if(c.closePreviousVersion!==old.revision||c.validFrom<=old.payload.validFrom)invalid('有效版本区间重叠；请明确关闭的原版本');
   const closed=revise(old,{validTo:previousDay(c.validFrom),supersedesVersion:old.revision});changes.push(closed);
   e={...e,revision:closed.revision+1};
  }else if(c.closePreviousVersion)invalid('原版本已变化或无须关闭','REVISION_CONFLICT');
  const cuts=temporalCatalogCheck(effectiveVersions([...all,...changes,e]),c.kind);result.temporalCuts=cuts;
  if(c.status==='inactive'){
   const legacyRefs=await db.prepare("SELECT 1 FROM hris_approvals a LEFT JOIN hris_assignment_requests q ON q.tenant_id=a.tenant_id AND q.approval_id=a.id WHERE a.tenant_id=? AND (a.status='pending' OR a.status='approved' AND json_extract(a.details,'$.transfer.execution') IN ('waiting','failed')) AND (a.org_id=? OR json_extract(a.details,'$.transfer.source.orgId')=? OR q.position_id=? OR q.grade_id=?) LIMIT 1").bind(tenant,e.id,e.id,e.id,e.id).first();
   if(legacyRefs)invalid('存在受保护的未完成依赖，请联系负责人','PROTECTED_DEPENDENCY');
   const refs=await db.prepare("SELECT 1 FROM r1_m01_entities WHERE tenant_id=? AND id<>? AND status IN ('active','pending','approved','waiting','failed') AND (org_id=? OR json_extract(payload,'$.positionId')=? OR json_extract(payload,'$.parentId')=? OR json_extract(payload,'$.gradeId')=? OR json_extract(payload,'$.attributes.familyId')=? OR json_extract(payload,'$.attributes.gradeMinId')=? OR json_extract(payload,'$.attributes.gradeMaxId')=?) AND coalesce(json_extract(payload,'$.validTo'),'9999-12-31')>=? LIMIT 1").bind(tenant,e.id,e.id,e.id,e.id,e.id,e.id,e.id,e.id,c.validFrom).first();
   if(refs)invalid('存在受保护的未完成依赖，请联系负责人','PROTECTED_DEPENDENCY');
  }
  changes.push(e);break;
 }
 case 'identityReview':{
  const person=await get(c.personId);if(person.kind!=='person')invalid('非人员身份');await authorize(person.orgId??'',person.id);
  const resolved=await resolveIdentity(db,tenant,c.identifiers??[{type:'code',value:person.code??''}]);
  if(resolved.length!==1||resolved[0]!==person.id||new Set(c.candidateIds).size!==1||c.candidateIds[0]!==c.personId)invalid('多标识冲突，需身份复核','IDENTITY_REVIEW_REQUIRED');
  changes.push(make('identity_review',person.orgId,person.id,{personId:c.personId,candidateIds:resolved,reason:c.reason,evidenceRef:c.evidenceRef,reviewerId:m.userId,reviewedAt:at},'confirmed'));break;
 }
 case 'identityBind':{
  const p=await get(c.personId);if(p.kind!=='person'||p.orgId!==c.orgId)invalid('身份对象不匹配');
  const prepared=await prepareIdentityKeys(tenant,c.identifiers);
  extra.push(token=>prepared.map(k=>db.prepare('INSERT INTO r1_identity_keys SELECT owner,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT DO NOTHING').bind(p.id,k.type,k.digest,m.userId,at,tenant,token)));result.personId=p.id;break;
 }
 case 'contractField':{
  const all=await rows(db,tenant,'contract_field'),old=c.id?await get(c.id):null;
  if(old&&(old.kind!=='contract_field'||old.orgId!==c.orgId||old.code!==c.code))invalid('仅可修订同组织同编码字段');
  if(all.some(f=>f.id!==c.id&&f.orgId===c.orgId&&f.code?.toLowerCase()===c.code.toLowerCase()))invalid('字段编码已存在，请修订原字段');
  if(c.status==='active'&&all.filter(f=>f.id!==c.id&&f.orgId===c.orgId&&f.status==='active').length>=20)invalid('每组织最多20项合同字段');
  changes.push(old?revise(old,c,c.status):make('contract_field',c.orgId,null,c,c.status,c.code));break;
 }
 case 'template':{
  if(new Set(c.fields.map(f=>f.code)).size!==c.fields.length)invalid('模板字段重复');
  for(const f of c.fields)if(f.type==='number'&&(!f.unit||f.precision===undefined)||f.type==='enum'&&!f.options?.length)invalid('模板类型配置不完整');
  const old=c.id?await get(c.id):null;if(old&&old.kind!=='template')invalid('模板类型错误');
  changes.push(old?revise(old,c,'published'):make('template',c.orgId,null,c,'published'));break;
 }
 case 'person':{
  const template=await get(c.templateId);if(template.kind!=='template'||template.status!=='published'||template.orgId!==c.orgId||template.payload.entryType!==c.entryType)invalid('入口模板未配置','TEMPLATE_NOT_CONFIGURED');
  for(const f of template.payload.fields)await authorize(c.orgId,'',f.code);
  const values=templateValues(template,c.fields,'create');if(values.email!==undefined&&values.email!==null&&!z.string().email().or(z.literal('')).safeParse(values.email).success)invalid('员工邮箱格式无效');const keys=[{type:'code' as const,value:c.code},...(c.identifiers??[])];
  if((await resolveIdentity(db,tenant,keys)).length)invalid('标识命中历史人员，需身份复核','IDENTITY_REVIEW_REQUIRED');
  const {identifiers,...safe}=c,person=make('person',c.orgId,null,{...safe,fields:values,templateVersion:template.revision,invite:false},'draft',c.code);changes.push(person);
  const prepared=await prepareIdentityKeys(tenant,keys);extra.push(token=>prepared.map(k=>db.prepare('INSERT INTO r1_identity_keys SELECT owner,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT DO NOTHING').bind(person.id,k.type,k.digest,m.userId,at,tenant,token)));break;
 }
 case 'regularizeRequest':{
  const person=await get(c.personId),employee=state.employees.find(e=>e.id===person.id);
  if(person.kind!=='person'||person.orgId!==c.orgId||person.status==='ended'||employee?.status!=='试用')invalid('仅当前试用员工可申请转正');
  if((await rows(db,tenant,'regularize_request',person.id)).some(e=>e.status==='pending'))invalid('存在未完成转正申请');
  const employment=(await rows(db,tenant,'employment',person.id)).find(e=>e.status==='active');if(!employment)invalid('缺少当前雇佣段');
  changes.push(make('regularize_request',c.orgId,person.id,{reason:c.reason,applicationVersion:1,initiatorId:m.userId,employmentId:employment.id,exitFenceObserved:employment.payload.exitFenceObserved??null},'pending'));break;
 }
 case 'employment':{
  const person=await get(c.personId),review=await get(c.identityReviewId);if(person.kind!=='person'||review.kind!=='identity_review'||review.personId!==person.id||review.status!=='confirmed')invalid('缺少已核实的稳定身份','IDENTITY_REVIEW_REQUIRED');
  if(c.predecessorId){const old=await get(c.predecessorId);if(old.kind!=='employment'||old.personId!==person.id||old.status!=='ended'||old.payload.lastWorkingOn>=c.startOn)invalid('前任期无效');}
  if((await rows(db,tenant,'employment',person.id)).some(e=>['pending','active'].includes(e.status)))invalid('已有未结束雇佣段');
  const fence=await db.prepare('SELECT command_id AS commandId FROM r1_exit_fences WHERE tenant_id=? AND person_id=?').bind(tenant,person.id).first<{commandId:string}>();
  changes.push(make('employment',c.orgId,person.id,{...c,exitFenceObserved:fence?.commandId??null,accountRestored:false,lastWorkingOn:null},'pending'));break;
 }
 case 'assignmentRequest':case 'exitRequest':{
  const person=await get(c.personId);if(person.kind!=='person')invalid('人员不存在');await authorize(person.orgId??'',person.id);
  const reviewer=await db.prepare('SELECT user_id AS userId,tenant_id AS tenantId,role,employee_id AS employeeId,org_scope AS orgScope,view_email AS viewEmail,view_level AS viewLevel,active FROM hris_memberships WHERE tenant_id=? AND user_id=? AND active=1').bind(tenant,c.reviewerId).first<Member>();
  if(!reviewer||reviewer.userId===m.userId||reviewer.employeeId===person.id||!['hr','admin'].includes(reviewer.role)||(!scopedOrgs(state,reviewer).has(c.orgId)||!scopedOrgs(state,reviewer).has(person.orgId??'')))invalid('缺少独立且覆盖范围的审核HR');
  if(c.operation==='assignmentRequest'){const employment=await get(c.employmentId);if(employment.kind!=='employment'||employment.personId!==person.id||!['pending','active'].includes(employment.status)||c.validTo&&c.validTo<c.validFrom)invalid('雇佣或任职区间无效');if(c.type!=='primary'&&!c.homePrimaryId)invalid('非主职必须关联派出主职');
   if(c.replacesAssignmentId&&c.endAssignmentId)invalid('不能同时变更和结束同一任职');
   if(c.replacesAssignmentId||c.endAssignmentId){const old=await get(c.replacesAssignmentId??c.endAssignmentId!);if(old.kind!=='assignment'||old.personId!==person.id||old.payload.employmentId!==employment.id||old.status!=='active'||old.payload.type!==c.type)invalid('被变更任职无效');await authorize(old.orgId??'',person.id);if(c.replacesAssignmentId&&c.type==='primary')invalid('主职变更须使用D7调动','D7_REQUIRED');}
}
  const pending=await db.prepare("SELECT 1 FROM r1_m01_entities WHERE tenant_id=? AND person_id=? AND kind IN ('assignment_request','exit_request') AND status IN ('pending','approved','failed') AND NOT EXISTS (SELECT 1 FROM r1_exit_cleanup x WHERE x.tenant_id=r1_m01_entities.tenant_id AND x.business_id=r1_m01_entities.id) LIMIT 1").bind(tenant,person.id).first();if(pending)invalid('已有在途人事事项');
  const segment=c.operation==='assignmentRequest'?await get(c.employmentId):(await rows(db,tenant,'employment',person.id)).find(e=>e.status==='active');
  changes.push(make(c.operation==='assignmentRequest'?'assignment_request':'exit_request',c.orgId,person.id,{...c,employmentId:segment?.id??null,exitFenceObserved:segment?.payload.exitFenceObserved??null,createdBy:m.userId,attempts:0,effectStatus:'waiting'},'pending'));break;
 }
 case 'assignmentCancel':case 'exitCancel':{const e=await get(c.id);if(e.kind!==(c.operation==='assignmentCancel'?'assignment_request':'exit_request')||!['pending','approved','failed'].includes(e.status)||e.status==='pending'&&e.payload.createdBy!==m.userId)invalid('只能取消尚未生效且有权处理的原单');changes.push(revise(e,{effectStatus:'cancelled',cancelledAt:at,cancelReason:c.reason},'cancelled'));break;}
 case 'assignmentApprove':case 'exitApprove':{
  const e=await get(c.id);if(e.kind!==(c.operation==='assignmentApprove'?'assignment_request':'exit_request')||e.status!=='pending'||e.payload.reviewerId!==m.userId||e.payload.createdBy===m.userId||e.personId===m.employeeId)invalid('审核角色或原单状态无效');changes.push(revise(e,{approvedBy:m.userId,approvedAt:at},'approved'));break;
 }
 case 'assignmentExecute':{
  const e=await get(c.id),p=e.payload;if(e.kind!=='assignment_request'||!['approved','failed'].includes(e.status))invalid('原单非已批准待执行');
  if(today<p.validFrom)invalid('未到生效日期，不增加尝试');
  let failure:string|null=null;
  try{if(!p.endAssignmentId){const position=await activeCatalog(p.positionId,'position');await activeCatalog(p.orgId,'org');if(position.orgId!==p.orgId)invalid('职位不属于目标组织');}
   const assignments=await rows(db,tenant,'assignment',e.personId!);
   if(p.replacesAssignmentId||p.endAssignmentId){const old=await get(p.replacesAssignmentId??p.endAssignmentId);if(old.kind!=='assignment'||old.personId!==e.personId||old.status!=='active')invalid('被变更任职已变化');}
   if(!p.endAssignmentId&&assignments.some(a=>a.id!==p.replacesAssignmentId&&a.status==='active'&&overlaps(a.payload as any,p as {validFrom:string;validTo:string|null})&&(p.type==='primary'&&a.payload.type==='primary'||a.payload.type===p.type&&a.payload.positionId===p.positionId)))invalid('存在重叠任职');
   if(p.type!=='primary'&&!p.endAssignmentId){const home=await get(p.homePrimaryId);if(home.kind!=='assignment'||home.personId!==e.personId||home.status!=='active'||home.payload.type!=='primary')invalid('派出主职无效');}
   if(p.type==='primary'&&!p.endAssignmentId){const budget=await db.prepare("SELECT payload FROM r1_m01_entities WHERE tenant_id=? AND kind='budget_policy' AND org_id=? AND status='active' LIMIT 1").bind(tenant,p.orgId).first<{payload:string}>();
    if(budget&&JSON.parse(budget.payload).strongBlocking)invalid('金额预算服务未接通，强阻断链不可执行','EXTERNAL_BUDGET_REQUIRED');result.budgetStatus='not_checked';
    const plans=await db.prepare("SELECT id,payload FROM hris_development_records WHERE tenant_id=? AND kind='staffingPlan' AND position_id=? AND status='approved' AND json_extract(payload,'$.start')<=? AND json_extract(payload,'$.end')>=? LIMIT 201").bind(tenant,p.positionId,today,today).all();if(plans.results.length>200)invalid('编制版本待核');
    const active=plans.results.map((x:any)=>({...JSON.parse(x.payload),id:x.id})).filter((x:any,_i:number,a:any[])=>!a.some(y=>y.supersedes===x.id));
    const usage=await db.prepare("SELECT COUNT(*) n FROM r1_m01_entities WHERE tenant_id=? AND kind='assignment' AND status='active' AND json_extract(payload,'$.type')='primary' AND json_extract(payload,'$.positionId')=?").bind(tenant,p.positionId).first<{n:number}>();
    if(active.length&&usage!.n>=Math.min(...active.map((x:any)=>x.headcount)))invalid('目标编制已满');
   }
  }catch(error){if(!(error instanceof HttpError)||error.status>=500)throw error;failure=error.message;}
  changes.push(revise(e,{attempts:p.attempts+1,lastAttemptAt:at,effectStatus:failure?'failed':'applied',failure,appliedAt:failure?null:at},failure?'failed':'applied'));
  if(failure){result.effectStatus='failed';result.reasonCode='BUSINESS_FAILED';break;}
  if(p.replacesAssignmentId||p.endAssignmentId){const old=await get(p.replacesAssignmentId??p.endAssignmentId);changes.push(revise(old,{validTo:old.payload.validFrom===today?today:previousDay(today),dayProjectionExcluded:old.payload.validFrom===today,effectiveToAt:at,endedAt:at,occupancy:0},'ended'));}
  if(p.endAssignmentId){if(p.type==='primary'){const old=compatibility.employees.find(x=>x.id===e.personId);if(old){old.positionId=null;old.gradeId=null;old.job='';old.level='';}const person=await get(e.personId!);changes.push(revise(person,{currentPrimaryId:null}));}result.effectStatus='applied';break;}
  const assignment=make('assignment',e.orgId,e.personId,{...p,validFrom:today,appliedAt:at,occupancy:p.type==='primary'?1:0,approvalId:e.id});changes.push(assignment);
  const employment=await get(p.employmentId);if(employment.status==='pending')changes.push(revise(employment,{actualStartedAt:at},'active'));
  if(p.type==='primary'){
   const person=await get(e.personId!),position=await activeCatalog(p.positionId,'position'),grade=p.gradeId?await activeCatalog(p.gradeId,'grade'):null;
   const old=compatibility.employees.find(x=>x.id===person.id),fields=person.payload.fields??{};
   const employee={id:person.id,code:person.code??person.payload.code,name:person.payload.name,orgId:p.orgId,positionId:p.positionId,gradeId:p.gradeId??null,job:position.payload.name,level:grade?.payload.name??'',joined:old?.joined??today,status:old&&old.status!=='离职'?old.status:'试用',email:old?.email??fields.email??''};
   if(!z.string().email().or(z.literal('')).safeParse(employee.email).success)invalid('员工邮箱格式无效');
   if(old)Object.assign(old,employee);else compatibility.employees.push(employee);changes.push({...revise(person,{currentPrimaryId:assignment.id,orgId:p.orgId},'active'),orgId:p.orgId});
  }
  result.assignmentId=assignment.id;result.effectStatus='applied';break;
 }
 case 'exitExecute':{
  const e=await get(c.id);if(e.kind!=='exit_request'||e.status!=='approved')invalid('退出原单不可执行');if(today<nextDay(e.payload.lastWorkingOn))invalid('未到最后工作日次日');
  const employment=await rows(db,tenant,'employment',e.personId!),assignments=await rows(db,tenant,'assignment',e.personId!);
  if(employment.length+assignments.length>30)throw new HttpError(503,'需有界退出计划','BOUNDED_QUERY_REQUIRED');
  changes.push(revise(e,{appliedAt:at,effectStatus:'applied',cleanupStatus:'pending'},'applied'));
  const person=await get(e.personId!);changes.push(revise(person,{exitedAt:at,currentPrimaryId:null},'ended'));const oldEmployee=compatibility.employees.find(x=>x.id===person.id);if(oldEmployee)oldEmployee.status='离职';
  extra.push(token=>[db.prepare("UPDATE hris_memberships SET active=0 WHERE tenant_id=? AND employee_id=? AND active=1 AND EXISTS(SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)").bind(tenant,e.personId,tenant,token)]);
  for(const x of [...employment,...assignments].filter(x=>x.status==='active'))changes.push(revise(x,{lastWorkingOn:e.payload.lastWorkingOn,validTo:previousDay(today),endedAt:at,occupancy:0},'ended'));
  extra.push(token=>[db.prepare('INSERT INTO r1_exit_fences(tenant_id,person_id,effective_at,command_id) SELECT owner,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=? ON CONFLICT(tenant_id,person_id) DO UPDATE SET effective_at=excluded.effective_at,command_id=excluded.command_id').bind(e.personId,at,intent.commandId,tenant,token)]);
  extra.push(token=>[db.prepare("INSERT INTO r1_exit_cleanup(tenant_id,person_id,business_type,business_id) SELECT e.tenant_id,e.person_id,e.kind,e.id FROM r1_m01_entities e JOIN hris_workspaces w ON w.owner=e.tenant_id WHERE e.tenant_id=? AND e.person_id=? AND e.id<>? AND e.status IN ('pending','approved','failed') AND w.last_mutation=? ON CONFLICT DO NOTHING").bind(tenant,e.personId,e.id,token)]);
  result.cleanupStatus='pending';break;
 }
 case 'exitCleanup':{
  const pending=await db.prepare("SELECT business_type AS kind,business_id AS id FROM r1_exit_cleanup WHERE tenant_id=? AND person_id=? AND status='queued' ORDER BY business_type,business_id LIMIT ?").bind(tenant,c.personId,c.limit).all<{kind:string;id:string}>();
  for(const item of pending.results){
   const e=await get(item.id),supported=['assignment_request','exit_request'].includes(item.kind);
   if(supported&&['pending','approved','failed'].includes(e.status))changes.push(revise(e,{effectStatus:'cancelled',cancelReason:'blocked_by_exit',cancelledAt:at},'cancelled'));
   extra.push(token=>[db.prepare("UPDATE r1_exit_cleanup SET status=?,reason=? WHERE tenant_id=? AND person_id=? AND business_type=? AND business_id=? AND status='queued' AND EXISTS (SELECT 1 FROM hris_workspaces WHERE owner=? AND last_mutation=?)").bind(supported?'cancelled':'blocked_by_exit',supported?'退出逐单取消':'原域不支持安全取消，待责任域核销',tenant,c.personId,item.kind,item.id,tenant,token)]);
  }
  result.processed=pending.results.length;result.allDomainsCancelled=false;break;
 }
 case 'contract':{
  const legal=await activeCatalog(c.legalEntityId,'legal_entity'),attrs=legal.payload.attributes;
  if(!attrs.orgIds?.includes(c.orgId)&&!attrs.extraPersonIds?.includes(c.personId))invalid('法人适用范围未配置或不匹配');
  if(c.end&&c.end<c.start||c.contractType==='fixed'&&!c.end||c.contractType==='open'&&c.end)invalid('合同期限无效');
  const contracts=await rows(db,tenant,'contract',c.personId);
  if(contracts.some(e=>e.id!==c.id&&e.code===c.number.toLowerCase()))invalid('合同编号已存在');
  if(c.renewalOf){const old=await get(c.renewalOf);if(old.kind!=='contract'||old.personId!==c.personId||old.payload.legalEntityId!==c.legalEntityId||!['signed','ended'].includes(old.status)||!old.payload.end&&!old.payload.endedOn||c.start!==nextDay(old.payload.endedOn??old.payload.end))invalid('续签必须同人同法人且相邻日');}
  const old=c.id?await get(c.id):null;if(old&&(old.kind!=='contract'||old.personId!==c.personId||old.status!=='draft'))invalid('仅同人草稿可修订');
  const definitions=(await rows(db,tenant,'contract_field')).filter(f=>f.orgId===c.orgId);for(const field of definitions.filter(f=>f.status==='active'))await authorize(c.orgId,c.personId,field.id);
  const previous=c.renewalOf?await get(c.renewalOf):old??undefined;const fieldSnapshots=captureR1ContractFields(definitions,c.fields,previous);
  const payload={...c,fieldSnapshots,legalVersion:legal.revision,legalName:legal.payload.name,externalSigningStatus:'not_configured',createdBy:old?.payload.createdBy??m.userId};
  changes.push(old?revise(old,payload):make('contract',c.orgId,c.personId,payload,'draft',c.number.toLowerCase()));break;
 }
 case 'contractSign':case 'contractEnd':{
  const e=await get(c.id);if(e.kind!=='contract')invalid('非合同对象');
  if(c.operation==='contractSign'){if(e.status!=='draft'||c.signedOn>today)invalid('签署登记状态或日期无效');const contracts=await rows(db,tenant,'contract',e.personId!);
   if(contracts.some(x=>x.id!==e.id&&x.payload.legalEntityId===e.payload.legalEntityId&&['signed','ended'].includes(x.status)&&overlaps({validFrom:x.payload.start,validTo:x.payload.endedOn??x.payload.end},{validFrom:e.payload.start,validTo:e.payload.end})))invalid('同人同法人存在重叠已签合同');changes.push(revise(e,{...c,signRecordedBy:m.userId},'signed'));
  }else{if(e.status!=='signed'||m.userId===e.payload.createdBy||m.employeeId===e.personId||c.endedOn>today||c.endedOn<e.payload.start||e.payload.end&&c.endedOn>e.payload.end)invalid('终止须由独立HR核有效日期');changes.push(revise(e,{...c,endedBy:m.userId},'ended'));}break;
 }
 case 'subsetImport':{
  const t=await get(c.templateId);if(t.kind!=='template'||t.status!=='published'||t.revision!==c.templateVersion||t.orgId!==c.orgId||t.payload.entryType!=='subset')invalid('模板版本已变化','REVISION_CONFLICT');
  for(const name of Object.keys(c.fields))await authorize(c.orgId,c.personId,name);
  const inputDigest=await digest(c),receipt=await db.prepare('SELECT request_digest AS requestDigest,entity_id AS entityId FROM r1_import_receipts WHERE tenant_id=? AND batch_id=? AND row_no=? AND attempt_version=?').bind(tenant,c.batchId,c.rowNo,c.attemptVersion).first<{requestDigest:string;entityId:string}>();
  if(receipt){if(receipt.requestDigest!==inputDigest)throw new HttpError(409,'同批次行内容冲突','IDEMPOTENCY_CONFLICT');return commitCommand(db,m,stamp,intent,()=>[],{ids:[receipt.entityId],rowReplayed:true});}
  const old=c.recordId?await get(c.recordId):null;if(c.mode==='update'&&(!old||old.kind!=='subset'||old.personId!==c.personId||old.payload.templateId!==t.id))invalid('更新对象不匹配');
  const values=templateValues(t,c.fields,c.mode,old?.payload.fields),keys=t.payload.fields.filter((f:any)=>f.uniqueKey).map((f:any)=>f.code);
  const existing=await rows(db,tenant,'subset',c.personId);if(keys.length&&existing.some(e=>e.id!==old?.id&&e.status==='active'&&e.payload.templateId===t.id&&keys.every((k:string)=>e.payload.fields[k]===values[k])))invalid('子集唯一键重复');
  const payload={...c,fields:values};const row=old?revise(old,payload):make('subset',c.orgId,c.personId,payload);changes.push(row);
  extra.push(token=>[db.prepare('INSERT INTO r1_import_receipts SELECT owner,?,?,?,?,? FROM hris_workspaces WHERE owner=? AND last_mutation=?').bind(c.batchId,c.rowNo,c.attemptVersion,inputDigest,row.id,tenant,token)]);break;
 }
 }
 if(compatibility.employees.some(e=>!state.employees.some(x=>x.id===e.id&&JSON.stringify(x)===JSON.stringify(e)))){
  for(const e of compatibility.employees.filter(e=>!state.employees.some(x=>x.id===e.id&&JSON.stringify(x)===JSON.stringify(e)))){
   for(const [table,key,list] of [['hris_positions',e.positionId,'positions'],['hris_grades',e.gradeId,'grades']] as const)if(key&&!await db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=? AND id=?`).bind(tenant,key).first())storedBefore[list]=storedBefore[list]?.filter(x=>x.id!==key) as any;
   let org=e.orgId;while(org){if(!await db.prepare('SELECT 1 FROM hris_orgs WHERE tenant_id=? AND id=?').bind(tenant,org).first())storedBefore.orgs=storedBefore.orgs.filter(x=>x.id!==org);org=compatibility.orgs.find(x=>x.id===org)?.parentId??'';}
  }
  const active=(await catalogTimeline(db,tenant,'position')).filter(e=>e.status==='active'&&e.payload.validFrom<=today&&(!e.payload.validTo||e.payload.validTo>=today));
  for(const e of active)if(!compatibility.positions?.some(p=>p.id===e.id))(compatibility.positions??=[]).push({id:e.id,code:e.code??e.id,name:e.payload.name,orgId:e.orgId!,family:e.payload.attributes?.familyId??'',responsibilities:e.payload.attributes?.responsibilities??'',status:'启用'});
 }
 result.ids=changes.map(e=>e.id);
 const domainEvents=await m01DomainEvents(db,tenant,intent,changes);
 return commitCommand(db,m,stamp,intent,token=>[...stateStatements(db,tenant,token,storedBefore,compatibility,m.userId,at),...changes.flatMap(e=>m01Write(db,tenant,token,e,intent.commandId,at)),...domainEvents(token),...extra.flatMap(fn=>fn(token))],result);
}
