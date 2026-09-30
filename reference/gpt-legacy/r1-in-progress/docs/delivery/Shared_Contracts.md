# 公共接口契约 SC-1

基于本轮核查代码记录现状，不声明新增服务。变更必须附版本、调用方影响和兼容处理，由总控唯一合并。

| 契约 | 现有实现 | 必须保留的约束 |
|---|---|---|
| 身份和租户 | context.ts / authorization.ts / repository.ts | tenantId来自已认证成员；客户端不能指定他人租户；成员停用拦截 |
| 主数据 | model.ts 的 State/Employee/Org/Position/Grade | employeeId/orgId/positionId/gradeId用内部ID；姓名/工号不可作为跨模块关系键 |
| 读取 | developmentContext、visibleDevelopment、projectRecord | 按当前角色/组织/字段过滤；不能直接将完整records返回客户端 |
| 写入 | POST /api/development {revision,command} | 当前修订号；返回{id,revision}，批量派课返回{ids,count,revision} |
| 一致性 | readConsistent / commitExtension | 修订变化409；业务、历史与审计共同事务；冲突刷新后显式重新提交，不盲目重试 |
| 多记录 | saveDevelopmentMany | 最多20条、唯一ID、一修订原子提交；不拆成部分成功 |
| 历史 | GET /api/development?id=ID&page=N | 当前权限再校验；分页；保留原始事件快照；历史不增加当前权限 |
| 错误 | http.ts | {error:string}；401未登录、403拒绝、400格式、409冲突、413大小、415类型、503未分类失败 |
| 请求 | readBody | 同源Origin、application/json、默认最大32768字节；招聘职位入口显式98304字节以容纳两段万字中文；不绕过统一处理 |
| 时间 | business-time.ts及领域现有函数 | 保持北京时间业务日期；事件UTC时间；不混用浏览器本地时区 |
| 附件 | /api/attachments | 服务端读取R2、元数据权限和下载后修订检查；不分享原始存储地址 |

## 人才—学习既有链路

1. 发展计划 kind=plan，employeeId 关联员工，referenceId 关联能力标准版本。
2. enroll 命令使用 employeeId/courseId/due，可选planId/trainingId。planId必须属于同一员工、状态active或returned；课程referenceId必须等于计划referenceId。课程必须published。
3. enrollment.referenceId是课程版本ID；payload.planId是计划ID，payload.trainingId是培训项目ID；不能互换，也不能用模糊名称关联。
4. 已有同员工/课程版本记录时拒绝再次enroll；取消后恢复使用restoreEnrollment并保留原任务和考试次数。历史跨项目复用尚未实现，不能视为接口能力。
5. submitLearning要求通过关联考试；verifyLearning须独立核验，接受前检查强制出勤；完成状态completed。verifyPlan接受前检查关联未完成且未取消的学习任务。
6. cadreProfile通过当前可见records聚合plans和learning。回流是读取现有权威记录，不另复制完成标记；不自动升级资格或职级。
7. 学分使用既有learning-credits接口，不把档案展示触发当成授予事件；来源与去重规则继续以领域代码为准。

共享热点：development.ts、app/api/development/route.ts、development-repository.ts被人才和学习共同使用，只能由当前总控/被明确交接的基础负责人单写。没有消息总线、跨服务事件系统或新自动派课协议，不为本批增建。

下一步：基础F-G0-02把以上契约逐项映射现有测试；模块只补确切缺口。任何新字段先记录请求/响应示例、旧数据处理、权限和消费者，再由总控合入。


## H001证据澄清（不改变SC-1业务语义）

逐项代码/测试映射见[G0_Evidence_Map.md](G0_Evidence_Map.md)，合成场景见[G1_Foundation_Plan.md](G1_Foundation_Plan.md)。本轮新增5项测试，连同既有109项共114/114通过。

- 历史page从1开始，每页20项，以第21项判断hasMore；原事件快照经过当前权限投影才返回。
- 未授权人员读取草稿课程或其他不可见记录可能先收到403；可见记录的状态/关联错误为400。业务校验发生在保存CAS之前，不将409描述为所有错误请求的固定优先结果。
- 计划允许active/returned状态派课；submitted/completed/cancelled不允许。课程同code不代表同版本，必须比较referenceId内部ID。
- 盘点与计划目前共享employeeId，计划referenceId指向能力标准；没有已实现的reviewId外键或自动计划生成协议。
- 本轮仅澄清现状并补证据，未改变公共请求/响应、领域规则或旧数据，不要求消费者迁移。

