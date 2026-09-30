# 分批开发总控入口

**当前覆盖规则（2026-09-08）：唯一当前聊天总控连续执行，H001–H004均已交还，后续分支仅保留待办。禁止按下方历史active/queued描述自动移交。最新执行约定与依赖队列见 [Controller_Resume.md](Controller_Resume.md)，每次恢复以最新检查点和实际SHA为准。**

2026-09-07 启动；当前聊天是唯一总控。组织员工→干部人才→学习→绩效→招聘→假勤→薪酬→自助/报表/集成的优先级不变。

- [范围台账](Scope_Register.md)：保留 48 组全量范围及首批原子验收项。
- [公共接口](Shared_Contracts.md)、[文件归属](Ownership.md)、[环境隔离证据](Environment_Isolation.md)。
- 交接包：[基础](modules/foundation.md)、[干部人才](modules/cadre.md)、[学习](modules/learning.md)。各包含启动提示词，无需另找模板。
- 验收：[G0](acceptance/G0.md)、[G1](acceptance/G1.md)、[G2](acceptance/G2.md)、[G3](acceptance/G3.md)、[G4](acceptance/G4.md)。
- [集成记录](Integration_Log.md)及上级目录 Execution_Checkpoint.md 为恢复入口。

本轮建立机制、派发书面工作包，不创建新聊天、不运行代理。H001基础已交付并经总控确认G0通过，H003已交还并接受，总控按H003-R接回写入，01/02/03均不再写入。新聊天先做接入检查；没有真实隔离证据前不并行写代码。

G0 是基础门槛，G1 首轮为限定业务闭环；G2/G3 是后续业务验收；G4 才是选定发布范围生产验收。完整菜单复刻不因分批而缩减。已有 E1 约15%（10%–20%）保持，文档不增加功能完成率。

下一验收入口：[G1人工业务验收清单](G1_Business_Acceptance.md)。G1自动化证据齐备不等于界面或人工业务通过。

本轮交付：[综合报告](G1_PreAcceptance_Report.md)、[用户验收指南](G1_User_Acceptance_Guide.md)、[绩效包](modules/performance.md)、[招聘包](modules/recruitment.md)。后两包仅准备，未分配写入职责。

## 最新后续模块入口
[后续规划](Next_Batches_Plan.md)、[分支与职责队列](Module_Queue.md)：04绩效active；05招聘、06假勤、07薪酬、08自助报表集成queued。各模块分支提前建立，总控统一发布。本节覆盖此前04/05尚未分配的状态。
