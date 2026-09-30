# H004 绩效管理交付

项目：appgprj_6a9e2c705cfc819180e0e5251bb025cc。复用 /workspace/sites/italent-hris，分支 delivery/performance。

接手基线：bda3ffdce577aa04592534db131c2d634f225792。Module_Queue.md/json 均为 H004 active，main 与预建分支相同，工作区干净，基线包含规划提交及参考主线469fc702e445c84c2eac334ebf13f8245cea90c5。依据现行交接直接执行，未新增项目。

应用与测试提交：`9d3d416769a7ab28945261d231e1a29eeaaf50da`。最终交付提交为包含本记录和证据的分支HEAD，由聊天给出完整SHA；可用`git log -2 delivery/performance`核对。

## 四维状态与任务证据

| 任务 | 需求核实 | 开发 | 测试 | 生产 |
|---|---|---|---|---|
| P01 周期/目标/调整/结果核对 | 仓库接口与页面核实；企业细则仍待核实 | 现有完整限定流程可复用，无需重写 | 原P3绩效场景与新增边界证据 | 未验收 |
| P02 同员工完整闭环 | 按本包限定流程独立设计 | 已有实现；本轮串联确认 | g2-performance-flow第1场景；目标V1→V2、63→87分、原结果及盘点保留 | 未验收 |
| P03 权限/版本/生命周期 | 当前权限契约＋独立安全设计 | 修复P-DEF-01，其余复用 | 新增6场景＋原116项，合计122/122通过 | 未验收 |
| P04 修复与操作交付 | 专属边界已核对 | 3个领域文件精确修复；无迁移/接口字段变化 | 类型检查与构建见验证记录；指南为代码核对，非浏览器验收 | 未验收 |

## P01 接口与状态映射

全部写入使用 `{revision, command}`，成功 `{id, revision}`。权限在服务端按当前组织重新检查；保存沿用CAS、历史及审计事务，不自动重试旧请求。

| 入口 | 命令 / 关系 | 现有约束与复用证据 |
|---|---|---|
| /api/performance | cycle → startCycle → closeCycle | 草稿→active→closed；关闭前计划全部已发布或取消；真实日期、开始不晚于结束、阈值和评级名称校验 |
| /api/performance | goals → confirmGoals → selfReview → evaluate → publishPerformance | 目标权重100%、同员工同周期唯一计划；本人自评；其他管理者确认/评价，HR或admin发布；结果冻结目标和阈值 |
| /api/performance-changes | request / review / withdraw；referenceId=planId | 调整保存原目标、basePlanVersion、basePlanUpdatedAt；非本人且非申请人复核；批准时调整与计划原子保存，计划版本+1 |
| /api/performance-checkins | submit / feedback / withdraw；referenceId=planId | 跟进冻结目标与版本；自报100%不是正式得分，也不是强制自评门槛；旧版记录不自动转认新版进展 |
| /api/performance | appeal / withdrawAppeal / reviewAppeal / publishCorrection | 申诉referenceId=原结果；更正supersedes=原结果、appealId=申诉；保留sourcePlanId；复核不能是原评价/发布人，发布不能是本次复核人 |
| /api/development?id=ID | 历史分页与当前权限投影 | 本人计划历史不泄露未发布评分；调出旧组织后旧管理者连历史也拒绝；停用账号拒绝读取和写入 |
| /api/reports?dataset=performance；/api/cadre-profiles?employeeId=ID | 最新绩效消费者 | 原代码已过滤被替代结果；新链路实际检查仅最新结果87分/更正ID；已发布盘点仍保留原63分快照 |

已有P3场景明确覆盖：正式绩效；绩效申诉独立复核及历史隔离；目标调整权限撤销/CAS/旧版本；目标跟进返回、旧版及审计回滚；绩效办理报表与自助待办。本次保持这些测试原样，不以测试数量宣称全量覆盖。

## P-DEF-01：人员变化后仍可推进旧周期

修复前在基线代码运行新增生命周期测试，exit及transfer两场景均在confirmGoals收到200（预期400），2/2失败。通过真实合成人事申请与独立审批改变员工状态/组织，没有直接改库伪造人员状态。

根因：performance.ts的cycle检查只有周期active，未检查当前员工在职与周期组织范围；调整/跟进有在职检查，但管理员可见两个组织，仍能越过原周期组织边界。

修复：performance.ts的活动计划检查加入当前员工状态与orgWithin；performance-changes.ts、performance-checkins.ts复用orgWithin，统一原周期组织范围。覆盖确认、自评、评价、退回、发布、申请/批准调整与跟进反馈。无权限仍403，管理员虽有可见权限但业务范围已无效时400。拒绝不递增revision。

保留：当前权限历史读取、待审调整拒绝/本人撤回、未发布计划取消、周期关闭、已发布历史结果独立申诉更正。新增exit/transfer历史更正场景各自通过；人员离职不自动停用账号，显式停用仍按C-DEF-01执行。新测试检查停用200、员工关联保留、3个绩效API读写403；原C-DEF-01完整回归未改且通过。

该修复对齐已有“在职、当前周期范围”的业务前置校验，是独立安全设计，不声明原站企业对离职结算或调动绩效归属的制度已核实。

## 验证与复现

- 快速模块复现：`node --test tests/g2-performance-flow.test.mjs tests/g2-performance-lifecycle.test.mjs`，6/6通过。
- 集成：G2_performance_Test_Result.json记录完整11文件命令，122/122，0失败/跳过；原116项包含C-DEF-01、G0/G1、P2/P3权限和学习回归。
- 完整输出：G2_performance_Test_Output.tap，其中H004_CHAIN保存该次合成链全部ID和63→87分结果。每次内存数据库重建，ID会变化。
- 输出/源码SHA256及验证命令：G2_performance_Verification.json。测试输出哈希也单列于Test_Result.json。
- 类型检查：`node node_modules/typescript/bin/tsc --noEmit --incremental false`，结果见G2_performance_Typecheck.txt。
- 构建：使用Sites标准build-site.mjs，结果见G2_performance_Build.txt。无发布。

## 遗留、消费者建议与总控接回

1. 周期start/end目前是日期标签及合法性校验，实际启停由命令控制，不随日历自动冻结。日期范围外补录、申诉时限、离职后未发布绩效结算、调动前后目标拆分需企业规则；本批未加入未经核实的定时任务或例外通道。
2. 页面现有按钮及自助/办理报表按原状态推导，尚未全面表达新增的“调出原周期范围后冻结”条件。服务端拒绝为权威，按钮可见不代表可办理。总控/08后续可在work-inbox.ts、reports.ts及自助消费者的绩效可办谓词加入当前员工在职和orgWithin(state,e.orgId,cycle.payload.orgId)；保留历史数量、取消和历史更正入口，禁止修改当前权限以使办理通过。未擅改共享保留路径。该展示一致性项不影响后端拒绝或其他模块独立推进。
3. 原站绩效制度、组织绩效、完整OKR、多级校准与申诉时限继续后续；没有新增自动业务决策。
4. 本次没有浏览器或真实多账号UAT。测试用身份只存在于内存替身；不可作为线上登录账号。G1界面环境阻塞未在本批处理，G2整体与生产未签署。

限定P01–P04技术交付完成，已知展示和企业规则限制如上。04在本交付提交完成后明确交还唯一代码写入职责给总控，不继续应用写入；总控核对提交、范围、验证证据后负责集成和H005激活。未推送main、未合并其他分支、未发布，未修改Ownership/Module_Queue/Scope_Register/Execution_Checkpoint。建议总控记录H004接回、P-DEF-01修复及以上遗留，再更新下一模块激活基线。
