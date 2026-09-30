import {goalRangeFeedback,type GoalRules} from '@/lib/hris/performance-goal-feedback';
export default function GoalRuleNotice({rules,goals}:{rules?:GoalRules;goals?:{weight:number}[]}){
 if(!rules)return null;
 return <div className="rounded border bg-blue-50 p-3 text-sm space-y-2"><p>目标数量 {rules.minCount}–{rules.maxCount} 项（{rules.enforceCount===false?'仅提示':'强制限制'}）；单项权重 {rules.minWeight}%–{rules.maxWeight}%（{rules.enforceWeight===false?'仅提示':'强制限制'}）。</p><p>总权重仍须100%，目标数1–20项，单项为1–100的整数。</p>{goals&&<div aria-live="polite">{goalRangeFeedback(rules,goals).map(f=><p key={f.kind} className={f.blocking?'text-red-700':'text-amber-800'}>{f.blocking?'需调整后保存：':'提示，不阻止保存：'}{f.message}</p>)}</div>}</div>;
}
