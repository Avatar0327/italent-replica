import type {SecurityStamp} from './r1-command';
import {canReadTransferCase,projectApprovalDetails,transferChangesGrade} from './personnel-transfer.ts';
import { commandSchema, type State } from './model.ts';
export type Member = {permissionValidUntil?:number;securityStamp?:SecurityStamp;userId:string;tenantId:string;role:'admin'|'hr'|'manager'|'approver'|'employee'|'payroll_editor'|'payroll_reviewer';employeeId:string|null;active:boolean|number;orgScope?:string|string[];viewEmail?:boolean|number;viewLevel?:boolean|number};
export const selfOnlyRole=(m:Member)=>['employee','payroll_editor','payroll_reviewer'].includes(m.role);
export class AccessError extends Error {}
export function requireMember(member:Member|null|undefined):asserts member is Member {
 if(!member?.active||!['admin','hr','manager','approver','employee','payroll_editor','payroll_reviewer'].includes(member.role))throw new AccessError('尚未配置有效的企业成员权限，请联系系统管理员');
}
export function scopedOrgs(state:State,member:Member){
 if(member.role==='admin')return new Set(state.orgs.map(o=>o.id));
 let roots:unknown=member.orgScope??[];if(typeof roots==='string'){try{roots=JSON.parse(roots);}catch{roots=[];}}
 const scope=new Set<string>(Array.isArray(roots)?roots.filter((v):v is string=>typeof v==='string'):[]);
 let changed=true;while(changed){changed=false;for(const o of state.orgs)if(o.parentId&&scope.has(o.parentId)&&!scope.has(o.id)){scope.add(o.id);changed=true;}}
 return scope;
}
export function permittedEmployeeIds(state:State,member:Member){
 const scope=scopedOrgs(state,member);
 const assigned=new Set(state.approvals.filter(a=>a.steps?.some(s=>s.userId===member.userId)).map(a=>a.employeeId));
 return new Set(state.employees.filter(e=>member.role==='admin'||(selfOnlyRole(member)?e.id===member.employeeId:scope.has(e.orgId)&&(member.role!=='approver'||assigned.has(e.id)))).map(e=>e.id));
}
export function visibleState(state:State,member:Member):State {
 requireMember(member);if(member.role==='admin')return state;
 const ids=permittedEmployeeIds(state,member),scope=scopedOrgs(state,member);
 const employees=state.employees.filter(e=>ids.has(e.id)).map(e=>({...e,email:member.viewEmail?e.email:'',level:member.viewLevel?e.level:'',gradeId:member.viewLevel?e.gradeId:null}));
 const approvals=state.approvals.filter(a=>canReadTransferCase(a,member,scope)||ids.has(a.employeeId)&&(member.role!=='approver'||a.steps?.some(s=>s.userId===member.userId))).map(a=>projectApprovalDetails(a,member));
 const allowedOrgs=new Set(selfOnlyRole(member)?employees.map(e=>e.orgId):[...scope]);
 return {positions:(state.positions??[]).filter(p=>selfOnlyRole(member)?employees.some(e=>e.positionId===p.id):scope.has(p.orgId)),grades:member.viewLevel?(state.grades??[]):[],employees,orgs:state.orgs.filter(o=>allowedOrgs.has(o.id)).map(o=>({...o,parentId:allowedOrgs.has(o.parentId)?o.parentId:'',leader:selfOnlyRole(member)?'':o.leader})),approvals,audit:[],workflows:undefined};
}
export function authorizeCommand(state:State,input:unknown,member:Member){
 requireMember(member);const c=commandSchema.parse(input);const scope=scopedOrgs(state,member);
 const allowedEmployee=(id:string)=>{const e=state.employees.find(e=>e.id===id);return !!e&&(member.role==='admin'||(selfOnlyRole(member)?e.id===member.employeeId:scope.has(e.orgId)));};
 if(c.action==='executeTransfer'||c.action==='cancelTransfer'){
 const a=state.approvals.find(a=>a.id===c.id),t=a?.details?.transfer;
 if(!a||!t||!['admin','hr'].includes(member.role)||!scope.has(t.source.orgId)||!scope.has(t.target.orgId)||transferChangesGrade(a)&&member.role!=='admin'&&!member.viewLevel)throw new AccessError('仅覆盖来源与目标组织且具有必要职级权限的HR可办理');
 }else if(c.action==='grade'){if(member.role!=='admin')throw new AccessError('仅管理员可维护职级体系');
 }else if(c.action==='position'){const old=state.positions?.find(p=>p.id===c.id);if(!['admin','hr'].includes(member.role)||!scope.has(c.orgId)||(old&&!scope.has(old.orgId)))throw new AccessError('没有此组织的岗位维护权限');
 }else if(c.action==='workflow'){if(member.role!=='admin')throw new AccessError('仅管理员可配置流程');
 }else if(c.action==='withdraw'){
 const a=state.approvals.find(a=>a.id===c.id);if(!a||a.createdBy!==member.userId||!allowedEmployee(a.employeeId))throw new AccessError('仅具有数据权限的申请人可撤回');
 }else if(c.action==='decide'){
 if(!['admin','manager','approver'].includes(member.role))throw new AccessError('没有审批权限');
 const a=state.approvals.find(a=>a.id===c.id);
 if(!a||!(a.details?.transfer?canReadTransferCase(a,member,scope):allowedEmployee(a.employeeId)))throw new AccessError('没有此申请的审批范围权限');
 if(transferChangesGrade(a)&&member.role!=='admin'&&!member.viewLevel)throw new AccessError('职级变化必须可见，不允许盲审');
 if(a.steps?.length&&a.steps[a.currentStep??0]?.userId!==member.userId)throw new AccessError('尚未轮到当前审批人');
 if(!a.createdBy||a.createdBy===member.userId||a.employeeId===member.employeeId)throw new AccessError('不能审批本人申请、本人异动或缺少申请人记录的历史申请');
 }else if(c.action==='request'){
 if(c.kind==='transfer'&&!['admin','hr'].includes(member.role))throw new AccessError('本包调动由指定HR发起，员工和经理自助保留后续范围');
 if(member.role==='approver'||!allowedEmployee(c.employeeId))throw new AccessError('没有此员工的申请权限');
 if(c.kind==='transfer'&&member.role!=='admin'&&!member.viewLevel&&c.gradeId&&c.gradeId!==state.employees.find(e=>e.id===c.employeeId)?.gradeId)throw new AccessError('没有职级修改权限');
 if(c.kind==='transfer'&&member.role!=='admin'&&!scope.has(c.orgId))throw new AccessError('没有调入组织的数据权限');
 }else if(c.action==='employee'){
 if(!['admin','hr'].includes(member.role)||!scope.has(c.orgId)||(c.id&&!allowedEmployee(c.id)))throw new AccessError('没有此员工或组织的维护权限');
 const old=state.employees.find(e=>e.id===c.id);
 if(member.role!=='admin'&&!member.viewLevel){if(c.gradeId&&c.gradeId!==old?.gradeId)throw new AccessError('没有职级修改权限');c.gradeId=old?.gradeId??null;}
 for(const field of ['email','level'] as const){const allowed=member.role==='admin'||(field==='email'?member.viewEmail:member.viewLevel);if(!allowed){if(c[field]&&c[field]!==old?.[field])throw new AccessError('没有该字段的修改权限');c[field]=old?.[field]??'';}}
 }else{
 const old=state.orgs.find(o=>o.id===c.id);
 if(member.role==='hr'&&old&&old.parentId&&!scope.has(old.parentId)&&c.parentId==='')c.parentId=old.parentId;
 if(!['admin','hr'].includes(member.role)||(member.role!=='admin'&&((c.id&&!scope.has(c.id))||(!c.id&&!scope.has(c.parentId))||(old&&c.parentId!==old.parentId&&!scope.has(c.parentId)))))throw new AccessError('没有此组织的维护权限');
 }
 return c;
}
