import {z} from 'zod';
import type {DevelopmentRecord as R} from './development';
import {HttpError} from './http';
export type ObjectiveQuestion={type:'single'|'multiple'|'trueFalse';prompt:string;options:string[];correct?:number[];points:number;partialPoints?:number};
export const objectiveQuestionSchema=z.object({type:z.enum(['single','multiple','trueFalse']),prompt:z.string().trim().min(5).max(4000),options:z.array(z.string().trim().min(1).max(200)).min(2).max(6),correct:z.array(z.number().int().min(0).max(5)).min(1).max(6),points:z.number().int().min(1).max(100),partialPoints:z.number().int().min(0).max(100).optional()}).strict().superRefine((q,ctx)=>{
 if(new Set(q.options).size!==q.options.length||new Set(q.correct).size!==q.correct.length||q.correct.some(i=>i>=q.options.length))ctx.addIssue({code:z.ZodIssueCode.custom,message:'选项及正确答案须有效且不重复'});
 if(q.type!=='multiple'&&(q.correct.length!==1||q.partialPoints!==undefined)||q.type==='multiple'&&q.correct.length<2)ctx.addIssue({code:z.ZodIssueCode.custom,message:'单选/判断仅一个正确答案；多选至少两个，漏选分仅适用于多选'});
 if(q.type==='trueFalse'&&(q.options.length!==2||q.options[0]!=='正确'||q.options[1]!=='错误'))ctx.addIssue({code:z.ZodIssueCode.custom,message:'判断题固定使用正确/错误两个选项'});
 if(q.partialPoints!==undefined&&q.partialPoints>=q.points)ctx.addIssue({code:z.ZodIssueCode.custom,message:'漏选分须小于本题分值'});
});
export function objectiveQuestions(exam:R):ObjectiveQuestion[]{return exam.payload.objectiveQuestions??(exam.payload.questions??[]).map(q=>({type:'single',prompt:q.prompt,options:q.options,correct:q.correct===undefined?undefined:[q.correct],points:1}));}
export function scoreObjectiveExam(exam:R,answers:(number|number[])[]){
 const questions=objectiveQuestions(exam);const fail=():never=>{throw new HttpError(400,'请完整作答，选项不得重复且须符合题型');};
 if(!questions.length||answers.length!==questions.length)fail();
 const normalized=answers.map(a=>Array.isArray(a)?a:[a]);
 let earnedPoints=0,maxPoints=0;
 questions.forEach((q,i)=>{
  const a=normalized[i];if(!a.length||new Set(a).size!==a.length||a.some(n=>!Number.isInteger(n)||n<0||n>=q.options.length)||q.type!=='multiple'&&a.length!==1)fail();
  if(!q.correct?.length)throw new HttpError(400,'试卷版本缺少评分依据');
  maxPoints+=q.points;
  const subset=a.every(n=>q.correct!.includes(n));
  earnedPoints+=subset&&a.length===q.correct.length?q.points:subset&&q.type==='multiple'?q.partialPoints??0:0;
 });
 return {answers:normalized,earnedPoints,maxPoints,score:Math.round(100*earnedPoints/maxPoints)};
}
