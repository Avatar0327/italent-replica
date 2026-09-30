import {learningGradeRuleSchema} from './learning-grades';
import {resourceRequirements,learningRequirements} from './learning-requirements';
import {z} from 'zod';
import {learningModeSchema} from './learning-plan-model';
import {scopedOrgs,type Member} from './authorization';
import {visibleRecord,type DevelopmentRecord as R} from './development';
import type {State} from './model';
import {HttpError} from './http';
const id=z.string().min(1).max(100),title=z.string().trim().min(1).max(200);
const fields={title,orgId:id,config:learningModeSchema,courseIds:z.array(id).max(20),examIds:z.array(id).max(20).optional(),homeworkIds:z.array(id).max(20).optional()};
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),...fields}).strict(),
 z.object({action:z.literal('edit'),id,...fields}).strict(),
 z.object({action:z.literal('grading'),id,rule:learningGradeRuleSchema}).strict(),
 z.object({action:z.literal('stages'),id,stages:z.array(z.object({title,deadline:z.object({days:z.number().int().min(1).max(36500),allowOverdue:z.boolean(),policy:z.literal('scheduled-inclusive')}).strict().optional(),homeworkSubmissionUnlock:z.boolean().optional(),orderedTasks:z.boolean().optional(),examSubmissionUnlock:z.boolean().optional(),startAfterDays:z.number().int().min(0).max(36500).optional(),courseIds:z.array(id).min(1).max(20),optionalCourseIds:z.array(id).max(20).optional(),requiredMinimum:z.number().int().min(0).max(20).optional(),optionalMinimum:z.number().int().min(0).max(20).optional()}).strict()).min(1).max(10)}).strict(),
 z.object({action:z.literal('seal'),id}).strict(),
 z.object({action:z.literal('revise'),id}).strict(),
 z.object({action:z.literal('archive'),id}).strict(),
]);
export function applyLearningDefinition(records:R[],state:State,member:Member,input:unknown,at=new Date().toISOString()):R{
 const c=schema.parse(input),scope=scopedOrgs(state,member);
 const deny=():never=>{throw new HttpError(403,'没有此学习计划配置的管理权限');};
 const fail=(message:string):never=>{throw new HttpError(400,message);};
 if(!['admin','hr'].includes(member.role))deny();
 const old=c.action==='create'?undefined:records.find(r=>r.kind==='learningDefinition'&&r.id===c.id);
 if(c.action!=='create'&&(!old||!visibleRecord(old,records,state,member)))deny();
 const orgId=c.action==='create'||c.action==='edit'?c.orgId:old!.payload.orgId!;
 if(!scope.has(orgId))deny();
 if(!state.orgs.some(o=>o.id===orgId&&o.status==='启用'))fail('计划组织须为启用状态');
 if(c.action==='archive'){
  if(old!.status==='archived')fail('配置已归档');
  return {...old!,status:'archived',updatedAt:at};
 }
 if(c.action==='revise'){
  if(old!.status!=='sealed')fail('仅已定版配置可创建后续版本');
  const root=old!.payload.definitionRootId!;
  const family=records.filter(r=>r.kind==='learningDefinition'&&r.payload.definitionRootId===root);
  if(family.some(r=>r.status==='draft'))fail('此计划已有草稿版本，请先处理');
  if(family.some(r=>r.status==='sealed'&&(r.payload.version??0)>(old!.payload.version??0)))fail('请从最新版本创建后续版本');
  return {...old!,id:crypto.randomUUID(),status:'draft',referenceId:old!.id,createdBy:member.userId,createdAt:at,updatedAt:at,payload:{...old!.payload,version:Math.max(...family.map(r=>r.payload.version??1))+1}};
 }
 if(old&&old.status!=='draft')fail('已定版或归档配置不能修改，请创建后续版本');
 if(c.action==='grading'){if(c.rule.mode==='contentWeighted'){const requirements=learningRequirements(old!);if(c.rule.items.some(i=>!requirements.some(r=>r.id===i.requirementId&&r.kind===(i.source==='homeworkLatest'?'homework':'exam'))))fail('权重须引用本计划有计分依据的考试或作业要求');}else if(c.rule.mode!=='none'&&(!(old!.payload.examIds?.length)||c.rule.mode==='specifiedExamHighest'&&!old!.payload.examIds.includes(c.rule.examId)))fail('成绩规则须引用本计划的独立考试');return {...old!,updatedAt:at,payload:{...old!.payload,gradeRule:c.rule}};}
 if(c.action==='stages'){
  const ids=c.stages.flatMap(stage=>stage.courseIds),resources=[...old!.payload.courseIds!,...(old!.payload.examIds??[]),...(old!.payload.homeworkIds??[])];
  if(ids.length!==resources.length||new Set(ids).size!==ids.length||ids.some(id=>!resources.includes(id)))fail('阶段须恰好覆盖当前全部课程与独立考试，每项只能属于一个阶段');
  if(new Set(c.stages.map(s=>s.title)).size!==c.stages.length)fail('阶段名称不得重复');
  for(const stage of c.stages){if((stage.examSubmissionUnlock||stage.homeworkSubmissionUnlock)&&!stage.orderedTasks)fail('提交放行仅适用于按任务顺序学习的阶段');const optional=stage.optionalCourseIds??[],required=stage.courseIds.length-optional.length,rm=stage.requiredMinimum??required,om=stage.optionalMinimum??optional.length;if(new Set(optional).size!==optional.length||optional.some(id=>!stage.courseIds.includes(id))||rm>required||om>optional.length||rm+om<1)fail('选必修范围或完成数量门槛无效');}
  return {...old!,updatedAt:at,payload:{...old!.payload,trainingStages:c.stages}};
 }
 const courseIds=c.action==='seal'?old!.payload.courseIds!:c.courseIds,examIds=c.action==='seal'?(old!.payload.examIds??[]):c.examIds??old?.payload.examIds??[],homeworkIds=c.action==='seal'?(old!.payload.homeworkIds??[]):c.homeworkIds??old?.payload.homeworkIds??[];
 if(courseIds.length+examIds.length+homeworkIds.length<1||courseIds.length+examIds.length+homeworkIds.length>20||new Set([...courseIds,...examIds,...homeworkIds]).size!==courseIds.length+examIds.length+homeworkIds.length)fail('学习内容须为1至20项且不得重复');
 for(const homeworkId of homeworkIds){const hw=records.find(r=>r.id===homeworkId&&r.kind==='homeworkDefinition');if(!hw||!visibleRecord(hw,records,state,member))deny();if(hw!.status!=='sealed'||hw!.payload.orgId!==orgId)fail('作业须选同组织已定版版本');}
 for(const examId of examIds){const exam=records.find(r=>r.id===examId&&r.kind==='learningExamDefinition');if(!exam||!visibleRecord(exam,records,state,member))deny();if(exam!.status!=='sealed'||exam!.payload.orgId!==orgId)fail('独立考试须选同组织已定版试卷');}
 if(new Set(courseIds).size!==courseIds.length)fail('课程不得重复');
 for(const courseId of courseIds){const course=records.find(r=>r.id===courseId&&r.kind==='course');if(!course||!visibleRecord(course,records,state,member))deny();if(course!.status!=='published')fail('仅可选用已发布课程版本');}
 if(c.action==='seal')return {...old!,status:'sealed',updatedAt:at,payload:{...old!.payload,learningRequirements:resourceRequirements(courseIds,examIds,old!.payload.learningRequirements,homeworkIds)}};
 if(old&&old.payload.orgId!==c.orgId)fail('版本所属组织不可更换，请独立新建计划');
 if(old?.referenceId){const previous=records.find(r=>r.id===old.referenceId&&r.kind==='learningDefinition');if(!previous||previous.payload.learningMode?.progressSync!==c.config.progressSync)fail('已定版计划的进度同步设置不可更改');}
 const key=old?.id??crypto.randomUUID();
 return {id:key,kind:'learningDefinition',employeeId:null,positionId:null,referenceId:old?.referenceId??null,status:'draft',createdBy:old?.createdBy??member.userId,createdAt:old?.createdAt??at,updatedAt:at,payload:{title:c.title,orgId:c.orgId,learningMode:c.config,courseIds:c.courseIds,examIds,homeworkIds,gradeRule:(old?.payload.gradeRule?.mode!=='contentWeighted'||(old.payload.homeworkIds??[]).length===homeworkIds.length&&homeworkIds.every(id=>old.payload.homeworkIds?.includes(id)))&&(old?.payload.examIds??[]).length===examIds.length&&examIds.every(id=>old?.payload.examIds?.includes(id))?old?.payload.gradeRule:undefined,learningRequirements:resourceRequirements(c.courseIds,examIds,old?.payload.learningRequirements,homeworkIds),trainingStages:old?.payload.trainingStages&&(old.payload.homeworkIds??[]).length===homeworkIds.length&&homeworkIds.every(id=>old.payload.homeworkIds?.includes(id))&&(old.payload.examIds??[]).length===examIds.length&&examIds.every(id=>old.payload.examIds?.includes(id))&&old.payload.courseIds?.length===c.courseIds.length&&c.courseIds.every(id=>old.payload.courseIds!.includes(id))?old.payload.trainingStages:undefined,definitionRootId:old?.payload.definitionRootId??key,version:old?.payload.version??1}};
}
