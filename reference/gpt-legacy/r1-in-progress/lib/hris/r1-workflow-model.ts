import {z} from 'zod';
import {HttpError} from './http';
export type Expression={op:'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'in';field:string;value:string|number|boolean|(string|number|boolean)[]}|{op:'isNull';field:string}|{op:'and'|'or';args:Expression[]}|{op:'not';arg:Expression};
const scalar=z.union([z.string().max(500),z.number().int().safe(),z.boolean()]);
const expression:z.ZodType<Expression>=z.lazy(()=>z.union([z.object({op:z.enum(['eq','ne','gt','gte','lt','lte','in']),field:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/),value:z.union([scalar,z.array(scalar).max(50)])}).strict(),z.object({op:z.literal('isNull'),field:z.string()}).strict(),z.object({op:z.enum(['and','or']),args:z.array(expression).min(1).max(10)}).strict(),z.object({op:z.literal('not'),arg:expression}).strict()]));
const id=z.string().min(1).max(100);
const node=z.discriminatedUnion('type',[
 z.object({id,type:z.literal('review'),assignees:z.array(id).min(1).max(20),passPolicy:z.enum(['all','any']),rejectPolicy:z.enum(['any_reject','all_reject','block_for_review']),next:id}).strict(),
 z.object({id,type:z.literal('branch'),routes:z.array(z.object({when:expression,next:id}).strict()).min(1).max(10)}).strict(),z.object({id,type:z.literal('end')}).strict(),
]);
export const workflowDefinition=z.object({businessType:id,adapterVersion:id,entry:id,fields:z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,60}$/),z.enum(['string','number','boolean'])),nodes:z.array(node).min(2).max(20),interventionTargets:z.array(id).max(20),notificationTemplateVersion:z.number().int().positive().nullable()}).strict();
export type WorkflowDefinition=z.infer<typeof workflowDefinition>;
export type ReviewNode=Extract<WorkflowDefinition['nodes'][number],{type:'review'}>;
function error(message:string,code:string):never{throw new HttpError(400,message,code);}
export function validateDefinition(input:unknown){
 const d=workflowDefinition.parse(input);if(d.businessType==='personnel.transfer')error('D7调动不能启用通用流程功能','D7_PROTECTED');
 if(new Set(d.nodes.map(n=>n.id)).size!==d.nodes.length)error('节点编号重复','INVALID_GRAPH');
 const by=new Map(d.nodes.map(n=>[n.id,n])),visited=new Set<string>(),stack=new Set<string>();
 const inspect=(e:Expression,depth=0):void=>{if(depth>8)error('条件嵌套过深','INVALID_EXPRESSION');if('field'in e){const type=d.fields[e.field];if(!type)error('条件字段未声明','UNDECLARED_FIELD');if('value'in e){const values=Array.isArray(e.value)?e.value:[e.value];if(values.some(v=>typeof v!==type)||e.op==='in'&&!Array.isArray(e.value)||e.op!=='in'&&Array.isArray(e.value))error('条件类型不匹配','EXPRESSION_TYPE');if(['gt','gte','lt','lte'].includes(e.op)&&type==='boolean')error('布尔值不支持大小比较','EXPRESSION_TYPE');}}else if('args'in e)e.args.forEach(a=>inspect(a,depth+1));else inspect(e.arg,depth+1);};
 const visit=(id:string)=>{if(stack.has(id))error('流程图存在环','INVALID_GRAPH');if(visited.has(id))return;const n=by.get(id);if(!n)error('流程引用不存在的节点','INVALID_GRAPH');stack.add(id);if(n.type==='review'){if(new Set(n.assignees).size!==n.assignees.length)error('审批人重复','INVALID_ASSIGNEES');visit(n.next);}if(n.type==='branch'){const seen=new Set<string>();for(const route of n.routes){inspect(route.when);const key=JSON.stringify(route.when);if(seen.has(key))error('分支条件完全重复','AMBIGUOUS_ROUTE');seen.add(key);visit(route.next);}}stack.delete(id);visited.add(id);};
 visit(d.entry);if(visited.size!==d.nodes.length||!d.nodes.some(n=>n.type==='end'))error('存在不可达节点或缺少终点','INVALID_GRAPH');
 if(d.interventionTargets.some(id=>by.get(id)?.type!=='review'))error('干预目标必须是明确允许的审批节点','INVALID_INTERVENTION');return d;
}
export function evaluateExpression(e:Expression,values:Record<string,unknown>):boolean|null{
 if('field'in e){if(!Object.hasOwn(values,e.field))error('路由字段缺失','MISSING_ROUTE_INPUT');const v=values[e.field];if(e.op==='isNull')return v===null;if(v===null)return null;const target=e.value as any;
  switch(e.op){case'eq':return v===target;case'ne':return v!==target;case'in':return (target as unknown[]).includes(v);case'gt':return (v as any)>target;case'gte':return (v as any)>=target;case'lt':return (v as any)<target;case'lte':return (v as any)<=target;}
 }
 if('arg'in e){const r=evaluateExpression(e.arg,values);return r===null?null:!r;}
 const r=e.args.map(a=>evaluateExpression(a,values));return e.op==='and'?r.includes(false)?false:r.includes(null)?null:true:r.includes(true)?true:r.includes(null)?null:false;
}
export function resolveNode(d:WorkflowDefinition,key:string,values:Record<string,unknown>){
 for(let steps=0;steps<=d.nodes.length;steps++){
  const n=d.nodes.find(n=>n.id===key);if(!n)error('节点不存在','INVALID_GRAPH');if(n.type!=='branch')return n;
  for(const [name,type] of Object.entries(d.fields))if(Object.hasOwn(values,name)&&values[name]!==null&&typeof values[name]!==type)error('原单路由字段类型变化','SOURCE_SCHEMA_CHANGED');
  const hits=n.routes.filter(r=>evaluateExpression(r.when,values)===true);if(hits.length!==1)error(hits.length?'分支命中多条':'没有可用分支',hits.length?'AMBIGUOUS_ROUTE':'NO_ROUTE');key=hits[0].next;
 }
 return error('流程解析超出节点边界','INVALID_GRAPH');
}
export function resolveDecisions(node:ReviewNode,decisions:{actorId:string;decision:string}[]){
 const approved=decisions.filter(d=>d.decision==='approved').length,rejected=decisions.filter(d=>d.decision==='rejected').length;
 if(node.rejectPolicy==='any_reject'&&rejected||node.rejectPolicy==='all_reject'&&rejected===node.assignees.length)return 'rejected';
 if(node.rejectPolicy==='block_for_review'&&rejected)return 'blocked';
 if(node.passPolicy==='any'&&approved||node.passPolicy==='all'&&approved===node.assignees.length)return 'approved';return 'pending';
}
