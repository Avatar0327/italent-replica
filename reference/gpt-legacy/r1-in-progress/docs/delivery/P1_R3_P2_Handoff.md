# R3 P1→P2正式交接

生成来源：`Scope_Register.json → deliveryScope / p1Baseline / modules[].p1 / p1B`。本文是同一台账的阅读视图，不独立维护范围或验收状态。更新时间：2026-09-10T03:24:03.609414+00:00。

当前交付为用户确认的15个HR核心模块及六类非模块基础能力；原48组历史完整保留，33组本次交付暂缓，不计完成、不阻当前P1退出。各历史证据的适用时间保持。

状态：P1受限关闭，P2设计进入获准，P2尚未开始。批准：R3-P1-P2-TRANSITION-20260910。

| 模块 | 完整范围 | 批准记录 | 规格 |
|---|---|---|---|
| M27 | 资源、问卷、计划、实施、考试、师资、报表 | M27-P1-APPROVAL-20260910 | [评审基线](P1_M27_Review_Package.md) |
| M16 | 工作台、OKR、员工/组织目标与绩效 | M16-P1-APPROVAL-20260910 | [评审基线](P1_M16_Review_Package.md) |
| M12 | 需求、职位、应聘者、面试、人才库 | M12-P1-APPROVAL-20260910 | [评审基线](P1_M12_Review_Package.md) |
| M11 | 档案、排班、考勤、申请、假期、AI排班 | M11-P1-APPROVAL-20260910 | [评审基线](P1_M11_Review_Package.md) |
| M07 | 档案、核算、社保、支付、个税通、激励 | M07-P1-APPROVAL-20260910 | [评审基线](P1_M07_Review_Package.md) |

六基础全部适用，范围外33模块及独立AI继续暂缓；电子签、支付、税务申报、真实测评/消息仅契约，不以供应商接通作为设计前置。不扩展模块内部登记范围。

## M27 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M27-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：已有配置版本、任务独立核验、取消恢复前态、场次冲突、独立讲师认证/师徒/证书申请及历史审计；待修改/新增：设计自动循环调度及cycleKey幂等、完成实例显式改版、完整题型/抽题/人工批阅、费用与课酬版本化、问卷隐私、学分事件账及跨模块有效性；保留隔离learning-description分支，不合并；代码证据：lib/hris/learning-assignments.ts,lib/hris/learning-plan-definitions.ts,lib/hris/learning-content-update.ts,lib/hris/learning-exam-definitions.ts,lib/hris/learning-homework.ts,lib/hris/training-sessions.ts,lib/hris/mentoring.ts,lib/hris/certificates.ts |
| 验收ID | M27-REVIEW-AC01；M27-REVIEW-AC02；M27-REVIEW-AC03；M27-REVIEW-AC04；M27-REVIEW-AC05；M27-REVIEW-AC06；M27-REVIEW-AC07；M27-REVIEW-AC08；M27-REVIEW-AC09；M27-REVIEW-AC10；M27-REVIEW-AC11；M27-REVIEW-AC12；M27-REVIEW-RETURN；M27-REVIEW-WITHDRAW |
| 受限范围 | 原站自动循环、已完成学员更新、复杂题型/重考、学习问卷隐私、费用同步/课酬、师资和证书失效传播未执行；单账号不能验证独立审批。 |
| 残余风险 | 错误重复派发/授学分、匿名重识别、考试版本漂移、错误结训/课酬及证书效力 |
| P2/P3/P4责任 | P2：设计自动循环调度及cycleKey幂等、完成实例显式改版、完整题型/抽题/人工批阅、费用与课酬版本化、问卷隐私、学分事件账及跨模块有效性；保留隔离learning-description分支，不合并；P3：按本包Given/When/Then合成验证正常/边界/并发/故障，补算法及版本迁移证据，历史测试不代复验；P4：独立多角色、敏感字段/历史附件/下载、跨模块业务、生产恢复与外部联调。E2不新增人，单管理员不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-L-REQ-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/learning-plan-definitions.ts；lib/hris/learning-plan-model.ts；lib/hris/learning-content-update.ts；lib/hris/learning-requirements.ts；tests/learning-content-update.test.mjs；tests/learning-recurrence.test.mjs |
| BP-L-REQ-02 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/learning-plan-definitions.ts；lib/hris/learning-requirements.ts |
| BP-L-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/learning-grades.ts；lib/hris/learning-grade-evidence.ts |
| BP-L-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/learning-credits.ts |
| BP-L-REQ-06 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/learning-homework.ts；lib/hris/learning-exam-definitions.ts |
| BP-L-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/learning-homework/route.ts；lib/hris/http.ts |
| BP-L-REQ-07 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/training-sessions.ts；lib/hris/instructor-assignment.ts |
| BP-L-REQ-08 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/instructor-directory.ts；lib/hris/instructors.ts；lib/hris/instructor-development.ts；lib/hris/instructor-trials.ts |
| BP-L-REQ-09 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/mentoring.ts |
| BP-L-REQ-10 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/certificates.ts |
| BP-L-REQ-11 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/training-sessions.ts；lib/hris/payroll.ts |
| BP-I-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/surveys.ts；lib/hris/feedback.ts |

