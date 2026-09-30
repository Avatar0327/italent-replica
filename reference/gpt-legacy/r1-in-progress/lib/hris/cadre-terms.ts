import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
const id=z.string().min(1).max(100),evidence=z.string().trim().min(5).max(3000);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
const fields={orgId:id,positionId:id,appointmentType:z.literal('主职'),start:date,expectedEnd:date.optional(),observationEnd:date.optional(),supervisorId:id.optional(),evidence};
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('register'),employeeId:id,...fields}),
 z.object({action:z.literal('correct'),id,...fields}),
 z.object({action:z.literal('end'),id,actualEnd:date,endReason:z.enum(['免职','离职','退休']),evidence}),
 z.object({action:z.literal('void'),id,evidence}),
]);
export function applyCadreTerm(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=command.parse(input),scope=scopedOrgs(state,m);
 const deny=(s:string):never=>{throw new HttpError(403,s);},fail=(s:string):never=>{throw new HttpError(400,s);};
 if(!['admin','hr'].includes(m.role))deny('干部任期登记由HR或管理员办理');
 const old=c.action==='register'?undefined:records.find(r=>r.id===c.id&&r.kind==='cadreTerm');
 if(c.action!=='register'&&(!old||!visibleRecord(old,records,state,m)))deny('没有此任期的访问权限');
 const employeeId=c.action==='register'?c.employeeId:old!.employeeId!,e=state.employees.find(e=>e.id===employeeId);
 if(!e||!scope.has(e.orgId)||employeeId===m.employeeId)deny('没有此员工任期的登记权限，不能办理本人任期');
 if(old?.status==='voided'||old?.status==='ended')fail('已结束或作废的任期只保留历史');
 if(c.action==='end'||c.action==='void'){
  if(c.action==='end'&&c.actualEnd<old!.payload.cadreTerm!.start)fail('实际结束日期不能早于任期开始');
  if(c.action==='end'&&c.endReason==='离职'&&e!.status!=='离职')fail('离职结束须先完成人事离职登记');
  return {...old!,status:c.action==='end'?'ended':'voided',updatedAt:at,payload:{...old!.payload,evidence:c.evidence,cadreTerm:{...old!.payload.cadreTerm!,...(c.action==='end'?{actualEnd:c.actualEnd,endReason:c.endReason}:{})}}};
 }
 const p=state.positions?.find(p=>p.id===c.positionId);
 if(!scope.has(c.orgId)||!p||p.orgId!==c.orgId)deny('任用部门与岗位须匹配且在管理范围内');
 if(p!.status!=='启用'||e!.status==='离职')fail('新建或更正须使用在职员工与启用岗位');
 if(c.expectedEnd&&c.expectedEnd<c.start||c.observationEnd&&c.observationEnd<c.start||c.expectedEnd&&c.observationEnd&&c.observationEnd>c.expectedEnd)fail('任期与考察日期顺序无效');
 if(c.supervisorId){const s=state.employees.find(e=>e.id===c.supervisorId);if(!s||s.status==='离职'||s.id===employeeId||!scope.has(s.orgId))deny('汇报上级须为权限范围内的其他在职人员');}
 const overlaps=records.some(r=>r.kind==='cadreTerm'&&r.id!==old?.id&&r.employeeId===employeeId&&r.status!=='voided'&&r.payload.cadreTerm&&r.payload.cadreTerm.start<=(c.expectedEnd??'9999-12-31')&&c.start<=(r.payload.cadreTerm.actualEnd??r.payload.cadreTerm.expectedEnd??'9999-12-31'));
 if(overlaps)fail('同一员工的主职任期不能重叠，请先核对原任期');
 return {id:old?.id??crypto.randomUUID(),kind:'cadreTerm',employeeId,positionId:p!.id,referenceId:null,status:'registered',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{evidence:c.evidence,targetPositionName:p!.name,cadreTerm:{orgId:c.orgId,appointmentType:c.appointmentType,start:c.start,expectedEnd:c.expectedEnd,observationEnd:c.observationEnd,supervisorId:c.supervisorId}}};
}
