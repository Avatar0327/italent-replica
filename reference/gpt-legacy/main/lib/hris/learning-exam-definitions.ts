import {objectiveQuestionSchema} from './learning-objective-exams';
import {z} from 'zod';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),text=z.string().trim().min(1).max(200);
const question=z.object({prompt:z.string().trim().min(5).max(4000),options:z.array(text).min(2).max(6),correct:z.number().int().min(0).max(5)}).strict().refine(q=>q.correct<q.options.length&&new Set(q.options).size===q.options.length,'答案索引或选项重复');
const fields={title:text,orgId:id,questions:z.array(question).min(1).max(20).optional(),objectiveQuestions:z.array(objectiveQuestionSchema).min(1).max(20).optional(),passingScore:z.number().int().min(1).max(100),maxAttempts:z.number().int().min(1).max(10)};
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),...fields}).strict(),
 z.object({action:z.literal('edit'),id,...fields}).strict(),
 z.object({action:z.literal('seal'),id}).strict(),
 z.object({action:z.literal('revise'),id}).strict(),
 z.object({action:z.literal('archive'),id}).strict(),
]);
// Immutable objective exams; legacy single-choice versions retain their grading.
export function applyLearningExamDefinition(records:R[],state:State,m:Member,input:unknown,at=new Date().toISOString()):R{
 const c=schema.parse(input),scope=scopedOrgs(state,m);
 const deny=():never=>{throw new HttpError(403,'没有此独立试卷的管理权限');};
 const fail=(message:string):never=>{throw new HttpError(400,message);};
 if(!['admin','hr'].includes(m.role))deny();
 const old=c.action==='create'?undefined:records.find(r=>r.kind==='learningExamDefinition'&&r.id===c.id);
 if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,m)))deny();
 const orgId=c.action==='create'||c.action==='edit'?c.orgId:old!.payload.orgId!;
 if(!scope.has(orgId))deny();
 if(!state.orgs.some(o=>o.id===orgId&&o.status==='启用'))fail('试卷所属组织须启用');
 if(c.action==='archive'){if(old!.status==='archived')fail('试卷已归档');return {...old!,status:'archived',updatedAt:at};}
 if(c.action==='revise'){
  if(old!.status!=='sealed')fail('请从最新定版创建后续版本');
  const family=records.filter(r=>r.kind==='learningExamDefinition'&&r.payload.definitionRootId===old!.payload.definitionRootId);
  if(family.some(r=>r.status==='draft'||(r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0))))fail('已有草稿或较新版本');
  return {...old!,id:crypto.randomUUID(),status:'draft',referenceId:old!.id,createdBy:m.userId,createdAt:at,updatedAt:at,payload:structuredClone({...old!.payload,version:Math.max(...family.map(r=>r.payload.version??1))+1})};
 }
 if(old&&old.status!=='draft')fail('定版试卷不可修改，请创建后续版本');
 if(c.action==='seal')return {...old!,status:'sealed',updatedAt:at};
 if((!!c.questions)===(!!c.objectiveQuestions))fail('须明确提供一种试卷题目结构');
 if(old?.payload.objectiveQuestions&&c.questions)fail('此试卷含多题型，请使用新版编辑器，不能退回旧单选结构');
 if(old&&old.payload.orgId!==orgId)fail('后续版本不能更换所属组织');
 const key=old?.id??crypto.randomUUID();
 return {id:key,kind:'learningExamDefinition',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??m.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{title:c.title,orgId,questions:c.questions,objectiveQuestions:c.objectiveQuestions,passingScore:c.passingScore,maxAttempts:c.maxAttempts,version:old?.payload.version??1,definitionRootId:old?.payload.definitionRootId??key}};
}