## M16 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M16-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：绩效模板/评级快照、目标调整独立审批、跟进原目标快照、正式结果和申诉更正关联；待修改/新增：补组织绩效稳定对象、OKR目标/KR/对齐及复盘、多维评分和缺评类型、兼职上下文、时间窗口、强制分布与系数契约；复核更正发布回避及下游影响；代码证据：lib/hris/performance.ts,lib/hris/performance-ratings.ts,lib/hris/performance-changes.ts,lib/hris/performance-checkins.ts,lib/hris/performance-availability.ts,lib/hris/module-progress.ts |
| 验收ID | M16-REVIEW-AC01；M16-REVIEW-AC02；M16-REVIEW-AC03；M16-REVIEW-AC04；M16-REVIEW-AC05；M16-REVIEW-AC06；M16-REVIEW-AC07；M16-REVIEW-AC08；M16-REVIEW-AC09；M16-REVIEW-AC10；M16-REVIEW-AC11；M16-REVIEW-AC12；M16-REVIEW-RETURN；M16-REVIEW-WITHDRAW |
| 受限范围 | OKR/组织目标完整页面及业务算法未探索；多维缺评、强分、兼职及系数仅局部帮助证据；申诉期限和独立多角色未执行。 |
| 残余风险 | 不当评价/分布、错误缺评分母、兼职身份漂移、越权分数可见及更正后奖金联动 |
| P2/P3/P4责任 | P2：补组织绩效稳定对象、OKR目标/KR/对齐及复盘、多维评分和缺评类型、兼职上下文、时间窗口、强制分布与系数契约；复核更正发布回避及下游影响；P3：按本包Given/When/Then合成验证正常/边界/并发/故障，补算法及版本迁移证据，历史测试不代复验；P4：独立多角色、敏感字段/历史附件/下载、跨模块业务、生产恢复与外部联调。E2不新增人，单管理员不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-P-REQ-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/performance.ts；lib/hris/performance-availability.ts |
| BP-P-REQ-02 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/performance-ratings.ts |
| BP-P-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/delivery/Performance_Source_Gaps.md；lib/hris/performance.ts |
| BP-P-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/performance/route.ts；lib/hris/http.ts |
| BP-P-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/performance.ts；lib/hris/performance-availability.ts |
| BP-P-REQ-05 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/performance-changes.ts；lib/hris/performance-checkins.ts；lib/hris/performance-availability.ts |
| BP-P-REQ-06 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/performance.ts；lib/hris/performance-ratings.ts |
| BP-P-REQ-07 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/performance-ratings.ts；lib/hris/performance.ts |
| BP-P-REQ-08 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/performance.ts；lib/hris/module-progress.ts |
| BP-P-REQ-09 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/module-progress.ts；app/hris.tsx；docs/delivery/Scope_Register.json |

