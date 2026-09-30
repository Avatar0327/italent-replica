import {requisitionStatusLabel,recruitmentTypes,recruitmentUrgencies} from './recruitment-status';
import {learningGrade} from './learning-grades';
import {learningRequirementProgress} from './learning-requirements';
import {trainingStageCompleted} from './training-stages';
import {performancePlanLive} from './performance-availability';
import type {Member} from './authorization';
import {payrollReport} from './payroll-reports';
import {latestInstructorTrial} from './instructor-trials';
import {instructorDevelopmentProof} from './instructor-development';
import {businessDate} from './workforce';
import {HttpError} from './http';
import {latestPublishedReviews} from './review-versions';
import {z} from 'zod';
import {visibleState} from './authorization';
import {visibleDevelopment,type DevelopmentContext} from './development-repository';
import {attendanceReport} from './attendance';
const validDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;},'日期无效');
export const reportQuery=z.object({dataset:z.enum(['payrollAttendanceReferences','homework','learningPlanProgress','learningExams','contractCoverage','contractOperations','trainingStageProgress','payrollOperations','payrollReconciliation','recruitmentOperations','performanceOperations','instructorCampaignProgress','workforce','attendance','learning','performance','talentReview','successionCoverage','instructorSchedule','trainingProgress','trainingRoster']).default('workforce'),from:validDate.optional(),to:validDate.optional(),search:z.string().max(100).default('')}).refine(q=>!q.from||!q.to||q.from<=q.to,'开始日期不能晚于结束日期');
export const reportKinds={payrollAttendanceReferences:['payBatch','paySlip','attendancePeriod'],homework:['homeworkTask'],learningPlanProgress:['homeworkTask','homeworkSubmission','learningAssignment','enrollment','learningExamTask','learningExamAttempt'],learningExams:['learningExamTask','learningExamAttempt'],contractCoverage:['employmentContract'],contractOperations:['employmentContract'],trainingStageProgress:['training','enrollment','course'],payrollOperations:['payBatch','paySlip','payAdjustment'],payrollReconciliation:['payBatch','paySlip','payAdjustment'],recruitmentOperations:['requisition','candidate'],performanceOperations:['performancePlan','performanceCycle','performance','performanceGoalChange','performanceCheckin'],instructorCampaignProgress:['instructorCampaign','instructorApplication','instructorProfile','instructorTrial','instructorDevelopment','enrollment'],trainingRoster:['training','trainingSession','trainingAttendance','enrollment'],instructorSchedule:['training','trainingSession','enrollment'],trainingProgress:['training','enrollment'],successionCoverage:['succession'],talentReview:['review'],workforce:[],attendance:['shift','clock','correction','leaveType','leaveCredit','leave'],learning:['enrollment'],performance:['performance','performancePlan','performanceCycle']} as const;
export const reportRoles:Partial<Record<z.infer<typeof reportQuery>['dataset'],readonly Member['role'][]>>={
 payrollAttendanceReferences:['admin','payroll_editor','payroll_reviewer'],homework:['admin','hr'],learningPlanProgress:['admin','hr'],learningExams:['admin','hr'],contractCoverage:['admin','hr'],payrollOperations:['admin','payroll_editor','payroll_reviewer'],payrollReconciliation:['admin','payroll_editor','payroll_reviewer'],contractOperations:['admin','hr'],instructorCampaignProgress:['admin','hr'],
 trainingStageProgress:['admin','hr','manager'],trainingRoster:['admin','hr','manager'],instructorSchedule:['admin','hr','manager'],trainingProgress:['admin','hr','manager'],successionCoverage:['admin','hr','manager'],performanceOperations:['admin','hr','manager'],recruitmentOperations:['admin','hr','manager'],
};
export type Cell=string|number|null;
export function makeReport(ctx:DevelopmentContext,input:unknown){
 const q=reportQuery.parse(input);
 const finish=(report:{title:string;columns:string[];rows:Cell[][]})=>({...report,rows:q.search?report.rows.filter(r=>r.some(c=>String(c??'').toLocaleLowerCase().includes(q.search.toLocaleLowerCase()))):report.rows,dataset:q.dataset,asOf:new Date().toISOString(),revision:ctx.row.revision});
 if(q.dataset==='payrollAttendanceReferences'||q.dataset==='payrollOperations'||q.dataset==='payrollReconciliation')return finish(payrollReport(ctx,q.dataset));
 const state=visibleState(ctx.state,ctx.member),records=visibleDevelopment(ctx),employee=(id:string|null)=>state.employees.find(e=>e.id===id),name=(id:string|null)=>employee(id)?.name??'',code=(id:string|null)=>employee(id)?.code??'',org=(id:string)=>state.orgs.find(o=>o.id===id)?.name??'';
 let columns:string[]=[],rows:Cell[][]=[],title='';
 if(q.dataset==='learningPlanProgress'){
  if(!['admin','hr'].includes(ctx.member.role))throw new HttpError(403,'学习计划台账仅限有范围权限的HR');
  title='学习计划要求与成绩';columns=['工号','姓名','计划','配置版本','实例状态','已完成要求','要求总数','已达标阶段','阶段总数','成绩状态','计划成绩','缺少有效成绩的内容数','成绩依据记录ID'];
  rows=records.filter(r=>r.kind==='learningAssignment').map(r=>{const progress=learningRequirementProgress(r,records),grade=learningGrade(r,records);return [code(r.employeeId),name(r.employeeId),r.payload.title??'',r.payload.version??1,({active:'进行中',completed:'已结项',cancelled:'已取消'} as Record<string,string>)[r.status]??r.status,progress.completed,progress.total,progress.stages.filter(s=>s.complete).length,progress.stages.length,({not_configured:'未配置',pending:'待定',provisional:'暂计',final:'已结项'})[grade.state],grade.score,grade.missingRequirementIds.length,grade.evidenceIds.join('; ')];});
 }
 if(q.dataset==='homework'){
  if(!['admin','hr'].includes(ctx.member.role))throw new HttpError(403,'独立作业台账仅限有范围权限的HR');
  title='独立作业台账';columns=['工号','姓名','作业','版本','状态','开放日期','提交截止日','提交次数','当前提交ID','批阅人','当前评分','批阅结论','退出要求时间','退出依据'];
  rows=records.filter(r=>r.kind==='homeworkTask').map(r=>[code(r.employeeId),name(r.employeeId),r.payload.title??'',r.payload.version??1,({active:'待提交',submitted:'待批阅',returned:'退回补充',completed:'已通过',cancelled:'已取消'} as Record<string,string>)[r.status]??r.status,r.payload.start??'',r.payload.due??'',r.payload.submissionVersion??0,r.payload.submissionId??'',r.payload.reviewerName??'未留姓名快照',r.payload.score??null,r.payload.verification??'',r.payload.requirementRetiredAt??'',r.payload.requirementRetiredReason??'']);
 }
 if(q.dataset==='learningExams'){
  if(!['admin','hr'].includes(ctx.member.role))throw new HttpError(403,'独立考试台账仅限有范围权限的HR');
  title='独立考试任务台账';columns=['工号','姓名','试卷','试卷版本','学习实例','开放日期','截止日期','状态','作答次数','最后得分（百分制取整）','是否通过','原始得分','原始总分','退出要求时间','退出依据'];
  rows=records.filter(r=>r.kind==='learningExamTask').map(r=>[code(r.employeeId),name(r.employeeId),r.payload.title??'',r.payload.version??1,r.payload.learningAssignmentId??'独立派发',r.payload.start??'',r.payload.due??'',({active:'进行中',completed:'已通过',failed:'次数用尽未通过',cancelled:'已取消'} as Record<string,string>)[r.status]??r.status,records.filter(a=>a.kind==='learningExamAttempt'&&a.referenceId===r.id).length,r.payload.score??null,r.payload.passed===undefined?'未作答':r.payload.passed?'通过':'未通过',r.payload.earnedPoints??null,r.payload.maxPoints??null,r.payload.requirementRetiredAt??'',r.payload.requirementRetiredReason??'']);
 }
 if(q.dataset==='contractCoverage'){
  if(!['admin','hr'].includes(ctx.member.role))throw new HttpError(403,'仅有权限HR可查看合同登记覆盖核对');
  const today=businessDate();title='在职人员合同登记覆盖核对';columns=['核对日期（北京时间）','工号','姓名','当前组织','人员状态','入职日期','登记覆盖情况','覆盖当日的签署记录数','覆盖当日的合同编号','未来开始的签署记录数','已过结束日的签署记录数','终止记录数','待登记签署草稿数'];
  const byEmployee=new Map<string,typeof records>();
  for(const r of records)if(r.kind==='employmentContract'&&r.employeeId&&r.status!=='cancelled'){const list=byEmployee.get(r.employeeId)??[];list.push(r);byEmployee.set(r.employeeId,list);}
  rows=state.employees.filter(e=>e.status!=='离职').map(e=>{
   const mine=byEmployee.get(e.id)??[],signed=mine.filter(r=>r.status==='signed'),cover=signed.filter(r=>!!r.payload.start&&r.payload.start<=today&&(!r.payload.end||r.payload.end>=today));
   return [today,e.code,e.name,org(e.orgId),e.status,e.joined,cover.length?'存在覆盖当日的签署登记':'未找到覆盖当日的签署登记',cover.length,cover.map(r=>r.payload.contractNumber??'').join('；'),signed.filter(r=>!!r.payload.start&&r.payload.start>today).length,signed.filter(r=>!!r.payload.end&&r.payload.end<today).length,mine.filter(r=>r.status==='ended').length,mine.filter(r=>r.status==='draft').length];
  });
 }
 if(q.dataset==='contractOperations'){
  if(!['admin','hr'].includes(ctx.member.role))throw new HttpError(403,'仅有权限HR可查看合同管理报表');
  title='可见范围合同登记与续签';columns=['合同编号','工号','姓名','当前组织','人员状态','用工主体','期限类型','登记状态','开始日期','原登记结束日','已登记终止日','签署登记日期','距登记结束日（日历天）','后续续签记录','后续续签登记状态','协议类别'];
  const today=businessDate(),statuses:Record<string,string>={draft:'草稿待登记签署',signed:'已登记签署',ended:'已登记终止',cancelled:'草稿已作废'},types:Record<string,string>={fixed:'固定期限',open:'无固定期限',project:'项目期限'},contracts=records.filter(r=>r.kind==='employmentContract'),renewals=new Map<string,typeof contracts>();
  for(const r of contracts)if(r.referenceId&&r.status!=='cancelled'){const list=renewals.get(r.referenceId)??[];list.push(r);renewals.set(r.referenceId,list);}
  rows=contracts.filter(r=>{const end=r.payload.endedOn??r.payload.end;return (!q.from||!!end&&end>=q.from)&&(!q.to||!!end&&end<=q.to);}).map(r=>{const end=r.payload.end,next=(renewals.get(r.id)??[]).filter(x=>x.employeeId===r.employeeId);return [r.payload.contractNumber??'',code(r.employeeId),name(r.employeeId),org(employee(r.employeeId)?.orgId??''),employee(r.employeeId)?.status??'',r.payload.employerName??'',types[r.payload.contractType??'']??'',statuses[r.status]??r.status,r.payload.start??'',end??null,r.payload.endedOn??null,r.payload.signedOn??null,r.status==='signed'&&end?Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000):null,next.map(x=>x.payload.contractNumber??'').join('；'),next.map(x=>statuses[x.status]??x.status).join('；'),({labor:'劳动合同',service:'劳务合同',internship:'实习协议'} as Record<string,string>)[r.payload.agreementCategory??'']??'待登记'];});
 }
 if(q.dataset==='trainingStageProgress'){
  if(!['admin','hr','manager'].includes(ctx.member.role))throw new HttpError(403,'仅有组织管理权限的人员可查看阶段计划进度');
  title='可见范围课程阶段进度';columns=['培训项目','项目状态','工号','姓名','人员状态','阶段总数','课程总数','已核验课程数','最早未完成阶段','该阶段已派发未完成','该阶段无有效项目任务','已完成全部阶段'];
  const status:Record<string,string>={draft:'草稿',active:'进行中',closed:'已结束'};
  for(const training of records.filter(r=>r.kind==='training'&&r.payload.trainingStages?.length)){
   const assignments=records.filter(r=>r.kind==='enrollment'&&r.payload.trainingId===training.id&&r.status!=='cancelled');
   for(const employeeId of new Set(assignments.map(r=>r.employeeId))){
    const mine=assignments.filter(r=>r.employeeId===employeeId),completed=new Set(mine.filter(r=>r.status==='completed').map(r=>r.referenceId)),stages=training.payload.trainingStages!,required=stages.flatMap(s=>s.courseIds),current=stages.find(s=>!trainingStageCompleted(training,s,records,employeeId!)),pending=current?.courseIds.filter(id=>!completed.has(id))??[];
    rows.push([training.payload.name??'',status[training.status]??training.status,code(employeeId),name(employeeId),employee(employeeId)?.status??'',stages.length,required.length,required.filter(id=>completed.has(id)).length,current?.title??null,pending.filter(id=>mine.some(r=>r.referenceId===id)).length,pending.filter(id=>!mine.some(r=>r.referenceId===id)).length,current?'否':'是']);
   }
  }
 }
 if(q.dataset==='workforce'){title='员工名册';columns=['工号','姓名','组织','岗位','人员状态','入职日期'];const email=ctx.member.role==='admin'||ctx.member.viewEmail,level=ctx.member.role==='admin'||ctx.member.viewLevel;if(email)columns.push('邮箱');if(level)columns.push('职级');rows=state.employees.map(e=>{const row:Cell[]=[e.code,e.name,org(e.orgId),e.job,e.status,e.joined];if(email)row.push(e.email);if(level)row.push(e.level);return row;});}
 if(q.dataset==='attendance'){title='出勤核验';columns=['工号','姓名','日期','班次','计划分钟','批准请假分钟','未覆盖分钟','状态'];rows=attendanceReport(records).filter(r=>(!q.from||(r.date??'')>=q.from)&&(!q.to||(r.date??'')<=q.to)).map(r=>[code(r.employeeId),name(r.employeeId),r.date??'',r.name??'',r.plannedMinutes,r.approvedLeaveMinutes,r.uncoveredMinutes,r.status]);}
 if(q.dataset==='learning'){title='学习任务';columns=['工号','姓名','课程','截止日期','状态','成果核验时间','计划实例','轮次','完成方式','来源学习任务','原核验时间','退出要求时间','退出依据'];const status:Record<string,string>={active:'进行中',submitted:'待核验',returned:'已退回',completed:'已完成',cancelled:'已取消'};rows=records.filter(r=>r.kind==='enrollment').map(r=>[code(r.employeeId),name(r.employeeId),r.payload.title??'',r.payload.due??'',status[r.status]??r.status,r.payload.verifiedAt??'',r.payload.learningAssignmentId??'',r.payload.round??'',r.payload.sourceEnrollmentId?'历史复用':r.status==='completed'?'本次核验':'未完成',r.payload.sourceEnrollmentId??'',r.payload.sourceVerifiedAt??'',r.payload.requirementRetiredAt??'',r.payload.requirementRetiredReason??'']);}
 if(q.dataset==='performance'){title='正式绩效结果';columns=['工号','姓名','期间','正式评级','分数','来源'];rows=records.filter(r=>r.kind==='performance'&&r.status==='published'&&r.payload.sourcePlanId&&!records.some(x=>x.payload.supersedes===r.id)).map(r=>[code(r.employeeId),name(r.employeeId),r.payload.period??'',r.payload.originalRating??'',r.payload.score??null,r.payload.source??'']);}
 if(q.dataset==='recruitmentOperations'){
  if(!['admin','hr','manager'].includes(ctx.member.role))throw new HttpError(403,'仅有组织管理权限的人员可查看招聘需求进度');
  title='可见范围招聘需求进度';columns=['招聘需求','岗位','所属组织','需求状态','需求版本','需求人数','累计已入职','剩余可入职','待审录用','已批准待登记接受','已接受待入职','筛选面试中','已结束候选流程','需求类型','紧急程度','需求提出日期','期望到岗日期','工作职责','任职资格'];
  rows=records.filter(r=>r.kind==='requisition').map(q=>{const p=state.positions?.find(p=>p.id===q.positionId),candidates=records.filter(r=>r.kind==='candidate'&&r.referenceId===q.id),count=(status:string)=>candidates.filter(r=>r.status===status).length,hired=count('hired');return [q.payload.title??'',p?.name??'',org(p?.orgId??''),requisitionStatusLabel(q),q.payload.version??1,q.payload.headcount??null,hired,q.status==='active'?Math.max(0,(q.payload.headcount??0)-hired):null,count('offered'),count('approved'),count('accepted'),count('screening')+count('interviewed'),count('rejected'),recruitmentTypes[q.payload.recruitmentDetails?.type??'']??'',recruitmentUrgencies[q.payload.recruitmentDetails?.urgency??'']??'',q.payload.recruitmentDetails?.requestedOn??'',q.payload.recruitmentDetails?.expectedOn??'',q.payload.recruitmentDetails?.duties??'',q.payload.recruitmentDetails?.qualifications??''];});
 }
 if(q.dataset==='performanceOperations'){
  if(!['admin','hr','manager'].includes(ctx.member.role))throw new HttpError(403,'仅有组织管理权限的人员可查看绩效办理报表');
  title='可见范围绩效办理';columns=['工号','姓名','当前组织','期间','计划阶段','目标版本','待审目标调整','待反馈记录（所有版本）','其中本账号可反馈','其中旧目标版本记录','已反馈记录','最近提交跟进（北京时间）','活动年度','周期分类','绩效类别','业务日期'];
  const statuses:Record<string,string>={draft:'待目标确认',confirmed:'待本人自评',submitted:'待管理者评价',evaluated:'待结果发布',cancelled:'已取消'};
  rows=records.filter(r=>r.kind==='performancePlan').map(p=>{
   const published=records.some(r=>r.kind==='performance'&&r.status==='published'&&r.payload.sourcePlanId===p.id),logs=records.filter(r=>r.kind==='performanceCheckin'&&r.referenceId===p.id),pending=logs.filter(r=>r.status==='submitted'),live=performancePlanLive(ctx.state,records,p)&&p.status==='confirmed'&&!!employee(p.employeeId)&&employee(p.employeeId)?.status!=='离职'&&records.some(c=>c.kind==='performanceCycle'&&c.id===p.referenceId&&c.status==='active')&&!published,last=logs.map(r=>r.payload.submittedAt??r.createdAt).sort().at(-1),meta=records.find(c=>c.kind==='performanceCycle'&&c.id===p.referenceId)?.payload.performanceMetadata;
   return [code(p.employeeId),name(p.employeeId),org(employee(p.employeeId)?.orgId??''),p.payload.period??'',published?'结果已发布':statuses[p.status]??p.status,p.payload.version??1,records.filter(r=>r.kind==='performanceGoalChange'&&r.referenceId===p.id&&r.status==='submitted').length,pending.length,live&&p.employeeId!==ctx.member.employeeId?pending.filter(r=>r.createdBy!==ctx.member.userId).length:0,pending.filter(r=>r.payload.basePlanVersion!==(p.payload.version??1)).length,logs.filter(r=>r.status==='acknowledged').length,last?new Date(last).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}):null,meta?.year??null,meta?.cycleLabel??'',meta?.category??'',meta?.businessDate??''];
  });
 }
 if(q.dataset==='talentReview'){title='最新人才盘点';columns=['工号','姓名','期间','潜力档位','绩效快照档位','盘点版本','原版本编号'];rows=latestPublishedReviews(records).map(r=>[code(r.employeeId),name(r.employeeId),r.payload.period??'',r.payload.potential??null,typeof r.payload.performanceSnapshot?.band==='number'?r.payload.performanceSnapshot.band:null,r.payload.version??1,r.payload.supersedes??'']);}
 if(q.dataset==='successionCoverage'){
  if(!['admin','hr','manager'].includes(ctx.member.role))throw new HttpError(403,'仅有组织管理权限的人员可查看继任覆盖');
  title='可见范围继任覆盖';columns=['岗位编码','目标岗位','所属组织','现任人数','有效后备人数','现在可就任','预计一年','预计两年'];
  rows=(state.positions??[]).filter(p=>p.status==='启用').map(p=>{
   const candidates=new Map(records.filter(r=>r.kind==='succession'&&r.positionId===p.id&&r.status==='active'&&employee(r.employeeId)?.status!=='离职'&&!!employee(r.employeeId)).map(r=>[r.employeeId,r]));
   const ready=Array.from(candidates.values());return [p.code,p.name,org(p.orgId),state.employees.filter(e=>e.status!=='离职'&&e.positionId===p.id).length,ready.length,...['ready','one_year','two_years'].map(v=>ready.filter(r=>r.payload.readiness===v).length)];
  });
 }
 if(q.dataset==='instructorCampaignProgress'){
  if(!['admin','hr'].includes(ctx.member.role))throw new HttpError(403,'仅有权限HR可查看认证活动进度');
  title='可见范围认证活动进度';columns=['认证活动','活动组织','报名状态','报名记录数','待资格复核','资格通过','资格未通过','已撤回','已关联提名','在职在用讲师','最新试讲通过的提名','待完成必修培养关联'];
  const states:Record<string,string>={draft:'草稿',published:'已发布',closed:'已停止报名',cancelled:'已取消'};
  rows=records.filter(r=>r.kind==='instructorCampaign').map(c=>{const applications=records.filter(a=>a.kind==='instructorApplication'&&a.referenceId===c.id),profiles=records.filter(p=>p.kind==='instructorProfile'&&applications.some(a=>a.id===p.payload.instructorApplicationId));return [c.payload.title??'',org(c.payload.orgId!),states[c.status]??c.status,applications.length,...['submitted','approved','rejected','withdrawn'].map(s=>applications.filter(a=>a.status===s).length),profiles.length,profiles.filter(p=>p.status==='active'&&employee(p.employeeId)?.status!=='离职'&&!!employee(p.employeeId)).length,profiles.filter(p=>{const t=latestInstructorTrial(records,p.id);return t?.status==='published'&&t.payload.passed;}).length,profiles.filter(p=>p.status==='submitted').flatMap(p=>instructorDevelopmentProof(records,p.id)).filter(p=>p.mandatory&&p.status!=='completed').length];});
 }
 if(q.dataset==='instructorSchedule'||q.dataset==='trainingProgress'||q.dataset==='trainingRoster'){
  if(!['admin','hr','manager'].includes(ctx.member.role))throw new HttpError(403,'仅有组织管理权限的人员可查看培训管理报表');
  const trainings=records.filter(r=>r.kind==='training');
  const statuses:Record<string,string>={draft:'未发布',active:'进行中',closed:'已结束',cancelled:'已取消'};
  if(q.dataset==='instructorSchedule'){
   title='可见范围授课安排';columns=['培训项目','场次','讲师（排期快照）','身份关联','开始时间（北京时间）','结束时间（北京时间）','原排期分钟','有效计划分钟','场次状态'];
   const stamp=(s:string)=>new Date(s).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false});
   rows=records.filter(r=>r.kind==='trainingSession'&&(!q.from||businessDate(r.payload.startAt!)>=q.from)&&(!q.to||businessDate(r.payload.startAt!)<=q.to)).map(r=>{
    const minutes=(Date.parse(r.payload.endAt!)-Date.parse(r.payload.startAt!))/60000;
    return [trainings.find(t=>t.id===r.referenceId)?.payload.name??'',r.payload.title??'',r.payload.instructor??'',r.payload.instructorEmployeeId?'已关联内部员工及认证快照':'未关联内部员工',stamp(r.payload.startAt!),stamp(r.payload.endAt!),minutes,r.status==='cancelled'?0:minutes,statuses[r.status]??r.status];
   });
  }else if(q.dataset==='trainingRoster'){
   title='可见范围班级学员名册';columns=['培训项目','课程','工号','姓名','人员状态','学习任务状态','必修场次数','已核验出席','已核验未出席','待核验或未登记','学习截止日'];
   const taskStatus:Record<string,string>={active:'进行中',submitted:'待成果核验',returned:'待补充成果',completed:'已完成'};
   rows=records.filter(r=>r.kind==='enrollment'&&r.status!=='cancelled'&&trainings.some(t=>t.id===r.payload.trainingId)).map(r=>{
    const required=records.filter(s=>s.kind==='trainingSession'&&s.referenceId===r.payload.trainingId&&s.payload.sessionCourseId===r.referenceId&&s.payload.mandatory&&s.status!=='cancelled');
    let present=0,absent=0;for(const session of required){const attendance=records.find(a=>a.kind==='trainingAttendance'&&a.referenceId===session.id&&a.employeeId===r.employeeId&&a.status==='verified');if(attendance?.payload.present===true)present++;if(attendance?.payload.present===false)absent++;}
    return [trainings.find(t=>t.id===r.payload.trainingId)?.payload.name??'',r.payload.title??'',code(r.employeeId),name(r.employeeId),employee(r.employeeId)?.status??'',taskStatus[r.status]??r.status,required.length,present,absent,required.length-present-absent,r.payload.due??''];
   });
  }else{
   title='可见范围培训项目进度';columns=['培训项目','所属组织','项目状态','可见报名人数','有效学习任务数','已完成任务','待核验任务','已取消任务','任务完成率（%）'];
   rows=trainings.map(t=>{const all=records.filter(r=>r.kind==='enrollment'&&r.payload.trainingId===t.id),valid=all.filter(r=>r.status!=='cancelled'),completed=valid.filter(r=>r.status==='completed').length;return [t.payload.name??'',org(t.payload.orgId!),statuses[t.status]??t.status,new Set(valid.map(r=>r.employeeId)).size,valid.length,completed,valid.filter(r=>r.status==='submitted').length,all.length-valid.length,valid.length?Math.round(completed/valid.length*10000)/100:null];});
  }
 }
 return finish({title,columns,rows});
}
export function reportCsv(columns:string[],rows:Cell[][]){const cell=(v:Cell)=>{let s=String(v??'');if(typeof v==='string'&&/^[\s\uFEFF]*[=+@-]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return '\uFEFF'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n');}