## H002 干部实例与待决议项（不改变SC-1）

执行提交`5bf8b9385fb4cb326880df7e3d1d2fc4bc183eb6`。planId/employeeId/标准版本与学习关联的实际合成ID、引用断言见[G1_Cadre_Delivery.md](G1_Cadre_Delivery.md)及测试输出H002_SC1_INSTANCE。盘点到计划仍为同员工显式办理，无reviewId外键；完成仅聚合权威记录。

离职后当前组织HR/经理及未停用本人保留既有计划/学习历史读取，属于现有实现，企业保留策略未核实。C-DEF-01：保留离职员工关联的active=false请求被member-rules在职校验阻断，400且账号仍active；具体证据和最小兼容修复建议见交付记录。总控修复前不作完整撤权或G1通过结论。

## C-DEF-01成员停用契约修正
显式active=false允许保留同租户既有离职员工关联；active=true仍要求在职，缺失档案仍拒绝。保持CAS和审计，无新增字段或迁移；不代表离职自动停用制度已确认。

## H004-R 绩效生命周期可操作提示
三个绩效GET接口新增兼容字段livePlanIds，仅列当前成员可见且在职、属于活动周期组织、未取消及未形成结果的计划ID。该字段是生命周期提示，不是角色授权；各命令继续独立校验身份、状态、修订及原子写入。仅返回已有可见ID，不暴露额外组织或人员字段。页面、待办、自助及报表统一使用同一生命周期判断。历史调整仍可拒绝/撤回，申诉更正保持原规则。

## 干部任期登记
新增cadreTerm记录及/api/cadre-terms GET/POST，写入仍为{revision,command}，不改变其他API。register/correct/end/void保存事件历史，关联员工ID和任用岗位ID。HR/admin写且不能本人，经理按当前双组织范围读；结束/作废仅登记，不自动改变人事主数据或发送通知。干部档案消费同记录，作废不展示当前条目、历史仍受当前权限保护。无表结构迁移。

## B1/B2 学习实例契约增量
learningAssignment引用不可变learningDefinition版本；enrollment的learningAssignmentId/learningDefinitionId和窗口/组织快照由服务器生成，原enroll命令不接受客户端自造关联。首轮派发、结项、整体取消/恢复在/api/learning-assignments下执行，统一revision+command包。saveDevelopmentMany默认20条不变；本入口显式21条（实例+最多20任务）。整体取消用assignmentCancelled及assignmentPreviousStatus保留原任务状态，实例恢复不重置考试、已完成课程或学分。普通员工不访问管理接口，通过既有学习页读取本人任务。课程原唯一性保持；重复课程、循环轮次及历史同步尚未开放。

## C1/C2 接口变更
enroll新增可选assignmentId，须匹配有效learningAssignment的员工、课程和冻结截止日，不能与trainingId/planId混用；仅此路径实例内唯一。assign支持relative/fixed的progressSync：记录sourceEnrollmentId/sourceVerifiedBy/sourceVerifiedAt/sourceExamAttemptId。GET学习实例增加attempt依赖用于核实来源考试，投影继续遵守原权限。courseCreditAlreadyGranted统一前后端课程版本去重。旧任务恢复保留原ID，关联实例的恢复继续校验原实例与冻结期限。

## SC-2 学习活动兼容增量（2026-09-08）

- 保留旧courseIds与enrollment，新增examIds/learningExamDefinition/learningExamTask/learningExamAttempt；courseIds与examIds合计最多20。
- learningRequirements: {id,kind:course|exam,resourceId}[]，要求ID在相同资源版本下跨配置版本稳定，实例冻结独立快照。旧实例只读映射，无批量迁移。
- /api/learning-plans新增stages命令与可选examIds；/api/learning-exams管理试卷版本；/api/learning-exam-tasks管理独立或计划内任务。全局revision与审计事务沿用SC-1。
- 必須按任务ID隔离尝试、按原始核验来源追溯课程。完成投影使用learningRequirementProgress，开放使用learningStageOpen及当前人员/日期判断，不能将所有completed状态直接相加。
- 试卷管理限admin/hr当前组织；学员仅接收有权任务的去答案paper。独立考试台账限admin/hr；人才档案仍沿用其角色范围。
- 单选等权百分制取整、通过停止重考为当前独立规则；未核实为原站完整算法。计划总成绩暂未生成。

