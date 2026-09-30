# R2 P1→P2正式交接

生成来源：`Scope_Register.json → deliveryScope / p1Baseline / modules[].p1 / p1B`。本文是同一台账的阅读视图，不独立维护范围或验收状态。更新时间：2026-09-10T03:24:03.609414+00:00。

当前交付为用户确认的15个HR核心模块及六类非模块基础能力；原48组历史完整保留，33组本次交付暂缓，不计完成、不阻当前P1退出。各历史证据的适用时间保持。

状态：P1受限关闭，P2设计进入获准，P2尚未开始。批准：R2-P1-P2-TRANSITION-20260910。

| 模块 | 完整范围 | 批准记录 | 规格 |
|---|---|---|---|
| M37 | 标准、指标库 | M37-P1-APPROVAL-R2-20260909 | [评审基线](P1_M37_Review_Package.md) |
| M06 | 类别、级别、指标、资格标准 | M06-P1-APPROVAL-R2-20260909 | [评审基线](P1_M06_Review_Package.md) |
| M26 | 活动、人员、题库、报表 | M26-P1-APPROVAL-20260910 | [评审基线](P1_M26_Review_Package.md) |
| M18 | 标准、项目、校准会、人才池、继任 | M18-P1-APPROVAL-20260910 | [评审基线](P1_M18_Review_Package.md) |
| M17 | 盘点、人才池、继任、发展计划、健康度 | M17-P1-APPROVAL-20260910 | [评审基线](P1_M17_Review_Package.md) |
| M03 | 选拔任用、档案、考察期、述职 | M03-P1-APPROVAL-20260910 | [评审基线](P1_M03_Review_Package.md) |

六基础全部适用，范围外33模块及独立AI继续暂缓；电子签、支付、税务申报、真实测评/消息仅契约，不以供应商接通作为设计前置。不扩展模块内部登记范围。

## M37 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M37-P1-APPROVAL-R2-20260909 |
| 复用、待改及新增 | 复用当前记录ID/revision/事件快照和同版本gap；旧五anchors及引用保持legacy。；补独立库/指标/四子集/四维度与尺度组合、根/版本唯一约束、审批发布/启停与当前目录/字段/用途权限。；增量映射M06/17/18/03/26/27消费与M32指标，不合并同名对象、不新增M38全模块；P2后按批准设计实施。 |
| 验收ID | M37-REVIEW-AC01；M37-REVIEW-AC02；M37-REVIEW-AC03；M37-REVIEW-AC04；M37-REVIEW-AC05；M37-REVIEW-AC06；M37-REVIEW-AC07；M37-REVIEW-AC08；M37-REVIEW-AC09；M37-REVIEW-AC10；M37-REVIEW-AC11；M37-REVIEW-AC12 |
| 受限范围 | 原站目标权重算法、潜力/经历库深操作、行为/建议/面试子集保存、使用中改版/停用、独立审批和跨角色权限未执行；共享对象UUID/真实评测未核 |
| 残余风险 | 本项目独立审批/权限/组合算法可能不同于原站；历史迁移映射、冻结版本和多角色消费实际未验证，真实评测结果不可宣称已接通。 |
| P2/P3/P4责任 | P2完成根/版本/尺度/范围/审批与旧消费者映射设计；P3用明确授权合成数据验证并发版本、权限、停用在途、null与故障和实际消费；P4多角色、跨模块及生产权限/恢复验收。E2保持，外部真实消息/支付/签署边界不变。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-C-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/development.ts；docs/P1_Source_Observations_20260907.md；docs/delivery/Cadre_Learning_Source_Gaps.md；lib/hris/reports.ts；tests/p3-api.test.mjs；lib/hris/review-versions.ts；lib/hris/work-inbox.ts；lib/hris/development-repository.ts |
| BP-C-REQ-07 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/development.ts；docs/P1_Source_Observations_20260907.md；lib/hris/development-repository.ts；app/api/development/route.ts；app/development/workspace.tsx；tests/p3-api.test.mjs |

