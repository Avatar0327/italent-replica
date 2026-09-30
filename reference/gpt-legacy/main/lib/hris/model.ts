import {businessDate} from './business-time.ts';
import {transferSnapshot,transferSourceMatches,transferAwaitingExecution,type ApprovalDetails} from './personnel-transfer.ts';
import { z } from 'zod';
export type Org = {id:string;name:string;parentId:string;city:string;leader:string;status:string};
export type Grade={id:string;code:string;name:string;sequence:number;status:string};
export type Position={id:string;code:string;name:string;orgId:string;family:string;responsibilities:string;status:string};
export type Employee = {positionId?:string|null;gradeId?:string|null;id:string;code:string;name:string;orgId:string;job:string;level:string;joined:string;status:string;email:string};
export type ApprovalStep={userId:string;name:string;decision?:'approved'|'rejected';at?:string};
export type Workflow={version:number;steps:{userId:string;name:string}[]};
export type Approval = {details?:ApprovalDetails;positionId?:string|null;gradeId?:string|null;id:string;employeeId:string;kind:'transfer'|'regularize'|'exit';orgId:string;reason:string;status:'pending'|'approved'|'rejected'|'withdrawn';steps?:ApprovalStep[];currentStep?:number;workflowVersion?:number;created:string;createdBy?:string;decidedBy?:string;decided?:string};
export type Audit = {id:string;action:string;subject:string;at:string;actorId?:string};
export type State = {orgs:Org[];employees:Employee[];approvals:Approval[];audit:Audit[];positions?:Position[];grades?:Grade[];workflows?:Partial<Record<Approval['kind'],Workflow>>};
const text=z.string().trim().min(1).max(100);
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().startsWith(v),'日期无效');
export const commandSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('position'),id:z.string().optional(),code:text,name:text,orgId:text,family:text,responsibilities:z.string().max(4000),status:z.enum(['启用','停用'])}),
 z.object({action:z.literal('grade'),id:z.string().optional(),code:text,name:text,sequence:z.number().int().min(0).max(999),status:z.enum(['启用','停用'])}),
 z.object({action:z.literal('employee'),positionId:z.string().min(1).nullish(),gradeId:z.string().min(1).nullish(),id:z.string().optional(),code:text,name:text,orgId:text,job:text,level:z.string().trim().max(100),joined:isoDate,email:z.union([z.literal(''),z.string().email()])}),
 z.object({action:z.literal('org'),id:z.string().optional(),name:text,parentId:z.string(),city:text,leader:z.string().max(100),status:z.enum(['启用','停用'])}),
 z.object({action:z.literal('request'),positionId:z.string().min(1).nullish(),gradeId:z.string().min(1).nullish(),employeeId:text,kind:z.enum(['transfer','regularize','exit']),orgId:z.string(),effectiveOn:isoDate.optional(),previousApprovalId:z.string().min(1).max(100).optional(),reason:z.string().trim().min(2).max(500)}),
 z.object({action:z.literal('workflow'),kind:z.enum(['transfer','regularize','exit']),steps:z.array(z.object({userId:text,name:text})).min(1).max(5).refine(v=>new Set(v.map(s=>s.userId)).size===v.length,'审批人不能重复')}),
 z.object({action:z.literal('withdraw'),id:text}),
 z.object({action:z.literal('decide'),id:text,decision:z.enum(['approved','rejected']),decisionReason:z.string().trim().min(2).max(500).optional()}),
 z.object({action:z.literal('executeTransfer'),id:text}),
 z.object({action:z.literal('cancelTransfer'),id:text,reason:z.string().trim().min(2).max(500)}),
]);
export function initialState():State {
 const orgs=[{id:'o1',name:'星海科技集团',parentId:'',city:'上海',leader:'陈予安',status:'启用'},...['人力资源中心','产品研发中心','商业运营中心','财务管理中心'].map((name,i)=>({id:'o'+(i+2),name,parentId:'o1',city:['上海','深圳','北京','上海'][i],leader:['林知夏','周启明','沈远舟','许清禾'][i],status:'启用'}))];
 const names=['林知夏','周启明','沈远舟','许清禾','陈予安','苏以宁','陆景行','江念初','顾星河','温书言','程见微','叶明川'];
 return {orgs,employees:names.map((name,i)=>({id:'e'+(i+1),code:'HX'+String(1001+i),name,orgId:'o'+(2+i%4),job:['人才发展经理','产品经理','区域运营经理','财务分析师'][i%4],level:['P6','P7','P6','P5'][i%4],joined:`2026-0${1+i%8}-01`,status:i>8?'试用':'正式',email:`demo${i+1}@example.com`})),approvals:[{id:'a1',employeeId:'e10',kind:'regularize',orgId:'o3',reason:'试用期目标完成，申请转正。',status:'pending',created:'2026-09-07T08:30:00.000Z'},{id:'a2',employeeId:'e7',kind:'transfer',orgId:'o2',reason:'参与集团人才发展项目，申请内部调动。',status:'pending',created:'2026-09-06T10:00:00.000Z'}],audit:[]};
}
export function applyCommand(previous:State, input:unknown, now=new Date().toISOString(), actorId?:string):State {
 const c=commandSchema.parse(input);const s=structuredClone(previous);const id=()=>crypto.randomUUID();let subject='';
 const activeOrg=(key:string)=>{const o=s.orgs.find(x=>x.id===key&&x.status==='启用');if(!o)throw Error('请选择有效的启用组织');return o;};
 const assignment=(orgId:string,positionId:string|null|undefined,gradeId:string|null|undefined)=>{const position=positionId?s.positions?.find(p=>p.id===positionId&&p.status==='启用'):null;const grade=gradeId?s.grades?.find(g=>g.id===gradeId&&g.status==='启用'):null;if(positionId&&(!position||position.orgId!==orgId))throw Error('岗位必须属于目标组织且处于启用状态');if(gradeId&&!grade)throw Error('职级不存在或已停用');return {position,grade};};
 if(c.action==='executeTransfer'||c.action==='cancelTransfer'){
 const a=s.approvals.find(a=>a.id===c.id);if(!a||!transferAwaitingExecution(a))throw Error('调动不处于已批准待生效状态');const t=a.details!.transfer!,e=s.employees.find(e=>e.id===a.employeeId)!;
 if(c.action==='cancelTransfer'){t.execution='cancelled';t.cancelReason=c.reason;t.cancelledAt=now;}else{
 if(Date.parse(now)<Date.parse(t.eligibleAt))throw Error('尚未到北京时间生效日00:00');t.attempts++;t.lastAttemptAt=now;
 try{if(!e||e.status==='离职'||!transferSourceMatches(a,e))throw Error('来源任职已变化，须取消原单并重新完整审批');activeOrg(t.source.orgId);activeOrg(t.target.orgId);const current=assignment(t.target.orgId,t.target.positionId,t.target.gradeId);if(current.position&&current.position.name!==t.target.job||current.grade&&current.grade.name!==t.target.level)throw Error('目标岗位或职级名称已变化，须取消原单并重新完整审批');
 e.orgId=t.target.orgId;e.positionId=t.target.positionId;e.job=t.target.job;e.gradeId=t.target.gradeId;e.level=t.target.level;t.execution='applied';t.appliedAt=now;t.appliedBy=actorId;delete t.failure;
 }catch(error){t.execution='failed';t.failure=(error as Error).message;}
 }subject=t.employeeName;
 }else if(c.action==='position'||c.action==='grade'){
 const isPosition=c.action==='position';const list=isPosition?(s.positions??=[]):(s.grades??=[]);const old=list.find(x=>x.id===c.id);if(c.id&&!old)throw Error('记录不存在');if(list.some(x=>x.code===c.code&&x.id!==c.id))throw Error('编码已存在');
 const inUse=s.employees.some(e=>e.status!=='离职'&&(isPosition?e.positionId:e.gradeId)===c.id)||s.approvals.some(a=>a.status==='pending'&&(isPosition?a.positionId:a.gradeId)===c.id);
 if(c.id&&inUse&&(c.status==='停用'||c.name!==old?.name||c.code!==old?.code||(isPosition&&c.orgId!==(old as Position).orgId)))throw Error('存在在职关联或待审批申请，不能停用或改变标识和归属');
 if(isPosition)activeOrg(c.orgId);const {action,...data}=c;const value={...data,id:old?.id??id()};if(isPosition)s.positions=old?s.positions!.map(x=>x.id===old.id?value as Position:x):[...s.positions!,value as Position];else s.grades=old?s.grades!.map(x=>x.id===old.id?value as Grade:x):[...s.grades!,value as Grade];subject=c.name;
 }else if(c.action==='workflow'){
 s.workflows??={};s.workflows[c.kind]={version:(s.workflows[c.kind]?.version??0)+1,steps:c.steps};subject=c.kind;
 }else if(c.action==='withdraw'){
 const a=s.approvals.find(a=>a.id===c.id);if(!a||a.status!=='pending'||!actorId||a.createdBy!==actorId)throw Error('仅申请人可以撤回待审批申请');a.status='withdrawn';a.decided=now;a.decidedBy=actorId;subject=a.employeeId;
 }else if(c.action==='employee'){
 activeOrg(c.orgId);if(s.employees.some(e=>e.code===c.code&&e.id!==c.id))throw Error('员工编号已存在');
 const old=c.id?s.employees.find(e=>e.id===c.id):null;if(c.id&&!old)throw Error('员工不存在');
 if(old&&old.orgId!==c.orgId)throw Error('在职人员组织变更请提交调动审批');
 if(old?.status==='离职')throw Error('离职人员不可直接编辑');
 const positionId=c.positionId===undefined?old?.positionId:c.positionId,gradeId=c.gradeId===undefined?old?.gradeId:c.gradeId;
 const {position,grade}=assignment(c.orgId,positionId,gradeId);const job=position?.name??c.job,level=grade?.name??c.level;
 if(old&&((!old.positionId&&positionId&&old.job!==job)||(!old.gradeId&&gradeId&&old.level&&old.level!==level)))throw Error('首次关联与原任职名称不一致，请提交调动审批');
 if(old&&((old.positionId&&old.positionId!==positionId)||(old.gradeId&&old.gradeId!==gradeId)||(!positionId&&old.job!==job)||(!gradeId&&old.level!==level)))throw Error('岗位或职级变更请提交调动审批');
 const {action,...data}=c;const e={...data,positionId:positionId??null,gradeId:gradeId??null,job,level,id:old?.id??id(),status:old?.status??'试用'};s.employees=old?s.employees.map(x=>x.id===old.id?e:x):[e,...s.employees];subject=c.name;
 }else if(c.action==='org'){
 const old=s.orgs.find(o=>o.id===c.id);if(c.id&&!old)throw Error('组织不存在');if(c.parentId)activeOrg(c.parentId);
 const seen=new Set([c.id]);let parent=c.parentId;while(parent){if(seen.has(parent))throw Error('上级组织不能形成循环');seen.add(parent);parent=s.orgs.find(o=>o.id===parent)?.parentId??'';}
 if(s.orgs.some(o=>o.name===c.name&&o.parentId===c.parentId&&o.id!==c.id))throw Error('同级组织名称已存在');
 if(c.status==='停用'&&(s.employees.some(e=>e.orgId===c.id&&e.status!=='离职')||s.orgs.some(o=>o.parentId===c.id&&o.status==='启用')||s.approvals.some(a=>a.orgId===c.id&&a.status==='pending')||s.positions?.some(p=>p.orgId===c.id&&p.status==='启用')))throw Error('组织存在在职员工、启用下级、启用岗位或待审批调动，不能停用');
 const {action,...data}=c;const o={...data,id:old?.id??id()};s.orgs=old?s.orgs.map(x=>x.id===old.id?o:x):[...s.orgs,o];subject=c.name;
 }else if(c.action==='request'){
 const e=s.employees.find(e=>e.id===c.employeeId);if(!e||e.status==='离职')throw Error('员工不存在或已离职');if(s.approvals.some(a=>a.employeeId===e.id&&(a.status==='pending'||transferAwaitingExecution(a))))throw Error('该员工已有待处理的人事申请');
 if(c.kind==='regularize'&&e.status!=='试用')throw Error('仅试用员工可申请转正');if(c.kind==='transfer'){activeOrg(c.orgId);if(c.orgId===e.orgId&&(c.positionId??e.positionId??null)===(e.positionId??null)&&(c.gradeId??e.gradeId??null)===(e.gradeId??null))throw Error('组织、岗位和职级均未变化');if(e.positionId&&c.orgId!==e.orgId&&!c.positionId)throw Error('跨组织调动请选择目标岗位');assignment(c.orgId,c.positionId??(c.orgId===e.orgId?e.positionId:null),c.gradeId??e.gradeId);}
 const previous=c.previousApprovalId?s.approvals.find(a=>a.id===c.previousApprovalId):undefined;
 if(c.kind==='transfer'&&c.effectiveOn&&!c.previousApprovalId&&s.approvals.some(a=>a.employeeId===e.id&&a.kind===c.kind&&(['rejected','withdrawn'].includes(a.status)||a.details?.transfer?.execution==='cancelled')))throw Error('存在已终止原单，请从原单详情关联新申请，重新完整审批');
 if(c.previousApprovalId&&(!previous||previous.employeeId!==e.id||previous.kind!==c.kind||!(['rejected','withdrawn'].includes(previous.status)||previous.details?.transfer?.execution==='cancelled')))throw Error('关联原单须为同员工同类型已终止申请');
 const workflow=s.workflows?.[c.kind];if(actorId&&!workflow)throw Error('请先由管理员配置该类型审批流程');if(workflow?.steps.some(step=>step.userId===actorId))throw Error('申请人不能同时是本流程审批人');
 let details:ApprovalDetails|undefined=c.previousApprovalId?{previousApprovalId:c.previousApprovalId}:undefined;
 if(c.kind==='transfer'&&c.effectiveOn){if(c.effectiveOn<businessDate(now))throw Error('不允许回溯生效日期');if(workflow?.steps.length!==2)throw Error('本包调动须配置调出、调入两级审批');const targetAssignment=assignment(c.orgId,c.positionId??(c.orgId===e.orgId?e.positionId:null),c.gradeId??e.gradeId);const targetEmployee={...e,orgId:c.orgId,positionId:targetAssignment.position?.id??null,gradeId:targetAssignment.grade?.id??e.gradeId,job:targetAssignment.position?.name??e.job,level:targetAssignment.grade?.name??e.level};details={...details,transfer:{policy:'two-party-dated-v1',gradeChanged:(e.gradeId??null)!==(targetEmployee.gradeId??null)||e.level!==targetEmployee.level,effectiveOn:c.effectiveOn,eligibleAt:new Date(c.effectiveOn+'T00:00:00+08:00').toISOString(),employeeName:e.name,employeeCode:e.code,source:transferSnapshot(s,e),target:transferSnapshot(s,targetEmployee),execution:'waiting',attempts:0}};}
 s.approvals.unshift({...(details?{details}:{}),positionId:c.kind==='transfer'?(c.positionId??(c.orgId===e.orgId?e.positionId:null)??null):(e.positionId??null),gradeId:c.kind==='transfer'?(c.gradeId??e.gradeId??null):(e.gradeId??null),steps:workflow?structuredClone(workflow.steps):undefined,currentStep:workflow?0:undefined,workflowVersion:workflow?.version,id:id(),employeeId:e.id,kind:c.kind,orgId:c.kind==='transfer'?c.orgId:e.orgId,reason:c.reason,status:'pending',created:now,createdBy:actorId});subject=e.name;
 }else{
 const a=s.approvals.find(a=>a.id===c.id);if(!a||a.status!=='pending')throw Error('审批不存在或已处理，请刷新');if(actorId&&(!a.createdBy||a.createdBy===actorId))throw Error('不能审批本人申请或缺少申请人记录的历史申请');const e=s.employees.find(e=>e.id===a.employeeId);if(!e||e.status==='离职')throw Error('关联员工状态已变化');
 if(a.details?.transfer&&(a.details.transfer.effectiveOn<businessDate(now)||!transferSourceMatches(a,e))&&c.decision==='approved')throw Error('生效日已过或来源任职变化，须撤回并重新完整审批');
 if(c.decision==='rejected'){if(!c.decisionReason)throw Error('驳回须填写原因');a.details={...a.details,rejectionReason:c.decisionReason};}
 let finished=true;if(a.steps?.length){const step=a.steps[a.currentStep??0];if(!actorId||step.userId!==actorId)throw Error('尚未轮到当前审批人');step.decision=c.decision;step.at=now;if(c.decision==='approved'&&(a.currentStep??0)<a.steps.length-1){a.currentStep=(a.currentStep??0)+1;finished=false;}}
 if(finished&&c.decision==='approved'){if(a.kind==='transfer'&&!a.details?.transfer){activeOrg(a.orgId);const {position,grade}=assignment(a.orgId,a.positionId,a.gradeId);e.orgId=a.orgId;e.positionId=a.positionId??null;e.gradeId=a.gradeId??null;if(position)e.job=position.name;if(grade)e.level=grade.name;}if(a.kind==='regularize'){if(e.status!=='试用')throw Error('员工已非试用状态');e.status='正式';}if(a.kind==='exit')e.status='离职';}if(finished){a.status=c.decision;a.decided=now;a.decidedBy=actorId;}subject=e.name;
 }
 s.audit.unshift({id:id(),action:{position:'保存岗位',grade:'保存职级',workflow:'配置审批流程',withdraw:'撤回人事申请',employee:'保存员工档案',org:'保存组织',request:'发起人事申请',decide:'处理人事审批',executeTransfer:'执行调动生效',cancelTransfer:'取消待生效调动'}[c.action],subject,at:now,actorId});return s;
}