SC-2成绩增量：gradeRule随定义版本和实例冻结；learningGrade输出state/score/missingExamIds/attemptIds，not_configured与pending的score均为null，provisional和final保留真实0分。只使用本实例requirementId绑定的考试任务与尝试。final仅代表实例已结项；不表示生产或业务已验收。规则保存端点沿用/api/learning-plans的grading命令。

### SC-1 学习阶段窗口和顺序补充（BC-L08）

固定日期模式的 startAfterDays 以 learningMode.start 为起点；relative 以实例加入业务日为起点，0表示当天。原有 relative 数据不变；修正已有 fixed 实例投影，不重写历史完成记录。

阶段增加可选 orderedTasks / examSubmissionUnlock，默认 false。顺序按冻结的 trainingStages[].courseIds（混合资源ID）排列，全部前置要求完成后放行；显式启用考试例外时，可用同实例、同员工、同要求绑定任务的有效作答放行，允许该次作答未及格。例外不改变 requirement 完成状态、实例结项门槛或学分。阶段例外不能在 orderedTasks=false 时设为 true。当前选修任务也遵循前置顺序；原站跳过选修的具体语义待核实。未支持的作业、面授、辅导、线下考核放行例外保留后续，不能映射为课程完成。

### SC-1 独立客观题结构补充

独立试卷可使用 objectiveQuestions（single/multiple/trueFalse，prompt/options/correct[]/points/partialPoints），与旧 questions 二选一。旧单选版本保留每题1分的解释，旧客户端不能把含objectiveQuestions的草稿降级覆盖。定版版本和已有作答不变。新答案使用数组集合，拒绝重复/越界及不完整作答；单选判断只能一项。多选全对满分、未选错但未选全按显式partialPoints、含错误项零分；本批仅整数题目分值，未声称原站全部计分一致。

作答快照保留 objectiveAnswers、earnedPoints、maxPoints 和 score（取整百分制）。通过与否使用原始分比例交叉相乘，不能因显示舍入达到及格线而误通过；计划成绩仍使用其明确的百分制聚合契约。对学员试卷投影去掉correct，答案只留在有权限的定义端，历史尝试沿用本人/范围隔离。独立考试报表追加原始得分和总分，不改旧列位置。

未实现：填空/简答/排序、人工阅卷、题库/随机抽题/导入、完整补考及原站评分尺度。上述全部仍在范围中。

### SC-1 独立作业及计划绑定（BC-L09）

homeworkDefinition保存草稿/定版/后续版本/归档和作业要求、最大提交次数。homeworkTask冻结内容版本，指定同组织在职且非本人的reviewerEmployeeId，homeworkSubmission按提交版本留存正文与批阅证据。每次提交/批阅双记录原子保存；重复批阅及旧提交不能覆盖当前版本。转交通过当前任务控制全部提交及历史入口权限，旧批阅人立即撤权。单作业取消使用homeworkPreviousStatus，整单取消使用assignmentPreviousStatus，两者不得覆盖。

首批为一名指定人员独立批阅，评分可选且不自动决定通过；最大提交次数由HR配置，退回后在期限/次数内可重交。已提交的作业允许指定人员在提交截止后批阅，但仍检查人员/组织和实例/阶段门槛；这是明确内部策略，未宣称原站默认。取消状态也可由HR转交批阅人，便于原批阅人调动/离职后的恢复，不解除取消。

learningDefinition.homeworkIds为可选追加字段，旧客户端省略时保留；资源合计1–20，阶段资源恰好覆盖一次。requirement.kind=homework，ID稳定，版本/实例冻结；派发必须提供homeworkReviewers资源ID→员工ID映射。全部资源与实例仍最多21条原子写入。完成须当前提交的通过证据、正确任务/人员关联和一致核验人/时间，不借用另一实例或把提交当完成。

阶段homeworkSubmissionUnlock可在orderedTasks=true时明确启用：本实例存在有效作业提交可放行后续任务，批阅是否通过仍控制要求完成和实例结项。其他活动例外不混用。循环下一轮重新生成作业，不复用旧提交，默认沿用上轮各作业的当前批阅人，也可显式替换；人员无效则整单拒绝。归档定义不接新派发，已派发内容版本保持。

