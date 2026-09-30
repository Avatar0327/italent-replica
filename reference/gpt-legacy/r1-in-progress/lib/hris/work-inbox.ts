import {payrollAttendanceIssues} from './payroll-attendance';
import {canEvaluateAppointment} from './interview-schedule';
import {attendanceShiftFrozen} from './attendance-locks';
import {requisitionAwaitingApproval,recruitmentTargetCurrent} from './recruitment-status';
import {canReviewHomework} from './learning-homework';
import {learningStageOpen} from './learning-requirements';
import {learningTaskCurrent} from './learning-plan-model';
import {performancePlanLive} from './performance-availability';
import {payrollBatchIndependent} from './payroll-review';
import {certificateSourceValid} from './certificates';
import {businessDate} from './workforce';
import {payrollWriter,payrollReviewer,payrollRecordAccess} from './payroll-access';
import {authorizeCommand,type Member} from './authorization';
import type {State} from './model';
import {visibleRecord,type DevelopmentRecord as R} from './development';
export const inboxKinds=['attendancePeriod','interviewAppointment','homeworkSubmission','homeworkTask','learningExamTask','learningExamAttempt','learningAssignment','performanceCheckin','performanceGoalChange','certificateTemplate','certificateAward','mentorProfile','mentorship','mentoringLog','instructorCampaign','instructorApplication','instructorTrial','instructorProfile','trainingRequest','cadreNomination','cadreObservation','employeeFieldDefinition','employeeFieldValue','review','reviewCalibration','payBatch','paySlip','payAdjustment','payQuery','performancePlan','performanceCycle','performance','performanceAppeal','requisition','candidate','interview','leave','correction','shift','plan','enrollment','instructorCertification','onboardingPlan','trainingAttendance','trainingSession','training','course'] as const;
export type InboxItem={id:string;recordId:string;domain:string;title:string;employeeName:string;action:string;href:string;updatedAt:string;due:string|null};
export function workInbox(state:State,records:R[],m:Member):InboxItem[]{
 const rows:InboxItem[]=[],hr=['admin','hr'].includes(m.role),manager=hr||m.role==='manager';
 const employee=(id:string|null)=>state.employees.find(e=>e.id===id);
 for(const a of state.approvals.filter(a=>a.status==='pending')){
  try{authorizeCommand(state,{action:'decide',id:a.id,decision:'rejected'},m);}catch{continue;}
  rows.push({id:'personnel:'+a.id,recordId:a.id,domain:'personnel',title:({transfer:'调动申请',regularize:'转正申请',exit:'离职申请'})[a.kind],employeeName:employee(a.employeeId)?.name??'—',action:'人事审批',href:'/approvals',updatedAt:a.steps?.[Math.max(0,(a.currentStep??0)-1)]?.at??a.created,due:null});
 }
 for(const r of records){
  if(!visibleRecord(r,records,state,m))continue;
  const self=r.employeeId===m.employeeId,e=employee(r.employeeId);
  const add=(domain:string,action:string,href:string,suffix='',title=r.payload.title??action)=>rows.push({id:r.kind+':'+r.id+suffix,recordId:r.id,domain,title,employeeName:e?.name??'—',action,href,updatedAt:r.updatedAt,due:r.payload.due??null});
  if(r.kind==='interviewAppointment'&&canEvaluateAppointment(r,records,state,m))add('recruitment','指定面试评价','/recruitment-evaluations?'+new URLSearchParams({appointmentId:r.id}),'',r.payload.interviewSchedule?.title??'指定面试');
  if(r.kind==='homeworkTask'&&canReviewHomework(r,state,m,records))add('learning','独立作业批阅','/learning-homework');
  if(r.kind==='performanceCheckin'&&e?.status!=='离职'){
   const p=records.find(p=>p.id===r.referenceId&&p.kind==='performancePlan'),live=performancePlanLive(state,records,p)&&p?.status==='confirmed'&&records.some(c=>c.id===p.referenceId&&c.kind==='performanceCycle'&&c.status==='active')&&!records.some(c=>c.kind==='performance'&&c.payload.sourcePlanId===p.id);
   if(live&&r.status==='submitted'&&manager&&!self&&r.createdBy!==m.userId)add('performance','目标执行反馈','/performance-checkins');
   if(live&&r.status==='returned'&&self&&r.createdBy===m.userId&&(p.payload.version??1)===r.payload.basePlanVersion&&!records.some(c=>c.kind==='performanceGoalChange'&&c.referenceId===p.id&&c.status==='submitted'))add('performance','补充目标跟进','/performance-checkins');
  }
  if(r.kind==='requisition'&&r.status==='returned'&&hr)add('recruitment','招聘需求修订','/recruitment');
  if(r.kind==='candidate'&&r.status==='screening'&&r.payload.offerReturnReason&&hr&&records.some(q=>q.kind==='requisition'&&q.id===r.referenceId&&q.status==='active'))add('recruitment','录用退回补充','/recruitment','',r.payload.name??'候选人');
  if(r.kind==='performanceGoalChange'&&r.status==='submitted'&&manager&&!self&&r.createdBy!==m.userId)add('performance','绩效目标调整复核','/performance-changes','',`${r.payload.period} 目标调整`);
  if(r.kind==='certificateAward'&&hr&&!self&&r.createdBy!==m.userId){if(r.status==='submitted')add('learning','内部证书发放复核','/certificates');if(r.status==='issued'&&!certificateSourceValid(records.find(s=>s.id===r.payload.sourceRecordId)))add('learning','证书依据状态复核','/certificates');}
  if(r.kind==='mentoringLog'&&records.some(p=>p.kind==='mentorship'&&p.id===r.referenceId&&p.status==='active')){if(self&&r.status==='submitted'&&e?.status!=='离职')add('learning','本人确认辅导','/mentoring');if(m.employeeId===r.payload.mentorEmployeeId&&r.status==='returned'&&e?.status!=='离职'&&state.employees.some(e=>e.id===m.employeeId&&e.status!=='离职')&&records.some(p=>p.id===r.referenceId&&p.payload.start!<=businessDate(new Date().toISOString())&&p.payload.end!>=businessDate(new Date().toISOString())))add('learning','补充辅导记录','/mentoring');}
  if(r.kind==='mentorship'&&r.status==='submitted'&&hr&&!self&&m.employeeId!==r.payload.mentorEmployeeId&&r.createdBy!==m.userId)add('learning','独立核对出师','/mentoring');
  if(r.kind==='instructorApplication'&&hr&&!self&&r.createdBy!==m.userId&&!records.some(p=>p.kind==='instructorProfile'&&p.payload.instructorApplicationId===r.id)){if(r.status==='submitted')add('learning','认证报名资格复核','/instructor-campaigns');if(r.status==='approved'&&e?.status!=='离职')add('learning','认证报名提名核对','/instructor-campaigns');}
  if(r.kind==='trainingRequest'&&!self&&r.createdBy!==m.userId){if(r.status==='submitted'&&manager)add('learning','培训申请审批','/training-requests');if(r.status==='approved'&&hr&&e&&e.status!=='离职')add('learning','培训安排核对','/training-requests');}
  if(r.kind==='cadreNomination'&&r.status==='submitted'&&!self&&['admin','manager'].includes(m.role)&&r.createdBy!==m.userId)add('cadres',e?.status==='离职'||!state.positions?.some(p=>p.id===r.positionId&&p.status==='启用')?'失效提名处理（拒绝或撤回）':'干部提名审议','/cadres','',r.payload.targetPositionName??'干部提名');
  if(r.kind==='cadreObservation'&&r.status==='submitted'&&!self&&manager&&r.createdBy!==m.userId)add('cadres','考察述职核验','/cadres','',r.payload.targetPositionName??'任职考察');
  if(r.kind==='employeeFieldValue'&&r.status==='pending'&&hr&&!self&&r.payload.submittedBy!==m.userId)add('personnel',e?.status==='离职'?'离职字段申请退回':'档案字段变更复核','/employee-fields?'+new URLSearchParams({employeeId:r.employeeId!,recordId:r.id}),'',r.payload.name??'档案字段变更');
  if(r.kind==='reviewCalibration'&&!self&&manager&&!records.some(x=>x.kind==='review'&&x.payload.supersedes===r.referenceId)){
   if(r.status==='submitted'&&r.createdBy!==m.userId)add('development','盘点校准复核','/development','',`${r.payload.period} 盘点校准`);
   if(r.status==='approved'&&hr&&r.payload.verifiedBy!==m.userId)add('development','盘点校准发布','/development','',`${r.payload.period} 盘点校准`);
  }
  if(r.kind==='payBatch'&&payrollRecordAccess(r,records,state,m)){
   const slips=records.filter(x=>x.kind==='paySlip'&&x.referenceId===r.id&&x.status!=='cancelled'),beneficiary=slips.some(x=>x.employeeId===m.employeeId),stale=slips.some(x=>payrollAttendanceIssues(x,records).length>0);
   const href='/payroll?'+new URLSearchParams({batchId:r.id});
   if(stale&&r.status==='draft'&&payrollWriter(m))add('payroll','工资考勤来源核验',href,'',`${r.payload.period} 工资批次`);
   if(stale&&['submitted','approved'].includes(r.status)&&payrollReviewer(m)&&payrollBatchIndependent(r,records,m))add('payroll','工资来源变化待退回',href,'',`${r.payload.period} 工资批次`);
   if(stale&&r.status==='published'&&payrollWriter(m))add('payroll','已发布工资来源变更核对',href,'',`${r.payload.period} 工资批次`);
   if(!stale&&r.status==='submitted'&&payrollReviewer(m)&&payrollBatchIndependent(r,records,m))add('payroll','工资批次复核',href,'',`${r.payload.period} 工资批次`);
   if(!stale&&r.status==='approved'&&payrollWriter(m)&&!beneficiary)add('payroll','工资批次发布',href,'',`${r.payload.period} 工资批次`);
  }
  if(['payAdjustment','payQuery'].includes(r.kind)&&payrollRecordAccess(r,records,state,m)&&!self){
   const slip=records.find(x=>x.kind==='paySlip'&&x.id===r.referenceId),published=slip?.status!=='cancelled'&&records.some(x=>x.kind==='payBatch'&&x.id===slip?.referenceId&&x.status==='published');
   if(r.kind==='payQuery'&&r.status==='submitted'&&payrollWriter(m)&&r.createdBy!==m.userId)add('payroll','工资异议答复','/payroll-adjustments','',`${r.payload.period} 工资异议`);
   if(r.kind==='payAdjustment'&&published){if(r.status==='submitted'&&payrollReviewer(m)&&r.createdBy!==m.userId)add('payroll','工资补差复核','/payroll-adjustments','',`${r.payload.period} 工资补差`);if(r.status==='approved'&&payrollWriter(m))add('payroll','工资补差发布','/payroll-adjustments','',`${r.payload.period} 工资补差`);}
  }
  if(r.kind==='performancePlan'&&performancePlanLive(state,records,r)&&records.some(x=>x.kind==='performanceCycle'&&x.id===r.referenceId&&x.status==='active')&&!records.some(x=>x.kind==='performance'&&x.payload.sourcePlanId===r.id)){
   const href='/performance?'+new URLSearchParams({recordId:r.id});
   if(r.status==='confirmed'&&self&&!records.some(x=>x.kind==='performanceGoalChange'&&x.referenceId===r.id&&x.status==='submitted'))add('performance','绩效自评',href,'',`${r.payload.period} 绩效自评`);
   if(manager&&!self){
    if(r.status==='draft')add('performance','绩效目标确认',href,'',`${r.payload.period} 绩效目标`);
    if(r.status==='submitted')add('performance','绩效评价',href,'',`${r.payload.period} 绩效评价`);
    if(r.status==='evaluated'&&hr&&!records.some(x=>x.kind==='performance'&&x.employeeId===r.employeeId&&x.payload.period===r.payload.period&&x.payload.sourcePlanId))add('performance','绩效结果发布',href,'',`${r.payload.period} 绩效结果`);
   }
  }
  if(r.kind==='performanceAppeal'&&hr&&!self){const old=records.find(x=>x.kind==='performance'&&x.id===r.referenceId),plan=old?.payload.performanceSnapshot?.plan as {evaluatedBy?:string}|undefined;if(old?.payload.sourcePlanId&&old.status==='published'&&plan&&!records.some(x=>x.kind==='performance'&&x.payload.supersedes===old.id)){
   if(r.status==='submitted'&&r.createdBy!==m.userId&&old.createdBy!==m.userId&&plan.evaluatedBy!==m.userId)add('performance','绩效申诉复核','/performance?'+new URLSearchParams({recordId:r.id}),'',`${r.payload.period} 绩效申诉`);
   if(r.status==='approved'&&r.payload.verifiedBy!==m.userId&&!records.some(x=>x.kind==='performance'&&x.payload.appealId===r.id))add('performance','绩效更正发布','/performance?'+new URLSearchParams({recordId:r.id}),'',`${r.payload.period} 绩效更正`);
  }}
  if(r.kind==='requisition'&&r.status==='draft'&&r.payload.requisitionSubmissionRequired&&hr&&state.positions?.some(p=>p.id===r.positionId&&p.status==='启用'))add('recruitment','招聘需求提交','/recruitment');
  if(requisitionAwaitingApproval(r)&&!r.payload.contributors?.includes(m.userId)&&['admin','manager'].includes(m.role)&&r.createdBy!==m.userId&&state.positions?.some(p=>p.id===r.positionId&&p.status==='启用'))add('recruitment','招聘需求审批','/recruitment');
  if(r.kind==='candidate'&&records.some(x=>x.kind==='requisition'&&x.id===r.referenceId&&x.status==='active')){
   if(r.status==='offered'&&['admin','manager'].includes(m.role)&&(r.payload.offeredBy??r.createdBy)!==m.userId)add('recruitment',recruitmentTargetCurrent(state,r)?'录用审批':'录用目标失效（退回核对）','/recruitment','',r.payload.name??'候选人');
   if(r.status==='approved'&&hr)add('recruitment',recruitmentTargetCurrent(state,r)?'录用接受确认':'录用目标失效（结束或核对）','/recruitment','',r.payload.name??'候选人');
  }
  if(['leave','correction'].includes(r.kind)&&manager&&!self&&r.createdBy!==m.userId&&r.status==='pending'&&records.some(x=>x.id===r.referenceId&&x.kind==='shift'&&x.status==='active'&&!attendanceShiftFrozen(records,x)))add('attendance',r.kind==='leave'?'请假审批':'补卡审批','/attendance');
  if(['plan','enrollment'].includes(r.kind)&&manager&&!self&&r.payload.submittedBy!==m.userId&&r.status==='submitted'&&e&&e.status!=='离职'&&learningTaskCurrent(r,e)&&learningStageOpen(r,records,undefined,state))add('development',r.kind==='plan'?'发展行动核验':'学习成果核验',r.kind==='plan'?'/development':'/learning');
  if(r.kind==='instructorTrial'&&r.status==='active'&&records.some(p=>p.id===r.referenceId&&p.kind==='instructorProfile'&&p.status==='submitted')&&e?.status!=='离职'){const judges=r.payload.participantIds??[],scores=r.payload.trialScores??[];if(r.payload.due!>=businessDate(new Date().toISOString())&&m.employeeId&&judges.includes(m.employeeId)&&state.employees.some(e=>e.id===m.employeeId&&e.status!=='离职')&&!scores.some(s=>s.employeeId===m.employeeId))add('learning','本人试讲评分','/instructor-trials');if(hr&&!self&&r.createdBy!==m.userId&&!(m.employeeId&&judges.includes(m.employeeId))&&judges.every(id=>scores.some(s=>s.employeeId===id)))add('learning','试讲结果冻结','/instructor-trials');}
  if(r.kind==='instructorProfile'&&hr&&!self&&r.createdBy!==m.userId&&r.status==='submitted'&&!records.some(t=>t.kind==='instructorTrial'&&t.referenceId===r.id&&t.status==='active'))add('learning','内部讲师提名复核','/instructor-directory');
  if(r.kind==='instructorCertification'&&hr&&!self&&r.createdBy!==m.userId&&r.status==='submitted')add('learning','讲师认证复核','/instructors');
  if(r.kind==='onboardingPlan'&&r.status==='active'&&!self){
   if(manager)for(const item of r.payload.onboardingItems??[])if(item.status==='submitted'&&item.submittedBy!==m.userId)add('onboarding','融入事项核验','/onboarding',':'+item.id,item.title);
   if(hr&&r.payload.onboardingItems?.length&&r.payload.onboardingItems.every(x=>x.status==='verified'))add('onboarding','融入计划结项','/onboarding',':close');
  }
  if(r.kind==='trainingAttendance'&&r.status==='submitted'&&manager&&!self&&r.payload.submittedBy!==m.userId){const s=records.find(x=>x.id===r.referenceId&&x.kind==='trainingSession');if(s?.status==='active'&&records.some(t=>t.id===s.referenceId&&t.kind==='training'&&t.status==='active')&&records.some(x=>x.kind==='enrollment'&&x.employeeId===r.employeeId&&x.referenceId===s.payload.sessionCourseId&&x.payload.trainingId===s.referenceId&&x.status!=='cancelled'))add('learning','培训出勤核验','/training-sessions','',s.payload.title??'培训出勤');}
 }
 return rows.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id.localeCompare(b.id));
}
