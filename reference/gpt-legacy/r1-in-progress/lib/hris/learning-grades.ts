import {examGradeAttempts,homeworkGradeEvidence} from './learning-grade-evidence';
import {z} from 'zod';
import type {DevelopmentRecord as R} from './development';
import {learningRequirements} from './learning-requirements';
const policy={attempts:z.enum(['all','passed']),decimals:z.number().int().min(0).max(2)};
export const learningGradeRuleSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('none')}).strict(),
 z.object({mode:z.literal('contentWeighted'),...policy,items:z.array(z.object({requirementId:z.string().min(1).max(120),source:z.enum(['examHighest','examAverage','homeworkLatest']),weight:z.number().int().min(1).max(100)}).strict()).min(1).max(20).refine(items=>new Set(items.map(i=>i.requirementId)).size===items.length&&items.reduce((n,i)=>n+i.weight,0)===100,'权重项目须唯一且总计100%')}).strict(),
 z.object({mode:z.literal('allHighest'),...policy}).strict(),
 z.object({mode:z.literal('allAttemptsAverage'),...policy}).strict(),
 z.object({mode:z.literal('eachExamHighestAverage'),...policy}).strict(),
 z.object({mode:z.literal('specifiedExamHighest'),examId:z.string().min(1).max(100),...policy}).strict(),
]);
export type LearningGradeRule=z.infer<typeof learningGradeRuleSchema>;
export function learningGrade(assignment:R,records:R[]){
 const parsed=learningGradeRuleSchema.safeParse(assignment.payload.gradeRule??{mode:'none'});
 const pending=(missingExamIds:string[]=[])=>({state:'pending' as const,score:null,missingExamIds,missingRequirementIds:missingExamIds.map(id=>'exam:'+id),attemptIds:[] as string[],evidenceIds:[] as string[]});
 if(!parsed.success)return pending();
 const rule=parsed.data;
 if(rule.mode==='none')return {state:'not_configured' as const,score:null,missingExamIds:[],missingRequirementIds:[] as string[],attemptIds:[] as string[],evidenceIds:[] as string[]};
 if(rule.mode==='contentWeighted'){
  const requirements=learningRequirements(assignment),groups=rule.items.map(item=>{
   const requirement=requirements.find(r=>r.id===item.requirementId);
   const evidence=item.source==='homeworkLatest'?[homeworkGradeEvidence(assignment,records,requirement,rule.attempts)].filter((r):r is R=>!!r):examGradeAttempts(assignment,records,requirement,rule.attempts);
   const scores=evidence.map(r=>r.payload.score!);
   return {item,requirement,evidence,value:scores.length?(item.source==='examHighest'?Math.max(...scores):scores.reduce((a,b)=>a+b,0)/scores.length):null};
  });
  const missing=groups.filter(g=>g.value===null);if(missing.length)return {...pending(missing.filter(g=>g.requirement?.kind==='exam').map(g=>g.requirement!.resourceId)),missingRequirementIds:missing.map(g=>g.item.requirementId)};
  const raw=groups.reduce((n,g)=>n+g.value!*g.item.weight/100,0),factor=10**rule.decimals,evidence=groups.flatMap(g=>g.evidence);
  return {state:assignment.status==='completed'?'final' as const:'provisional' as const,score:Math.round((raw+Number.EPSILON)*factor)/factor,missingExamIds:[],missingRequirementIds:[],attemptIds:evidence.filter(r=>r.kind==='learningExamAttempt').map(r=>r.id).sort(),evidenceIds:evidence.map(r=>r.id).sort()};
 }
 const examIds=rule.mode==='specifiedExamHighest'?[rule.examId]:assignment.payload.examIds??[];
 if(!examIds.length||new Set(examIds).size!==examIds.length||examIds.some(id=>!assignment.payload.examIds?.includes(id)))return pending(examIds);
 const requirements=learningRequirements(assignment),groups=examIds.map(examId=>{
  const requirement=requirements.find(r=>r.kind==='exam'&&r.resourceId===examId);
  return {examId,attempts:examGradeAttempts(assignment,records,requirement,rule.attempts)};
 });
 const missing=groups.filter(g=>!g.attempts.length).map(g=>g.examId);
 if(missing.length)return pending(missing);
 const attempts=groups.flatMap(g=>g.attempts),scores=attempts.map(a=>a.payload.score!),mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length;
 const raw=rule.mode==='allAttemptsAverage'?mean(scores):rule.mode==='eachExamHighestAverage'?mean(groups.map(g=>Math.max(...g.attempts.map(a=>a.payload.score!)))):Math.max(...scores);
 const factor=10**rule.decimals,score=Math.round((raw+Number.EPSILON)*factor)/factor;
 return {state:assignment.status==='completed'?'final' as const:'provisional' as const,score,missingExamIds:[],missingRequirementIds:[],attemptIds:attempts.map(a=>a.id).sort(),evidenceIds:attempts.map(a=>a.id).sort()};
}
