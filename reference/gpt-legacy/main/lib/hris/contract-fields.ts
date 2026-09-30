import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import {activeContractFields,contractFieldDefault,type ContractFieldSnapshot} from './contract-field-model';
const id=z.string().min(1).max(100),fields={orgId:id,code:z.string().trim().regex(/^[A-Za-z0-9_-]{1,60}$/),name:z.string().trim().min(1).max(100),inheritPrevious:z.boolean().default(true)};
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),...fields}).strict(),z.object({action:z.literal('edit'),id,...fields}).strict(),
 z.object({action:z.literal('seal'),id}).strict(),z.object({action:z.literal('revise'),id}).strict(),z.object({action:z.literal('archive'),id,reason:z.string().trim().min(5).max(3000)}).strict(),
]);
export const contractFieldInput=z.record(z.string().uuid(),z.string().trim().max(1000).nullable()).refine(v=>Object.keys(v).length<=20,'每份合同最多20项自定义字段');
export function applyContractField(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),deny=():never=>{throw new HttpError(403,'仅有组织权限的HR可维护合同字段');},fail=(s:string):never=>{throw new HttpError(400,s);};
 if(!['admin','hr'].includes(m.role))deny();
 const old=c.action==='create'?undefined:records.find(r=>r.kind==='contractFieldDefinition'&&r.id===c.id);
 if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
 if(c.action==='archive'){if(old!.status==='archived')fail('字段版本已归档');return {...old!,status:'archived',updatedAt:at,payload:{...old!.payload,closedReason:c.reason}};}
 if(c.action==='seal'){
  if(old!.status!=='draft')fail('仅草稿可定版');if(!state.orgs.some(o=>o.id===old!.payload.orgId&&o.status==='启用'))fail('字段组织已停用');
  const sealed={...old!,status:'sealed',updatedAt:at,payload:{...old!.payload,publishedAt:at}};if(activeContractFields(records.map(r=>r.id===old!.id?sealed:r),old!.payload.orgId!).length>20)fail('每个组织最多启用20项合同文本字段');return sealed;
 }
 if(c.action==='revise'){
  const family=records.filter(r=>r.kind==='contractFieldDefinition'&&r.payload.definitionRootId===old!.payload.definitionRootId);
  if(!['sealed','archived'].includes(old!.status)||family.some(r=>r.status==='draft'||(r.payload.version??0)>(old!.payload.version??0)))fail('请从没有后续草稿的最新版本修订');
  return {...old!,id:crypto.randomUUID(),referenceId:old!.id,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:(old!.payload.version??1)+1,closedReason:undefined,publishedAt:undefined}};
 }
 if(!scopedOrgs(state,m).has(c.orgId))deny();if(!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))fail('字段组织已停用');
 if(old&&(old.status!=='draft'||old.payload.orgId!==c.orgId||old.payload.contractField?.code!==c.code))fail('只能编辑同组织、同编号的草稿');
 if(records.some(r=>r.kind==='contractFieldDefinition'&&r.payload.orgId===c.orgId&&r.payload.contractField?.code.toLowerCase()===c.code.toLowerCase()&&r.payload.definitionRootId!==old?.payload.definitionRootId))fail('字段编号已存在，请修订原字段');
 const key=old?.id??crypto.randomUUID();return {id:key,kind:'contractFieldDefinition',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{orgId:c.orgId,definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1,contractField:{code:c.code,name:c.name,inheritPrevious:c.inheritPrevious}}};
}
export function captureContractFields(records:R[],state:State,m:Member,employeeId:string,previous:R|undefined,input:unknown):ContractFieldSnapshot[]{
 const e=state.employees.find(e=>e.id===employeeId);if(!e||!['admin','hr'].includes(m.role)||!scopedOrgs(state,m).has(e.orgId))throw new HttpError(403,'没有此员工合同字段权限');
 const overrides=contractFieldInput.parse(input??{}),definitions=activeContractFields(records,e.orgId);
 if(definitions.length>20)throw new HttpError(400,'活动合同字段超过20项，请先整理配置');
 if(Object.keys(overrides).some(key=>!definitions.some(d=>d.id===key)))throw new HttpError(400,'字段不属于当前组织的有效版本，请刷新');
 return definitions.map(def=>({id:def.id,rootId:def.payload.definitionRootId!,version:def.payload.version!,...def.payload.contractField!,...(Object.hasOwn(overrides,def.id)?{value:overrides[def.id]||null,source:'manual' as const}:contractFieldDefault(def,previous))}));
}