保留未实现范围：多级/多名批阅、富文本附件约束、AI批阅、抄送、优秀作业、作业学分奖励、内容权重成绩与完整企业退回规则；不得用课程或作业通过代替这些功能完成。

### SC-1 内容权重首批（BC-L10）

contentWeighted显式配置items(requirementId,source,weight)，支持examHighest/examAverage/homeworkLatest，正整数百分比合计100且要求ID唯一。仅引用本定义有实际分数来源的考试/作业；不把无成绩课程完成映射满分。定版及实例冻结；更换所引用资源清单清空相关规则。

考试按本实例的有效作答取分；作业只取当前提交已批阅的评分，重新提交未批阅时保持待定。attempts=all/passed明确控制是否计入未通过记录，decimals明确舍入0–2位；这些缺失/纳入/精度政策为内部显式选择，不声称源站默认。无有效分或缺少任何加权项不重归一化、不静默计零。保留missingRequirementIds和evidenceIds供追溯；attemptIds仍仅考试尝试，兼容旧消费者。

计划成绩按各活动已记录的百分制计算，原始分另外保留；课程成绩、带教/线下考核等其他来源和小数权重未支持。批阅独立性同时检查员工身份与提交账号，重新绑定员工不能让同账号审批自己的提交。


## 内容更新增量契约（BC-L03部分实现）

POST /api/learning-content-update: {revision, action:"preview"|"apply", command:{assignmentId,definitionId,homeworkReviewers?}, evidence?}。preview不写入，返回差异、阻止原因、更新前后完成与成绩投影；apply重新检查全部权限/版本/人员及资源，不信任客户端预览。全局revision CAS、实例与新增任务及审计原子保存，最多21条；审计失败不得部分更新。

首批仅同族后续定版、模式/日期/同步不变、未过期且非循环的active实例；已有要求必须全部保留，追加课程仅在progressSync=false时支持，追加考试/作业复用独立派发校验。原任务不改写；目标定义、旧定义链、更新人/时间/依据保存在实例与不可变事件中。contentDefinitionHistoryIds防止已迁移版本再次本轮派发。不得用这组字段替代真实数据迁移审批；这里只操作授权的本系统合成学习实例。


内容退出扩展（覆盖前述“仅追加”限制）：同一命令可移除/替换要求，新增+退出任务最多20条。任务的requirementRetiredAt/By/DefinitionId/Reason记录退出，不改其原状态/答案/核验；当前进度排除退出项，学习/考试/批阅入口及单项/整单恢复拒绝重激活。退出标记不撤销历史学分，不创建额外奖励。重新加入同一退出资源版本阻止办理，待独立恢复语义。保留最初派发版本标识与每次实例内容版本的不可变审计快照。无数据库迁移。


同步扩展：新增课程复用同一个reuseCompletedCourse函数，与原首轮派发来源选择保持一致；非循环实例按冻结progressSync开关执行。preview返回reusedCourses及与实际派发一致的完成投影，apply在CAS提交前重算，不信任预览缓存。没有新来源则待学习；不复制attempt/learningCredit。此扩展覆盖“追加课程仅progressSync=false”的首批限制。


## 阶段提交期限契约（BC-L08字段，明确独立计日策略）

learningDefinition/learningAssignment.trainingStages[].deadline?={days:1..36500,allowOverdue:boolean,policy:"scheduled-inclusive"}。旧记录缺失则无独立阶段截止。阶段最早开放业务日期+days-1，前置未完成不重置期限。learningStageSubmissionOpen只约束新提交；learningStageOpen继续负责生命周期/退出/顺序，独立核验不增加提交期限阻断。整计划期限继续独立生效。

配置版本冻结并通过既有内容更新迁移。派发及内容更新拒绝已截止且未完成、又禁止超期的阶段；原子拒绝不落部分任务。精确计日、迟解锁不顺延和超期核验是当前显式实现策略，非原站已实测规则，生产前须结合企业规则验收。

## 绩效与招聘兼容增量（2026-09-08）

绩效等级定义由 /api/performance-ratings 管理草稿、定版、归档及后续版本。活动冻结 ratingScheme；发布结果和申诉更正沿用该快照，不读取最新主定义替换历史。旧三档百分制数据保持。每档 talentBand 明确映射既有人才消费者；自定义区间须无重叠，落在空档的成绩拒绝发布。活动的 performanceMetadata 是分类信息，不授予权限或替代截止日；仅无计划的草稿可编辑，省略等级引用保留旧快照，null 明确选择旧三档规则。

