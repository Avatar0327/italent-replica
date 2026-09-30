# 模块闭环字段与看板读取约定

生成来源：`Scope_Register.json → deliveryScope / p1Baseline / modules[].p1 / p1B`。本文是同一台账的阅读视图，不独立维护范围或验收状态。更新时间：2026-09-10T03:24:03.609414+00:00。

当前交付为用户确认的15个HR核心模块及六类非模块基础能力；原48组历史完整保留，33组本次交付暂缓，不计完成、不阻当前P1退出。各历史证据的适用时间保持。

本轮仅事实源和文档生成调整；不改独立看板界面、不发布。独立看板消费这些同源字段，不能写回另一套状态。

| 事实源路径（Scope_Register.json） | 读取含义 |
|---|---|
| deliveryScope.rangeLayers / moduleExecutionOrder | R1–R4分区及确切顺序；保留原48组，R4的33组暂缓，不计为已完成 |
| roadmap.executionPolicy | 唯一主模块、最多1备用、实际执行焦点、启用依据、返回条件和焦点历史 |
| roadmap.executionPolicy.r3ReviewPipeline / p1B.r3ReviewBundle | R3串行材料顺序、等待队列与30项集中推荐/5LIMIT；当前已完成待评审，不计关闭 |
| roadmap.executionPolicy.nightReviewPipeline / p1B.r2ReviewBundle | 本轮材料准备顺序、完成及等待队列、正式关闭顺序和同源集中决定索引；准备不等关闭或转序 |
| deliveryScope.baseCapabilities[].r2Assessment | R2基础适用差异及用例引用；不自动继承R1批准 |
| p1Baseline.dataValidation.readOnlyRechecks | 旧未知结果的只读后续证据、精确前后快照及剩余未知；不改原operations历史 |
| modules[].p1.closureChecklist | 完整原登记范围逐项：需求、证据、缺口、阻塞性、关闭方式、判据；不是另一个任务分母 |
| modules[].p1.reviewPackage | 模块集中阅读包的唯一原始内容；材料已完成待评审不等签署 |
| p1B.reviewIssues | 业务建议、备选及影响唯一待决记录；decision为空不能展示已批准 |
| p1B.approvalRecords | 用户明确批准的版本、文档哈希、推荐原文及哈希、范围、例外与排除项；批准不外推到其他模块 |
| modules[].p1.moduleClosure.p1AConclusion / p1BConclusion | 分别显示五类结论；通过须approvalRecord，受限须scope/residualRisk/revalidation/record |
| modules[].p1.moduleClosure.conditions | 四个转序条件的value及basis；null=待判定，false=未满足，不能改为通过 |
| modules[].p1.moduleClosure.transitionReview | 转序批准必须approved=true、record、scope、approvedAt齐备；不等生产上线批准 |
| roadmap.rangeGates | 该R的适用基础能力及版本评审；满足后无需等待后续R全部P1完成 |
| roadmap.rangeGates[].downstream / p2Handoff | 指定下阶段授权与P2/P3实际结论分开；R1本次仅P2设计，交接按批准记录和需求引用生成 |
| deliveryScope.baseCapabilities[].r1Assessment / r1RequirementApproval / recoveryTargets | 六基础R1适用批准及恢复目标；不加模块分母，不将目标当云端能力实证 |
| modules[].p1.currentDeliveryAssessment | 15模块P1A完成/P1B就绪/评审通过的既有计数口径，历史tested等字段不能替代 |
| p1Baseline.currentRun | 恢复点、编辑基准HEAD、浏览器阻塞、最近已核实同步及下一步；实际HEAD/工作区须采集Git |
| p1Baseline.dataValidation.records / operations | 合成对象、关联、每次动作及结果；未知状态不能转成成功或重复提交 |

## 派生文件与转序计算

[P1_Module_Closure.json](P1_Module_Closure.json)由scripts/render-p1-baseline.py生成。primaryModuleId/backupModuleId/activeExecutionModuleId直接取执行策略；modules[].transitionReady须四条件、两阶段批准及转序批准均满足；ranges[].transitionReady另要求本R全部模块、适用基础能力及范围评审。missingConditions给出尚缺条件。禁止手改派生布尔值。

completeCount和restrictedCount分别是P1A完整通过、受限通过计数；progress.p1A/p1B/review各含full、restricted、total，明确分类后可显示合计；p1ClosedCount为模块P1关闭总数；transitionReadyCount独立统计。15模块分母保持，基础六类另列。结论枚举为：完整通过、受限通过、已完成待评审、进行中、受阻。

## 快照和历史证据

看板快照应同时读取同一次主仓库Git HEAD、git status --porcelain及来源文件；如有未提交变更须显著标注，不能称为该HEAD已提交内容。generatedFromUpdatedAt是事实台账更新时间，不是看板采集时间；快照时间由采集方记录。部署适用版本读取实际部署证据，不从当前HEAD推断。历史技术测试保留原提交/版本，不能自动继承为本轮复验、P1通过或业务/生产验收。

生成与检查命令：`python scripts/render-p1-baseline.py`，随后`python scripts/check-p1-baseline.py`。看板构建/发布失败不改变主仓库执行队列，也不阻塞其开发/部署链。
