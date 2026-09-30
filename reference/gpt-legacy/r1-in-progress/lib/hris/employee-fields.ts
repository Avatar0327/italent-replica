import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import {fieldRequired} from './field-completeness';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(3000),value=z.union([z.string().trim().max(2000),z.number().finite().min(-1e12).max(1e12),z.null()]);
export const fieldCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('define'),code:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/),name:text,description:evidence,fieldType:z.enum(['text','number','date','choice']),fieldGroup:z.string().trim().min(1).max(80).default('基本资料'),requiredWhen:z.enum(['optional','always','probation','regular']).default('optional'),fieldOptions:z.array(text).max(50).default([]),employeeRead:z.boolean().default(false),managerRead:z.boolean().default(false),employeeEditable:z.boolean().default(false)}),
 z.object({action:z.literal('archive'),id}),
 z.object({action:z.literal('record'),definitionId:id,employeeId:id,value,evidence}),
 z.object({action:z.literal('propose'),definitionId:id,value,evidence}),
 z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('withdraw'),id,evidence}),
]);
export function validateFieldValue(def:R,value:string|number|null){
 if(value===null)return null;
 const p=def.payload,fail=():never=>{throw new HttpError(400,'字段值与定义类型或可选范围不符');};
 if(p.fieldType==='number')return typeof value==='number'&&Number.isFinite(value)?value:fail();
 if(typeof value!=='string'||!value.length)fail();
 const v=value as string;
 if(p.fieldType==='date'){const d=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(d.getTime())||d.toISOString().slice(0,10)!==v)fail();}
 if(p.fieldType==='choice'&&!p.fieldOptions?.includes(v))fail();
 return v;
}
export function applyEmployeeField(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=fieldCommand.parse(input),hr=['admin','hr'].includes(member.role),scope=scopedOrgs(state,member);
 const deny=(s:string):never=>{throw new HttpError(403,s);},invalid=(s:string):never=>{throw new HttpError(400,s);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或没有访问权限');return r!;};
 const employee=(id:string,manage:boolean)=>{const e=state.employees.find(e=>e.id===id);if(!e||!(manage?hr&&scope.has(e.orgId):e.id===member.employeeId))deny('没有此员工的字段维护权限');return e!;};
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'active',createdBy:member.userId,createdAt:at,updatedAt:at,...extra});
 switch(c.action){
 case 'define':{if(!hr)deny('仅HR或管理员可定义档案字段');if(records.some(r=>r.kind==='employeeFieldDefinition'&&r.payload.code?.toLowerCase()===c.code.toLowerCase()))invalid('字段编码已使用；停用后也不能重用');if(c.employeeEditable&&!c.employeeRead)invalid('允许员工申请变更的字段必须对本人可见');if(c.fieldType==='choice'&&(c.fieldOptions.length<2||new Set(c.fieldOptions).size!==c.fieldOptions.length))invalid('选择字段需要至少两个不重复选项');if(c.fieldType!=='choice'&&c.fieldOptions.length)invalid('仅选择字段可配置选项');const {action,...p}=c;return make('employeeFieldDefinition',p);}
 case 'archive':{if(!hr)deny('仅HR或管理员可停用字段');const r=get(c.id,'employeeFieldDefinition');if(r.status!=='active')invalid('字段已停用');return change(r,'archived');}
 case 'record':case 'propose':{const def=get(c.definitionId,'employeeFieldDefinition');if(def.status!=='active')invalid('字段已停用');const e=employee(c.action==='record'?c.employeeId:member.employeeId??'',c.action==='record');if(e.status==='离职')invalid('离职员工档案字段不能新增变更');if(c.action==='record'&&e.id===member.employeeId)deny('本人字段须通过变更申请由其他HR复核');if(c.action==='propose'&&!def.payload.employeeEditable)deny('此字段不允许员工申请修改');const v=validateFieldValue(def,c.value);if(v===null&&fieldRequired(def,e.status))invalid('当前员工状态下此字段为必填，不能清空');const old=records.find(r=>r.kind==='employeeFieldValue'&&r.referenceId===def.id&&r.employeeId===e.id);if(old?.status==='pending'&&(c.action==='record'||old.payload.submittedBy!==member.userId))invalid('已有待复核变更，请先处理');const r=old??make('employeeFieldValue',{name:def.payload.name,fieldValue:null},{employeeId:e.id,referenceId:def.id});return c.action==='record'?change(r,'active',{fieldValue:v,evidence:c.evidence,verifiedBy:member.userId,verifiedAt:at}):change(r,'pending',{pendingValue:v,evidence:c.evidence,submittedBy:member.userId,submittedAt:at,verification:undefined,verifiedBy:undefined,verifiedAt:undefined});}
 case 'review':{const r=get(c.id,'employeeFieldValue');const e=employee(r.employeeId!,true);if(r.status!=='pending')invalid('变更已处理或尚未提交');if(r.employeeId===member.employeeId||r.payload.submittedBy===member.userId)deny('须由其他HR复核，不能自审');if(c.accepted&&e.status==='离职')invalid('员工已离职，只能退回此次字段变更');const def=get(r.referenceId!,'employeeFieldDefinition');if(c.accepted&&def.status!=='active')invalid('字段已停用，只能退回此次变更');const v=c.accepted?validateFieldValue(def,r.payload.pendingValue??null):r.payload.fieldValue;if(c.accepted&&v===null&&fieldRequired(def,e.status))invalid('员工状态已满足必填条件，不能批准清空');return change(r,'active',{fieldValue:v,pendingValue:undefined,verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});}
 case 'withdraw':{const r=get(c.id,'employeeFieldValue');if(r.payload.submittedBy!==member.userId||r.employeeId!==member.employeeId)deny('仅本人可撤回自己的申请');if(r.status!=='pending')invalid('没有待复核变更');return change(r,'active',{pendingValue:undefined,closedReason:c.evidence});}
 }
}