## M06 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M06-P1-APPROVAL-R2-20260909 |
| 复用、待改及新增 | 复用资格版本/申请/同版proof/独立非本人审核/撤销与业务日派生，保留既有数据和历史测试。；补目录、评分/评级scheme、标准审批、委员会及贡献者回避、显式有效策略、同根级别重复与关联续证。；联动M37明确版本而不合并目录；扩当前目录/材料权限、消费者有效性契约和迁移；未获P2/P3授权不改产品。 |
| 验收ID | M06-REVIEW-AC01；M06-REVIEW-AC02；M06-REVIEW-AC03；M06-REVIEW-AC04；M06-REVIEW-AC05；M06-REVIEW-AC06；M06-REVIEW-AC07；M06-REVIEW-AC08；M06-REVIEW-AC09；M06-REVIEW-AC10；M06-REVIEW-AC11；M06-REVIEW-AC12；M06-REVIEW-AC13 |
| 受限范围 | 目录重复/完整级别评级算法、发布审查/委员会、证据时效/续证/撤销及跨角色原站执行未验证；发展通道/学习地图实际关联未知 |
| 残余风险 | 独立委员会/有效期/停用在途策略可能与源不同；权限、目录范围及多版本迁移未实际运行，M37新模型未获需求批准。 |
| P2/P3/P4责任 | P2核类别/级别/方案/根版本/认证有效性及独立回避设计与迁移；P3合成跑评分/评级、委员会阈值、时效、同版证据、重复续证、事务故障及消费者；P4完整多角色与跨域权限业务验收。E2不新增人，任何内部认证不当外部许可或自动任免。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-C-REQ-02 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/qualification.ts；lib/hris/development.ts；lib/hris/development-repository.ts；app/api/qualifications/route.ts；app/qualifications/workspace.tsx；lib/hris/cadres.ts；tests/p3-api.test.mjs |
| BP-C-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/qualifications/route.ts；app/api/cadres/route.ts；lib/hris/http.ts |

## M26 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M26-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：项目/邀请/答卷/报告稳定ID、模板复制、本人有效邀请校验、低样本null、同revision事务及历史事件。；待修改固定四关系/五分制、HR默认原卷可见、低样本精确人数、零卷正式发布；待新增题库版本/组合套卷、报告授权审批、更正版本、退出与撤权处理，组织聚合防差分。；复核匿名身份映射隔离、问卷/角色/邀请/答卷版本、报告权限与聚合抑制，设计增量迁移但不执行；合成验证2/3样本边界、角色重叠、零样本、问卷改版、撤回重交、报告更正与事务/消息失败；历史测试不代当前复验 |
| 验收ID | M26-REVIEW-AC01；M26-REVIEW-AC02；M26-REVIEW-AC03；M26-REVIEW-AC04；M26-REVIEW-AC05；M26-REVIEW-AC06；M26-REVIEW-AC07；M26-REVIEW-AC08；M26-REVIEW-AC09；M26-REVIEW-AC10；M26-REVIEW-AC11；M26-REVIEW-AC12 |
| 受限范围 | 原站匿名算法、题型和套卷完整行为、答卷撤回/更正、报告开放/撤权及多角色执行未验证；本轮只读未执行新业务链。 |
| 残余风险 | 评价者身份重识别、低样本差分、跨报告推断、用途越权、问卷版本漂移及报告纠错影响。 |
| P2/P3/P4责任 | P2：复核匿名身份映射隔离、问卷/角色/邀请/答卷版本、报告权限与聚合抑制，设计增量迁移但不执行；P3：合成验证2/3样本边界、角色重叠、零样本、问卷改版、撤回重交、报告更正与事务/消息失败；历史测试不代当前复验；P4：独立多角色、敏感字段/历史/附件/下载权限、跨模块业务及生产容量/恢复验收；E2不新增访问者，管理员操作不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-C-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/feedback.ts；lib/hris/development.ts；lib/hris/development-repository.ts；lib/hris/surveys.ts；app/api/feedback/route.ts；tests/p3-api.test.mjs；docs/P1_Source_Observations_20260907.md |
| BP-I-REQ-03 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/surveys.ts；lib/hris/feedback.ts |