招聘新增需求默认草稿，submitRequisition 后待审；旧无 requisitionSubmissionRequired 标记的 draft 保持原待审语义。创建/修订可显式 submit:true 在同一事务保存并提交，所有贡献者不得审批。仅招聘需求、候选人、面试三种创建支持可选 Idempotency-Key；同租户同账号相同规范化请求重放返回原ID且不再次写入，不同内容409。重放仍检查当前权限；creationRequest 不出现在读取投影。旧无键客户端兼容，此机制不承诺其他入口幂等。

### 内部招聘职位版本（BC-R05 的限定实现）

GET/POST /api/recruitment-jobs 沿用 revision/command 和审计原子事务；命令 create/edit/activate/revise/archive。POST 通过统一 readBody 校验，显式上限98304字节，其他入口默认32768不变。HR/admin 按当前组织写，经理按范围读，员工不得进入。create 关联已批准开放需求和启用岗位；edit 仅草稿，activate 后内容冻结。revise 从最新仍启用版本产生下一草稿，归档草稿不阻断修订且版本号按全族历史最大值递增，definitionRootId 保持同族，referenceId 始终是需求ID；归档保留记录与审计。

jobDetails 含类别、用工方式、地点、地址、学历、经验、职责/资格（各最多10000字符）以及月薪面议或人民币整数分范围。类别与用工方式的原站枚举尚未核实，首批为企业显式文本；启用、不可变版本及原需求共享容量是本系统限定策略，不冒充原站全部流程。

/api/recruitment 的 candidate 命令新增可选 jobId。提供时必须是同需求的当前可见启用职位，服务端冻结 {id,rootId,version,title,details,workflow} 到候选记录。旧不提供 jobId 的候选保持原路径；后续职位修订/归档不覆盖候选来源。全部版本仍按同一 requisitionId 汇总录用人数，不能分版本突破需求名额。workflow 固定 legacy-interview-offer-v1，不代表可配置招聘流程、广告发布或对外通信。无数据库迁移。

## 配置归档后的修订恢复

绩效等级、学习计划、独立试卷、作业与内部职位使用一致边界：当前仍定版/启用的最新版本可修订，已有草稿或更新的仍定版/启用版本阻止分叉；归档后续草稿或定版不永久锁住旧版本。新版本号取同族所有历史版本最大值加1，不复用已归档号码。原引用、实例冻结内容、答案及历史证据不改写。无迁移；页面可操作提示与服务端一致，权限/CAS仍独立检查。

## 结构化面试评价（BC-R07 限定实现）

/api/interview-definitions 使用 create/edit/seal/revise/archive，评价表按组织授权、定版不可覆盖，归档修订恢复遵循前述统一版本规则。criteria 每项 id/dimension/title/description/四档 labels，最多20指标、10维度。仅本入口请求最大196608字节，容纳最多中文说明/标签；/api/recruitment 显式65536字节以容纳十个1500字维度评语，其余入口保持已有独立限制。

招聘新增 structuredInterview 命令：candidateId/definitionId/scores/comments/recommendation/evidence。须同组织定版模板、当前可见且开放需求下的筛选候选；以当前HR/admin/manager账号评价，不接受代签身份。通过须全指标，不通过可仅结论；已填评分必须1–4整数，拒绝未知指标/维度，空缺不补零。服务端冻结 interviewEvaluation={definitionId,rootId,version,title,criteria,scores,comments,scale:"four-level",aggregation:"not-configured"}，不伪造总分/旧rating。原 interview 命令保持1–5级，录用按两类共用顺序版本取最近明确建议。

新 structuredInterview 同样支持招聘创建 Idempotency-Key；当前支持需求、候选、旧面试和结构化面试四种创建，覆盖前述三种限制。不支持状态操作/模板创建。相同键仍受当前角色和组织、规范化请求内容校验，审计故障原子回滚，内部键摘要不出现在读取或历史投影。

源站可见模板与本企业提交规则尚未完全验证；无新增迁移，未启用外部消息或通知。

## 内部排期—指定评价关联（BC-R08 限定实现）

/api/interview-schedule GET/POST 使用 schedule/reschedule/cancel，HR/admin管理、范围内manager读取。固定Asia/Shanghai，起止存UTC，正时长且最多24小时；一个同岗位组织在职人员且已有有效admin/hr/manager账号及当前组织范围。eligibleInterviewerIds读取现有成员且复核同revision，避免无账号或越界账号成为唯一面试官。不创建账号、邀请或发送消息。