## M12 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M12-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：需求显式提交、职位快照、面试评价冻结、Offer独立审批、入职人数守卫及部分创建请求幂等；待修改/新增：拆自然人/申请/库关系与去重审核；Offer版本及参与者历史、人数预留账和失效释放、M01稳定身份与再入职接口、排期修订历史、候选用途权限与外部渠道状态；代码证据：lib/hris/recruitment.ts,lib/hris/recruitment-jobs.ts,lib/hris/interview-schedule.ts,lib/hris/recruitment-evaluations.ts,app/api/recruitment/route.ts |
| 验收ID | M12-REVIEW-AC01；M12-REVIEW-AC02；M12-REVIEW-AC03；M12-REVIEW-AC04；M12-REVIEW-AC05；M12-REVIEW-AC06；M12-REVIEW-AC07；M12-REVIEW-AC08；M12-REVIEW-AC09；M12-REVIEW-AC10；M12-REVIEW-AC11；M12-REVIEW-AC12；M12-REVIEW-RETURN；M12-REVIEW-WITHDRAW |
| 受限范围 | 原站系统查重、多库/多申请、完整Offer路由及占编、再入职交接、排期通知和入职后权限传播均未执行；没有外部签署/门户联调。 |
| 残余风险 | 误合并自然人、超编或错误入职、Offer利益冲突、候选隐私及外部回执伪成功 |
| P2/P3/P4责任 | P2：拆自然人/申请/库关系与去重审核；Offer版本及参与者历史、人数预留账和失效释放、M01稳定身份与再入职接口、排期修订历史、候选用途权限与外部渠道状态；P3：按本包Given/When/Then合成验证正常/边界/并发/故障，补算法及版本迁移证据，历史测试不代复验；P4：独立多角色、敏感字段/历史附件/下载、跨模块业务、生产恢复与外部联调。E2不新增人，单管理员不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-R-REQ-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/recruitment.ts；lib/hris/recruitment-jobs.ts |
| BP-R-REQ-02 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/recruitment.ts；lib/hris/recruitment-evaluations.ts |
| BP-R-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/recruitment/route.ts；lib/hris/http.ts |
| BP-R-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/recruitment/route.ts；lib/hris/http.ts |
| BP-R-REQ-05 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/interview-schedule.ts；lib/hris/recruitment-status.ts；lib/hris/recruitment.ts |
| BP-R-REQ-06 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/recruitment.ts；lib/hris/development.ts；docs/P1_Source_Observations_20260907.md |
| BP-S-REQ-07 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/recruitment.ts；lib/hris/model.ts |

## M11 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M11-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：分钟交集计量、余额预留、请假/补卡独立审批、班次冻结锁、补卡版本与期间来源快照；待修改/新增：补多段常规轮班/节假日与历史任职方案、通用申请分类、额度批次与跨年结转、加班转调休、不可变期间版本及发布确认封存、工资消费撤回阻断；代码证据：lib/hris/attendance.ts,lib/hris/attendance-periods.ts,lib/hris/attendance-locks.ts,lib/hris/shift-definitions.ts,app/api/attendance/route.ts |
| 验收ID | M11-REVIEW-AC01；M11-REVIEW-AC02；M11-REVIEW-AC03；M11-REVIEW-AC04；M11-REVIEW-AC05；M11-REVIEW-AC06；M11-REVIEW-AC07；M11-REVIEW-AC08；M11-REVIEW-AC09；M11-REVIEW-AC10；M11-REVIEW-AC11；M11-REVIEW-AC12；M11-REVIEW-RETURN；M11-REVIEW-WITHDRAW |
| 受限范围 | 原站常规多段/轮班/日历、自动授假折算/结转/过期/调休结算、月报自动和反向流程未执行；部分申请子类仅配置线索。AI排班按既有决定暂缓不纳退出。 |
| 残余风险 | 错误缺勤/扣假、跨日跨年重复消费、工资引用失效、敏感证明越权 |
| P2/P3/P4责任 | P2：补多段常规轮班/节假日与历史任职方案、通用申请分类、额度批次与跨年结转、加班转调休、不可变期间版本及发布确认封存、工资消费撤回阻断；P3：按本包Given/When/Then合成验证正常/边界/并发/故障，补算法及版本迁移证据，历史测试不代复验；P4：独立多角色、敏感字段/历史附件/下载、跨模块业务、生产恢复与外部联调。E2不新增人，单管理员不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-A-REQ-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/attendance.ts |
| BP-A-REQ-02 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/attendance-periods.ts；lib/hris/attendance-locks.ts |
| BP-A-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/delivery/Attendance_Source_Gaps.md |
| BP-A-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/attendance/route.ts；lib/hris/http.ts |
| BP-A-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/shift-definitions.ts；lib/hris/attendance.ts；app/api/attendance/route.ts |
| BP-A-REQ-05 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/attendance.ts；lib/hris/attendance-locks.ts |
| BP-A-REQ-06 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/attendance-periods.ts |