## M18 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M18-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：项目期间/组织、review稳定ID、绩效快照、supersedes版本链、独立复核发布、未评定null、当前权限及事务事件。；待修改固定1–3潜力/绩效轴、首次发布未独立审批、当前身份范围与快照的区分；待新增多维标准/工具、对象模板与采集状态、校准会议与参会权限、版本化九宫格、冻结样本与发布受众、池/继任消费和纠错。；核对象/采集/会议/评价版本、轴映射与边界、独立节点及来源合同、历史结果保护和迁移；合成验证边界等值、缺失、版本漂移、人员变动、校准驳回撤回/重开、会议回避和发布并发、跨池继任幂等引用 |
| 验收ID | M18-REVIEW-AC01；M18-REVIEW-AC02；M18-REVIEW-AC03；M18-REVIEW-AC04；M18-REVIEW-AC05；M18-REVIEW-AC06；M18-REVIEW-AC07；M18-REVIEW-AC08；M18-REVIEW-AC09；M18-REVIEW-AC10；M18-REVIEW-AC11；M18-REVIEW-AC12；M18-REVIEW-AC13 |
| 受限范围 | 原站启动/采集/校准会/九宫格算法/发布及跨角色行为未执行；工具计算项目来源与对象子ID、标准共享UUID未确认。 |
| 残余风险 | 错误人员评价、历史时点错置、校准利益冲突、共享泄漏、缺证被错误落格、盘点结果自动改变池或任用。 |
| P2/P3/P4责任 | P2：核对象/采集/会议/评价版本、轴映射与边界、独立节点及来源合同、历史结果保护和迁移；P3：合成验证边界等值、缺失、版本漂移、人员变动、校准驳回撤回/重开、会议回避和发布并发、跨池继任幂等引用；P4：独立多角色、敏感字段/历史/附件/下载权限、跨模块业务及生产容量/恢复验收；E2不新增访问者，管理员操作不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-C-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/development.ts；docs/P1_Source_Observations_20260907.md；docs/delivery/Cadre_Learning_Source_Gaps.md；lib/hris/reports.ts；tests/p3-api.test.mjs；lib/hris/review-versions.ts；lib/hris/work-inbox.ts；lib/hris/development-repository.ts |
| BP-C-REQ-08 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/development.ts；docs/P1_Source_Observations_20260907.md；lib/hris/review-versions.ts；lib/hris/reports.ts；lib/hris/work-inbox.ts；lib/hris/development-repository.ts；tests/p3-api.test.mjs |

## M17 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M17-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：池/成员/继任/计划稳定记录、active/closed历史、本人或有权提交与独立核验、关联学习未完成拦截、当前权限及CAS事务。；待修改固定ready/one_year/two_years准备度、成员重入缺原单、active状态与当前有效性混用；待新增规则版本化自动入出池、成员阶段/指导关系、继任起止/复核、IDP模板/阶段/动态职责、组织健康指标及当前/历史口径。；设计池规则/成员区间/继任任期、准备度词典与版本、IDP阶段职责/任务依赖、历史映射和健康指标定义；保留legacy原义；合成验证自动规则幂等/失效、出池重入、到期/离职、指导自审、阶段阻塞与替换、目标目录缺失、健康分母和审计失败 |
| 验收ID | M17-REVIEW-AC01；M17-REVIEW-AC02；M17-REVIEW-AC03；M17-REVIEW-AC04；M17-REVIEW-AC05；M17-REVIEW-AC06；M17-REVIEW-AC07；M17-REVIEW-AC08；M17-REVIEW-AC09；M17-REVIEW-AC10；M17-REVIEW-AC11；M17-REVIEW-AC12；M17-REVIEW-AC13；M17-REVIEW-AC14 |
| 受限范围 | 原站自动入出池/重入历史、继任目标目录映射与准备度算法、IDP流程UUID/节点及执行/通知/角色、组织健康公式和跨模块共享未验证。 |
| 残余风险 | 错误后备/任用暗示、自动资格变化、指导自审、历史成员区间重叠、健康指标分母偏差和敏感人才名单泄漏。 |
| P2/P3/P4责任 | P2：设计池规则/成员区间/继任任期、准备度词典与版本、IDP阶段职责/任务依赖、历史映射和健康指标定义；保留legacy原义；P3：合成验证自动规则幂等/失效、出池重入、到期/离职、指导自审、阶段阻塞与替换、目标目录缺失、健康分母和审计失败；P4：独立多角色、敏感字段/历史/附件/下载权限、跨模块业务及生产容量/恢复验收；E2不新增访问者，管理员操作不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-C-REQ-04 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/development.ts；docs/P1_Source_Observations_20260907.md；docs/delivery/Cadre_Learning_Source_Gaps.md；lib/hris/reports.ts；tests/p3-api.test.mjs；lib/hris/review-versions.ts；lib/hris/work-inbox.ts；lib/hris/development-repository.ts |
| BP-C-REQ-05 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/development.ts；docs/P1_Source_Observations_20260907.md；lib/hris/reports.ts；lib/hris/review-versions.ts；lib/hris/work-inbox.ts；lib/hris/development-repository.ts；tests/p3-api.test.mjs |

## M03 设计输入

