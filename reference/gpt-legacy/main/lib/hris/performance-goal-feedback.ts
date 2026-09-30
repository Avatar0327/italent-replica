import type {PerformanceTemplateSnapshot} from './performance-templates';
export type GoalRules=NonNullable<PerformanceTemplateSnapshot['goalRules']>;
export function goalRangeFeedback(r:GoalRules|undefined,goals:{weight:number}[]){
 if(!r)return [];
 const feedback:{kind:'count'|'weight';blocking:boolean;message:string}[]=[];
 if(goals.length<r.minCount||goals.length>r.maxCount)feedback.push({kind:'count',blocking:r.enforceCount!==false,message:`当前${goals.length}项，目标数量范围为${r.minCount}–${r.maxCount}项`});
 if(goals.some(g=>g.weight<r.minWeight||g.weight>r.maxWeight))feedback.push({kind:'weight',blocking:r.enforceWeight!==false,message:`存在超出${r.minWeight}%–${r.maxWeight}%范围的单项权重`});
 return feedback;
}
