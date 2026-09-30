import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,orgWithin,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(2000);
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('template'),code:z.string().trim().regex(/^[A-Za-z0-9_-]{2,30}$/).transform(s=>s.toUpperCase()),title:z.string().trim().min(1).max(200),orgId:id,description:evidence,validityDays:z.number().int().min(1).max(3650).nullable()}),
 z.object({action:z.literal('publish'),id}),z.object({action:z.literal('archive'),id,evidence}),
 z.object({action:z.literal('propose'),templateId:id,employeeId:id,sourceKind:z.enum(['enrollment','instructorProfile','mentorship']),sourceRecordId:id,certificateNumber:z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/).transform(s=>s.toUpperCase()),evidence}),
 z.object({action:z.literal('review'),id,accepted:z.boolean(),evidence}),z.object({action:z.literal('withdraw'),id,evidence}),z.object({action:z.literal('revoke'),id,evidence})
]);
export function certificateSourceValid(r:R|undefined){return !!r&&((r.kind==='enrollment'&&r.status==='completed')||(r.kind==='instructorProfile'&&r.status==='active')||(r.kind==='mentorship'&&r.status==='closed'&&!!r.payload.graduatedAt));}
export function currentCertificateTemplate(records:R[],code:string){return records.filter(r=>r.kind==='certificateTemplate'&&r.payload.code===code&&['published','archived'].includes(r.status)).sort((a,b)=>(b.payload.version??1)-(a.payload.version??1))[0];}
export function applyCertificate(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),hr=['admin','hr'].includes(member.role),scope=scopedOrgs(state,member),deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 if(!hr)deny('仅有权限HR可办理内部证书');
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,member))deny('记录不存在或无权访问');return r!;};
 const employee=(id:string)=>{const e=state.employees.find(e=>e.id===id);if(!e||!scope.has(e.orgId)||e.id===member.employeeId)deny('须由非本人的有权限HR办理证书');return e!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,employeeId:null,referenceId:null,positionId:null,status:'draft',createdBy:member.userId,createdAt:at,updatedAt:at,payload,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,updatedAt:at,payload:{...r.payload,...payload}});
 const template=(id:string)=>{const t=get(id,'certificateTemplate');if(t.status!=='published'||currentCertificateTemplate(records,t.payload.code!)?.id!==t.id)fail('须使用当前已发布且未停用的证书模板版本');return t;};
 const source=(kind:R['kind'],id:string,employeeId:string)=>{const r=get(id,kind);if(r.employeeId!==employeeId||!certificateSourceValid(r))fail('须引用同员工已独立核验完成、在用入册或正式出师的记录');return r;};
 if(c.action==='template'){
  if(!scope.has(c.orgId)||!state.orgs.some(o=>o.id===c.orgId&&o.status==='启用'))deny('没有此组织的模板管理权限');const previous=records.filter(r=>r.kind==='certificateTemplate'&&r.payload.code===c.code);if(previous.some(r=>r.payload.orgId!==c.orgId))fail('证书编码不能跨组织复用');const version=Math.max(0,...previous.map(r=>r.payload.version??1))+1;return make('certificateTemplate',{code:c.code,title:c.title,description:c.description,orgId:c.orgId,issuerName:state.orgs.find(o=>o.id===c.orgId)!.name,validityDays:c.validityDays,version});
 }
 if(c.action==='publish'||c.action==='archive'){
  const r=get(c.id,'certificateTemplate');if(!scope.has(r.payload.orgId!))deny('没有此组织的模板管理权限');if(c.action==='publish'){if(r.status!=='draft'||(currentCertificateTemplate(records,r.payload.code!)?.payload.version??0)>=r.payload.version!)fail('仅高于既有发布版本的草稿可发布');return change(r,'published',{publishedBy:member.userId,publishedAt:at});}if(r.status!=='published')fail('仅已发布模板可停用');return change(r,'archived',{closedReason:c.evidence});
 }
 if(c.action==='propose'){
  const e=employee(c.employeeId),t=template(c.templateId);if(e.status==='离职'||!orgWithin(state,e.orgId,t.payload.orgId!))fail('员工须在职且符合模板组织范围');const s=source(c.sourceKind,c.sourceRecordId,e.id);
  if(records.some(r=>r.kind==='certificateAward'&&r.payload.certificateNumber===c.certificateNumber))fail('证书编号已使用，不可复用');if(records.some(r=>r.kind==='certificateAward'&&r.employeeId===e.id&&r.payload.code===t.payload.code&&r.payload.sourceRecordId===s.id&&['submitted','issued'].includes(r.status)))fail('同证书系列与依据已有待审或已发证书');
  return make('certificateAward',{code:t.payload.code,title:t.payload.title,description:t.payload.description,issuerName:t.payload.issuerName,validityDays:t.payload.validityDays,version:t.payload.version,name:e.name,sourceKind:c.sourceKind,sourceRecordId:s.id,certificateNumber:c.certificateNumber,evidence:c.evidence},{employeeId:e.id,referenceId:t.id,status:'submitted'});
 }
 const r=get(c.id,'certificateAward');employee(r.employeeId!);
 if(c.action==='withdraw'){if(r.createdBy!==member.userId)deny('仅发放申请人可以撤回');if(r.status!=='submitted')fail('仅待审发放申请可撤回');return change(r,'withdrawn',{closedReason:c.evidence});}
 if(r.createdBy===member.userId)deny('须由非发放申请人的其他HR独立办理');
 if(c.action==='revoke'){if(r.status!=='issued')fail('仅已发放证书可以撤销');return change(r,'revoked',{revocationReason:c.evidence,revokedBy:member.userId,revokedAt:at});}
 if(r.status!=='submitted')fail('发放申请已经处理');if(!c.accepted)return change(r,'rejected',{verification:c.evidence,verifiedBy:member.userId,verifiedAt:at});const e=employee(r.employeeId!),t=template(r.referenceId!);if(e.status==='离职'||!orgWithin(state,e.orgId,t.payload.orgId!))fail('员工不再符合模板发放范围');const s=source(r.payload.sourceKind!,r.payload.sourceRecordId!,e.id);const issuedOn=businessDate(at),end=new Date(issuedOn+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+(r.payload.validityDays??1)-1);
 return change(r,'issued',{issuedOn,validUntil:r.payload.validityDays===null?undefined:end.toISOString().slice(0,10),verification:c.evidence,verifiedBy:member.userId,verifiedAt:at,certificateSourceSnapshot:{id:s.id,kind:s.kind,title:s.payload.title??s.payload.name??'',status:s.status,updatedAt:s.updatedAt}});
}