| 维度 | 要求 |
|---|---|
| 批准版本/原文/哈希 | [批准记录](P1_Approval_Records.md)；M03-P1-APPROVAL-20260910 |
| 复用、待改及新增 | 可复用：提名/审议/调动关联核对、稳定人员与干部任期、访谈追溯、本人述职与独立核验、期间顺序/重叠保护及事务审计。；待修改主职限定、登记直生效与正式任命区分、四干部状态映射、当前归档/敏感权限；待新增选拔活动/评价表/委员会评分、完整任免期次/审批生效、考察延期/转正/退出、年度述职和奖惩档案子集。；设计干部身份/任期/人事生效/提名/任免记录映射、评分策略与委员会、考察/述职版本与当前权限、增量迁移及未知历史标记；合成验证任期月末/闰年/重叠、多评委阈值等值/弃权缺评、资格失效、调动失败/未知、考察延期退回/撤回/退出和档案撤权 |
| 验收ID | M03-REVIEW-AC01；M03-REVIEW-AC02；M03-REVIEW-AC03；M03-REVIEW-AC04；M03-REVIEW-AC05；M03-REVIEW-AC06；M03-REVIEW-AC07；M03-REVIEW-AC08；M03-REVIEW-AC09；M03-REVIEW-AC10；M03-REVIEW-AC11；M03-REVIEW-AC12；M03-REVIEW-AC13；M03-REVIEW-AC14 |
| 受限范围 | 原站任期通用日期算法、选拔多评委/阈值等值及缺评、任免/转正提交路由、免职恢复/未来离职联动及敏感档案跨角色未验证；本轮不提交实际任用/审批。 |
| 残余风险 | 错误任命或人事生效、投票分母/阈值不一致、自审利益冲突、过期资格被引用、考察期自动转正及档案敏感泄漏。 |
| P2/P3/P4责任 | P2：设计干部身份/任期/人事生效/提名/任免记录映射、评分策略与委员会、考察/述职版本与当前权限、增量迁移及未知历史标记；P3：合成验证任期月末/闰年/重叠、多评委阈值等值/弃权缺评、资格失效、调动失败/未知、考察延期退回/撤回/退出和档案撤权；P4：独立多角色、敏感字段/历史/附件/下载权限、跨模块业务及生产容量/恢复验收；E2不新增访问者，管理员操作不代验。 |

| 规格 | 对象/字段/权限/状态输入 | 源码适用证据 |
|---|---|---|
| BP-C-REQ-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | lib/hris/cadre-terms.ts；lib/hris/cadres.ts；lib/hris/cadre-interviews.ts；lib/hris/development.ts；lib/hris/development-repository.ts；app/api/cadres/route.ts；tests/p3-api.test.mjs |
| BP-C-API-01 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | app/api/qualifications/route.ts；app/api/cadres/route.ts；lib/hris/http.ts |
| BP-C-REQ-06 | Scope.p1B.packages.contracts：fieldDetails/roleMatrix/stateTransitions/acceptanceCases | docs/P1_Source_Observations_20260907.md；lib/hris/cadres.ts；lib/hris/cadre-terms.ts；lib/hris/cadre-interviews.ts；lib/hris/development.ts；lib/hris/development-repository.ts；app/api/cadres/route.ts；tests/p3-api.test.mjs |

## P2工作及退出条件

按模块顺序，完成架构复用/差异、稳定对象与版本模型、服务端行列动作授权、状态与审批/生效事务、接口契约及未知重试、迁移映射与兼容回滚、附件/审计/备份恢复设计。每条批准需求和验收ID必须映射设计与责任；缺项和互相冲突须解决或明确批准处置。核心规则不得由旧实现限制覆盖；评分尺度、缺失状态与版本冻结遵守所属模块已批方案。

数据迁移保留稳定ID、原历史及来源；按新规则发现冲突须隔离待核，不覆盖或假造旧业务。授权重新校验含历史/附件/下载/汇总；M19只审批，生产者决定生效；M48/M32消费契约不代生产者业务。恢复目标60分钟/240分钟/30天须核平台能力、成本和责任，不能冒已达标。

外部接口须写schema/版本/幂等键/签名信任/失败及unknown/对账/撤权状态，未配置不假成功。P2交付设计包、逐需求追踪、风险责任、可执行Given/When/Then映射、复用代码版本与迁移影响及P3任务建议；完成独立设计退出评审且获所有者批准前不得进入P3。

验收完整预期见模块包引用的用例及Scope原contract；本轮未运行，历史测试适用HEAD见[P1B_Implementation_Map.md](P1B_Implementation_Map.md)。不重复询问已批SPEC/LIMIT/BASELINE、D1–D7/E1/E2及恢复目标，新增重大选择集中提交。

[完整新窗口启动提示词](R2_P2_Start_Prompt.md)。
