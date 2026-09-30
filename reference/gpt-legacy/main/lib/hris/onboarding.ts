import {z} from 'zod';
import {HttpError} from './http';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import {businessDate} from './workforce';
import type {State} from './model';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200),evidence=z.string().trim().min(5).max(2000);
export const onboardingCommand=z.discriminatedUnion('action',[
 z.object({action:z.literal('template'),code:text,title:text,items:z.array(text).min(1).max(30)}),
 z.object({action:z.literal('publish'),id}),z.object({action:z.literal('archive'),id}),
 z.object({action:z.literal('assign'),templateId:id,employeeId:id,due:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),evidence}),
 z.object({action:z.literal('submit'),id,itemId:id,evidence}),
 z.object({action:z.literal('verify'),id,itemId:id,accepted:z.boolean(),evidence}),
 z.object({action:z.literal('close'),id,evidence}),z.object({action:z.literal('cancel'),id,evidence}),
]);
export function applyOnboarding(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=onboardingCommand.parse(input),hr=['admin','hr'].includes(m.role),manager=hr||m.role==='manager',scope=scopedOrgs(state,m);
 const deny=(message:string):never=>{throw new HttpError(403,message);},fail=(message:string):never=>{throw new HttpError(400,message);};
 const get=(id:string,kind:R['kind'])=>{const r=records.find(r=>r.id===id&&r.kind===kind);if(!r||!visibleRecord(r,records,state,m))deny('记录不存在或没有访问权限');return r!;};
 const make=(kind:R['kind'],payload:R['payload'],extra:Partial<R>={}):R=>({id:crypto.randomUUID(),kind,payload,employeeId:null,positionId:null,referenceId:null,status:'draft',createdBy:m.userId,createdAt:at,updatedAt:at,...extra});
 const change=(r:R,status:string,payload:R['payload']={}):R=>({...r,status,payload:{...r.payload,...payload},updatedAt:at});
 if(c.action==='template'){if(!hr)deny('仅HR或管理员可维护融入模板');if(new Set(c.items).size!==c.items.length)fail('办理事项不得重复');const versions=records.filter(r=>r.kind==='onboardingTemplate'&&r.payload.code===c.code);return make('onboardingTemplate',{code:c.code,title:c.title,version:Math.max(0,...versions.map(r=>r.payload.version??0))+1,onboardingItems:c.items.map(title=>({id:crypto.randomUUID(),title,status:'pending'}))});}
 if(c.action==='publish'||c.action==='archive'){if(!hr)deny('仅HR或管理员可维护融入模板');const r=get(c.id,'onboardingTemplate');if(c.action==='publish'&&r.status!=='draft'||c.action==='archive'&&r.status!=='published')fail('模板状态不允许此操作');return change(r,c.action==='publish'?'published':'archived');}
 if(c.action==='assign'){if(!hr)deny('仅HR或管理员可指派融入计划');const t=get(c.templateId,'onboardingTemplate'),e=state.employees.find(e=>e.id===c.employeeId);if(!e||!scope.has(e.orgId))deny('没有此员工的管理权限');if(e!.status==='离职'||t.status!=='published')fail('员工须在职且模板已经发布');const parsed=new Date(c.due+'T00:00:00Z');if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==c.due||c.due<businessDate(at))fail('截止日期无效或已过期');if(records.some(r=>r.kind==='onboardingPlan'&&r.employeeId===c.employeeId&&r.status==='active'))fail('此员工已有进行中的融入计划');return make('onboardingPlan',{title:t.payload.title,code:t.payload.code,version:t.payload.version,due:c.due,evidence:c.evidence,onboardingItems:t.payload.onboardingItems?.map(x=>({...x}))},{employeeId:c.employeeId,referenceId:t.id,status:'active'});}
 const r=get(c.id,'onboardingPlan');if(r.status!=='active')fail('计划已结项或取消');
 if(c.action==='close'||c.action==='cancel'){if(!hr||r.employeeId===m.employeeId)deny('须由其他有权限HR结项或取消');if(c.action==='close'&&!r.payload.onboardingItems?.every(x=>x.status==='verified'))fail('所有办理事项须先独立核验通过');return change(r,c.action==='close'?'closed':'cancelled',{closedReason:c.evidence,verifiedBy:m.userId,verifiedAt:at});}
 const items=r.payload.onboardingItems??[],item=items.find(x=>x.id===c.itemId);if(!item)fail('办理事项不存在');
 if(c.action==='submit'){if(r.employeeId!==m.employeeId)deny('仅员工本人可提交办理依据');if(!['pending','returned'].includes(item!.status))fail('事项已提交或已核验');return change(r,'active',{onboardingItems:items.map(x=>x.id===c.itemId?{...x,status:'submitted',evidence:c.evidence,submittedBy:m.userId,submittedAt:at}:x)});}
 if(!manager||r.employeeId===m.employeeId||item!.submittedBy===m.userId)deny('须由其他有权限管理者核验');if(item!.status!=='submitted')fail('事项尚未提交或已处理');return change(r,'active',{onboardingItems:items.map(x=>x.id===c.itemId?{...x,status:c.accepted?'verified':'returned',verification:c.evidence,verifiedBy:m.userId,verifiedAt:at}:x)});
}
