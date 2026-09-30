'use client';
import type {DevelopmentRecord as R} from '@/lib/hris/development';
import type {PerformanceGoal} from '@/lib/hris/performance-indicators';
export type EditableGoal=PerformanceGoal&{indicatorId?:string};
export function editableGoals(goals:PerformanceGoal[]):EditableGoal[]{return goals.map(g=>({...g,indicatorId:g.indicatorSource?.id}));}
export function goalCommands(goals:EditableGoal[]){return goals.map(({title,metric,weight,indicatorId})=>({title,metric,weight,...(indicatorId?{indicatorId}:{})}));}
export default function IndicatorPicker({goal,records,orgId,onChange}:{goal:EditableGoal;records:R[];orgId?:string;onChange:(g:EditableGoal)=>void}){
 const options=records.filter(r=>r.kind==='performanceIndicator'&&r.status==='sealed'&&r.payload.orgId===orgId),retained=goal.indicatorSource;
 return <div className="space-y-1"><label className="field">参考指标（可选）<select className="rounded border bg-white p-2" value={goal.indicatorId??''} onChange={e=>{const r=options.find(r=>r.id===e.target.value);onChange({...goal,indicatorId:e.target.value||undefined,...(r?{title:r.payload.indicator!.title,metric:r.payload.indicator!.metric,indicatorSource:undefined}:{}),...(e.target.value?{}:{indicatorSource:undefined})});}}><option value="">手工目标</option>{retained&&!options.some(r=>r.id===retained.id)&&<option value={retained.id}>{retained.code} · {retained.title} · 保留V{retained.version}</option>}{options.map(r=><option value={r.id} key={r.id}>{r.payload.indicator?.code} · {r.payload.indicator?.title} · V{r.payload.version}</option>)}</select></label><p className="text-xs text-slate-500">指标作为来源保留；目标名称和衡量标准可补充，仍按本周期权重和规则评价。</p></div>;
}

export function IndicatorSource({source}:{source:PerformanceGoal['indicatorSource']}){return source?<details className="rounded bg-slate-50 p-2 text-xs"><summary>指标来源：{source.code} · V{source.version} · {source.category}</summary><p className="mt-2">原名称：{source.title}</p><p className="mt-1 whitespace-pre-wrap">原描述：{source.description||'未填写'}</p><p className="mt-1 whitespace-pre-wrap">原衡量标准：{source.metric||'未填写'}</p></details>:null;}