同候选或同指定人员的未取消/完成排期时间重叠拒绝，首尾相接允许；失效排期保留并须显式调整/取消，不静默释放。安排时冻结评价表；调整保留同ID冻结内容（即使主表归档），明确换表时须同组织当前定版。已完成/取消不可改写。历史依据保留。

structuredInterview新增可选appointmentId，与candidateId和definitionId核对；仅结束后、当前范围有管理评价权限且employeeId等于指定人员、候选/需求/岗位/人员均有效时允许。取排期冻结表而非当前主定义；评价与排期completed/interviewResultId两记录在一revision与审计事务提交，失败共同回滚。取消、调动、离职、撤权后拒绝。含未完成排期的候选禁止直接offer，旧无排期路径仍兼容。请求键重放恢复原评价，不再次完成排期。

首批为内部登记及指定人员评价，未验证原站全部冲突和日期算法，未实现多面试官、多表、多时区、通知/会议或自助约面。无数据库迁移或真实数据迁移。

## 手动考勤期间汇总/冻结（BC-A01–04 限定实现）

/api/attendance-periods GET为HR/admin/manager范围读，POST为HR/admin。preview严格接收employeeId/start/end，校验当前revision与人员权限，返回逐班结果、汇总和blockers，不写入、不返回原始来源对象。freeze/refreeze重新计算且不信任客户端预览；期间1–31个已结束业务日，至少一个有效班次，所有班次结束且无待审批、缺卡/冲突/未覆盖。最多1000来源，未核验冲突的汇总不是零。

attendancePeriod保存employeeId、显式日期、冻结次数、记录时员工/组织、attendanceSnapshot(policy/sourceRevision/capturedAt/rows/sources/totals)、核验人/依据。冻结按固定班次起始业务日归属；不是年度余额、工资或历史组织重建。所有已有假勤命令先执行身份/业务验证，再经统一锁校验阻止冻结区间班次/clock/correction/leave变更；创建新班次也受日期锁保护。/api/attendance上下文包含锁，员工只收到本人可见班次的frozenShiftIds，不收到管理冻结快照或其历史。

reopen保存原因并保留旧快照，refreeze重新核验增加版本；void仅开放状态可办，保留原证据且释放错误区间重建。同员工非作废期间不重叠。当前员工范围控制管理读取与重新开放，调动不绕过冻结；修改人员不会自动删除历史。所有写入与审计共用CAS，无表迁移。

手动冻结/开放为明确内部限定规则，不能据原站自动冻结/发布/封存提示推断完整流程。自动任务、多组织共享、员工确认/申诉/发布/封存及法律企业规则保留。

## SC-A-SHIFT 固定班次与原子派班

`GET/POST /api/shift-definitions`，沿用 `{revision,command}`。定义新建/草稿编辑/定版/修订/归档只允许HR/admin，组织范围服务端检查；经理可只读和派班。`assign` 为 `{action:'assign',id,assignments:[{employeeId,date}]}`，1–20条，整批同一CAS/事务/逐记录事件；返回 `{ids,revision}`。无新数据库迁移。
`shiftDefinition` 保存固定分钟偏移及版本族；单次可跨日但不超过24小时，只允许一次非全程休息。派班复用applyAttendance及期间锁；不接受客户端快照。`shift.payload.shiftDefinition` 保存定义ID/根/版本/名称/组织/时区/时段。定义后续修订或归档不覆盖实例。
规则范围及原站差异见Attendance_Source_Gaps BC-A05/A06。禁止将内部归档解释为原站班次档案停用。

## SC-A-LEAVE 假种边界与历史规则

现有 `/api/attendance` 的leaveType增加可选orgId/minMinutes/maxMinutes/policyText。上下限1–1440整数工作分钟（扣除休息），min≤max；不使用原站默认8小时换算。HR新建必须有组织且处于作用域，全企业新建仅admin。旧无组织定义兼容。
新增retireLeaveType `{id,reason}`：HR限本组织、admin可维护全企业。停止仅阻止新申请及新额度登记；旧待审批/更正/冻结保护不变。定义不可编辑覆盖。
leave/leaveCredit保留leaveTypeSnapshot。组织调动后当前定义可见性收窄，历史本人余额根据流水快照仍展示，不错误消失或自动迁移。新增申请服务端再次校验组织/状态/分钟上下限；历史决定沿用原规则和既有独立审批。无新迁移/无外发。