## M07 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M07-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：人工批次与项目整数金额、contributors回避、工资范围投影、冻结考勤守卫、已发工资条/异议/补差及对账；待修改/新增：补薪资组/包/事件档案、受控公式DAG和输入政策快照、社保/税期/激励对象、负净额待处理账、支付幂等及对账、薪资权限和历史迁移；不引入完整预算/佣金/福利模块；代码证据：lib/hris/payroll.ts,lib/hris/payroll-adjustments.ts,lib/hris/payroll-attendance.ts,lib/hris/payroll-access.ts,lib/hris/payroll-reports.ts,lib/hris/model.ts |
| 验收ID | M07-REVIEW-AC01；M07-REVIEW-AC02；M07-REVIEW-AC03；M07-REVIEW-AC04；M07-REVIEW-AC05；M07-REVIEW-AC06；M07-REVIEW-AC07；M07-REVIEW-AC08；M07-REVIEW-AC09；M07-REVIEW-AC10；M07-REVIEW-AC11；M07-REVIEW-AC12；M07-REVIEW-RETURN；M07-REVIEW-WITHDRAW |
| 受限范围 | 自动档案、公式/多期间/追溯补差仅局部源证据；社保/个税/激励详细原站规则尚未探索；无银行支付、税务申报及多角色薪酬验证。外部交易不作P1前置。 |
| 残余风险 | 错误计薪或扣款、政策/身份错配、负净额不当追收、薪酬泄露及重复支付 |
| P2/P3/P4责任 | P2：补薪资组/包/事件档案、受控公式DAG和输入政策快照、社保/税期/激励对象、负净额待处理账、支付幂等及对账、薪资权限和历史迁移；不引入完整预算/佣金/福利模块；P3：按本包Given/When/Then合成验证正常/边界/并发/故障，补算法及版本迁移证据，历史测试不代复验；P4：独立多角色、敏感字段/历史附件/下载、跨模块业务、生产恢复与外部联调。E2不新增人，单管理员不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-S-REQ-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/payroll.ts；lib/hris/payroll-access.ts |
| BP-S-REQ-02 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/payroll-attendance.ts |
| BP-S-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/delivery/Payroll_Source_Gaps.md；docs/delivery/Scope_Register.json |
| BP-S-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/payroll/route.ts；lib/hris/http.ts |
| BP-S-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/payroll-adjustments.ts；lib/hris/payroll-reports.ts；lib/hris/payroll-access.ts |
| BP-S-REQ-05 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/payroll-access.ts；lib/hris/payroll-reports.ts；lib/hris/payroll-attendance.ts；lib/hris/development.ts |
| BP-S-REQ-06 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/model.ts；lib/hris/workforce.ts；lib/hris/payroll.ts |
| BP-S-REQ-08 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；docs/delivery/Scope_Register.json |
| BP-S-REQ-11 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/payroll.ts；lib/hris/model.ts；lib/hris/recruitment.ts；docs/P1_Source_Observations_20260907.md |
| BP-S-REQ-12 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/payroll.ts；lib/hris/payroll-adjustments.ts；docs/delivery/Payroll_Source_Gaps.md；docs/P1_Source_Observations_20260907.md |

## P2工作及退出条件

按模块顺序，完成架构复用/差异、稳定对象与版本模型、服务端行列动作授权、状态与审批/生效事务、接口契约及未知重试、迁移映射与兼容回滚、附件/审计/备份恢复设计。每条批准需求和验收ID必须映射设计与责任；缺项和互相冲突须解决或明确批准处置。核心规则不得由旧实现限制覆盖；评分尺度、缺失状态与版本冻结遵守所属模块已批方案。

数据迁移保留稳定ID、原历史及来源；按新规则发现冲突须隔离待核，不覆盖或假造旧业务。授权重新校验含历史/附件/下载/汇总；M19只审批，生产者决定生效；M48/M32消费契约不代生产者业务。恢复目标60分钟/240分钟/30天须核平台能力、成本和责任，不能冒已达标。

外部接口须写schema/版本/幂等键/签名信任/失败及unknown/对账/撤权状态，未配置不假成功。P2交付设计包、逐需求追踪、风险责任、可执行Given/When/Then映射、复用代码版本与迁移影响及P3任务建议；完成独立设计退出评审且获所有者批准前不得进入P3。

验收完整预期见模块包引用的用例及Scope原contract；本轮未运行，历史测试适用HEAD见[P1B_Implementation_Map.md](P1B_Implementation_Map.md)。不重复询问已批SPEC/LIMIT/BASELINE、D1–D7/E1/E2及恢复目标，新增重大选择集中提交。

[完整新窗口启动提示词](R3_P2_Start_Prompt.md)。