## SC-PAY-A 考勤冻结引用

`POST /api/payroll` slip增加可选attendancePeriodIds（最多31，不重复、不重叠、同员工且完整位于同计薪月）；旧客户端编辑时省略字段保留并重新校验已有引用，显式[]才能清除。服务端冻结聚合元数据，不信任客户端快照、不自动计算工资。
`paySlip.payload.payrollAttendance` 存ID/版本/更新时间/日期/来源修订与计划、批准请假、未覆盖分钟，不复制打卡明细或人员原始数据。GET仅薪酬角色按当前人员范围获取候选聚合；普通员工不返回来源集合与异常映射，工资投影隐藏管理引用。
提交/批准/发布检查来源仍冻结且版本/时间/员工相同；过期409，退回操作保留。已发布不回写工资，GET展示异常供另行核定补差。现有独立复核、贡献者、权限、CAS和审计完整保留。无迁移、支付或通知。

## SC-I-SOURCES 统一待办与引用核对报表

work-inbox读取attendancePeriod和interviewAppointment来判断可执行性。指定评价待办直接使用既有canEvaluateAppointment；薪酬过期引用不生成批准/发布待办，改为当前角色可处理的核验/退回事项。工资待办batchId深链只选择当前可见批次。
新增report dataset `payrollAttendanceReferences`：仅admin/payroll_editor/payroll_reviewer并按批次组织范围过滤，行单位为每个工资引用期间，列出旧冻结聚合和当前版本一致性，无原始打卡。旧报表列顺序不变。报表导出继续现有修订/审计和公式转义机制，不扩大访问或自动外发。

## SC-P-TEXT 单维绩效文本模板

`/api/performance-templates` HR/admin同组织草稿/编辑/定版/修订/归档，使用既有修订和审计。新kind performanceTemplate，最多10个稳定ID文本项，stage=selfReview/evaluation、required；描述200字。未配置通用流程或动态权限。
周期command可选templateId（null显式清除，旧编辑省略保留），只接受同组织定版；payload.performanceTemplate为不可变快照。selfReview/evaluate增加responses，服务端拒绝未知/跨阶段字段和缺失必填，单项1000字。员工未发布计划投影及历史隐藏evaluationResponses；正式结果已有完整快照保留。申诉不更改模板答案，原答案与更正依据分开。
绩效body上限98,304字节，其余API保持既有限制；不改变评分及目标权重、独立审批或数据库结构。


## SC-P-GOAL-RANGE（单维可选强制范围）

performanceTemplate草稿可携带goalRules{minCount,maxCount,minWeight,maxWeight}，四项整数，分别处于1–20/1–100，并满足上下界和总和100%的可行组合。未配置保持旧规则。定版版本不可修改；周期performanceTemplate快照保留原规则，模板修订/归档不改变旧活动。

目标保存、调整申请和接受调整统一检查快照规则；拒绝无副作用，调整通过与计划更新继续原子保存。调整通过后清空当前自评/管理文本，原文本仅在原历史快照保留并按现有角色投影。没有新增外部接口、数据库迁移或访问范围。

## SC-P-INDICATOR（定性指标版本与目标引用）

新增performanceIndicator记录及/api/performance-indicators：HR/admin同组织维护草稿、定版、修订和归档；普通员工只读本人当前组织已定版指标，经理只读管辖组织已定版指标。组织、编号固定；同组织编号不区分大小写唯一。分类首批是名称，不是完整共享分类树。最多60位ASCII编号为本系统校验边界，非原站长度推断。

目标输入保留title/metric/weight，新增可选indicatorId。来源快照由服务端读取同组织已定版指标生成，客户端提供indicatorSource不会被采信。计划编辑或调整可保留已有旧来源；新选项须重新检查，归档不能被新计划使用。归档/修订不隐式刷新计划、待审调整、已发布结果或盘点来源。权重和评价角色仍由原流程控制，不由指标元数据覆盖。

前端只提交目标字段及indicatorId，不回传来源快照；绩效/目标调整请求上限327680字节，以容纳已允许的20项4000字中文目标，保持有限上限。所有写入复用workspace revision和审计事务；状态变化并发依然通过CAS拒绝旧请求。无数据库迁移、外部同步或新访问范围。
