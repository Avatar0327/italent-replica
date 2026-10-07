# R1 底座 AC 覆盖报告与端到端验收（F-024，DEC-221③）

> 版本：v1.1（2026-10-07，Claude 开发窗口 / Fable 5.1；按 astra 首审第二轮修改清单修订：补 AC-TRF-24～27、AC-PRM-27 / 28 真实场景、AC-TRF-09 证据、DEC-226 / 227 口径、F-026）。
> 本报告只核对覆盖情况，**不改变任何 AC 口径**；AC 原文以 `docs/05_验收/01_验收场景与追溯表.md` 及各规格 §AC 节为准。

## 1. 验收基线与范围

| 项目 | 内容 |
|---|---|
| 基线提交 | `origin/main` **0dd7af5**（RP-068 之后，R1 底座 19/19 已合并）；第二轮修改已合并 main **0504d88**（DEC-226 / 227、F-026 登记，只有文档改动） |
| **未包含的在途 PR** | **#79 F-018**（带编调动，DEC-181）与 **#83 F-007**（组织改名 / 改行政上级联动任职，DEC-137）。两者都改调动与任职链路，本次端到端用例**不含**带编调动与组织联动场景；相关用例在 §2.3 标为“待 #79 / #83 合并后补跑”。审查期间若二者合并，本 PR 合并 main 后重跑端到端用例并更新本报告 |
| 对象 | 路线图 R1 阶段“对应验收”所列 AC（AC-EMP-01~11、AC-FWD-01~12、AC-TRF-01~23、AC-PRM-01~08、AC-ORG-01~09；2026-09-30 新增 AC-TRF-30~32、AC-APV-13~17、AC-PRM-29、AC-TEN-05~06、AC-ORG-12、AC-JOB-06）＋ R1 各任务新增的 AC（见 §3.2） |
| 自动化证据来源 | `tests/acceptance/*.test.ts`（PGlite 离线全量；真 PostgreSQL 16 以 CI 的 `test:pg` 作业为准）；本任务新增 `AC-R1-E2E-*.test.ts` |
| 执行方式 | `pnpm test`（PGlite）全量；`bash scripts/test-pg.sh tests/acceptance/AC-R1-E2E-*.test.ts`（容器内 PG 16） |

## 2. 端到端验收测试（新增）

文件：`tests/acceptance/AC-R1-E2E-support.ts`（夹具）、`AC-R1-E2E-01-transfer-closure.test.ts`（主线）、`AC-R1-E2E-02-branches.test.ts`（分支）。

原则：**全程真实授权器、真实身份**，不注入替身绕过权限。员工本人只有账号绑定（R1-T13 自动自助身份）；审批人与异常管理员只授“任职记录字段可见”身份、不带数据范围（DEC-057）；范围内 / 范围外 HR 持完整任职记录身份与各自数据范围；审计员为日志审计管理员 + 字段可见身份 + 数据范围。组织、入职、流程发布等前置数据经 R1-T07 既有夹具（可信装配）建立。定时任务经平台入口 `runEmploymentActivations` 按注入的 UTC 时钟运行（DEC-056）。

### 2.1 主线 E2E-01（6 步，每步断言业务结果）

| 步骤 | 内容 | 核对的 AC / DEC |
|---|---|---|
| 1 员工发起 | 员工本人预览（表单 = HR 同一张，新经理随新部门带出）→ 提交本人调动申请 → 匹配到已发布调动流程，首节点待办在调出部门负责人、不在本人；“我的申请”显示审批中；版本链不新增 | AC-TRF-01/37/45、DEC-205/209、DEC-017/058、DEC-125 |
| 2 逐节点审批 | 调出负责人 → 调入 HRBP → 调入负责人依次同意（各自真实身份）；审批人不能借审批读员工任职（403/404）；实例 approved；业务单停在「审批通过」、`record = null`、生效结果 pending；员工侧“我的申请”= 通过；任职列表含在途行且入职记录结束日不截断 | AC-APV-01/02、AC-PRM-29、AC-TRF-06、AC-TRF-38 |
| 3 定时生效 | 北京时间 10-14 23:30 不生效；10-15 01:15（UTC 10-14 17:15）生效；版本链 +1、前一条止于 10-14；未改字段（place）继承上一条；恰一条当前生效；“变更前”从版本链上一条取；重复运行不重复生效 | AC-TRF-06/32、AC-EMP-01/05/11、硬规则 2/3、DEC-056 |
| 4 向后更新 + 同日顺序 | HR 补录 10-10 调动改地点：预览列出 10-15 记录的 place 变化、部门不匹配不替换；保存后 10-15 记录 place 被替换、前一条重链为补录记录；同日再保存直接转正：排在调动之后、当前任职为转正、变更前取同日前一条 | AC-FWD-01/02/03/14、AC-EMP-13、DEC-108 |
| 5 各侧可见 | 员工自助任职列表含全部记录、我的申请只列本人单；调入部门负责人的团队成员含该员工、调出部门负责人不再含；范围内 HR 列表与版本链可见；范围外 HR 列表不含、员工 / 任职 / 业务 / 记录详情一律 404、调动入口不可写 | AC-TRF-42、AC-PRM-03/04/12、DEC-177、AC-TRF-44 |
| 6 审计 | 范围内审计员看到员工发起（操作人 = 员工）、系统生效（操作人为空、事件时间 UTC 10-14 17:15 = 租户时区 10-15）、向后更新（place 变化）三类日志；范围外审计员列表为空、详情 404 | AC-AUD-01/04、DEC-197 |

### 2.2 分支 E2E-02

| 分支 | 内容 | 核对的 AC / DEC |
|---|---|---|
| 一 经理发起他人调动 | 纯经理（调出部门负责人）为负责组织内员工发起调往下级组；首节点解析为本人 → 自审跳过、转异常管理员；调入组无 HRBP → 异常管理员；下级组负责人审批；到期生效后仍在其团队内，直线经理随新部门负责人带出 | AC-TRF-02/40/41、AC-APV-04/15、DEC-058/068 |
| 二 带联动的调动 | HR 发起带“下属转交”（R1-T10）与“新增下属”（R1-T09）的调动：审批通过后联动不执行（联动视图 executedAt 为空）；到期生效同事务改写原下属与新增下属的直线经理，转交记录 succeeded；审计员可见；有联动时拒绝删除（409） | AC-LNK-01/03、AC-TRF-15、AC-TRF-10、DEC-012/172 |
| 三 驳回后撤回再提交 | 调入负责人驳回 → 实例 returned、业务 rejected；HR 撤回到草稿（任职不变）→ 修改地点 → 再提交：沿用原实例与原流程版本、从首节点重新流转（DEC-103），日志含 reject / withdraw；重新走完审批后字段为修改后值 | AC-TRF-28、AC-APV-16、DEC-103 |
| 四 撤销与删除 | 撤销审批中申请 → voided、实例 cancelled、版本链不变、定时任务不落地、作废后只能删除；范围外 HR 不能删除。已生效调动删除后前一条恢复“至今”；其后有在途申请时拒绝（409）、撤销后可删；删除日志带快照 | AC-TRF-07/08/36、AC-AUD-02、DEC-126 |
| 五 迟到执行 / 迟到审批 | 定时任务迟到：生效日改为实际执行日 10-23，原计划日 10-20 保留在审计；审批通过时已过计划日：当天生效、生效日 = 批准日，不倒签 | DEC-186/195 |
| 七 经理身份自动取得与回收 | 普通员工甲无经理入口（403）；下属的直线经理改为甲并生效 → 甲自动取得经理自助身份（工作台 200，团队按负责组织取数为空，AC-TRF-44 口径）；最后一名下属改由他人管理并生效 → 甲入口回收（403），他人取得；甲显式授予的字段可见身份不受影响 | AC-PRM-27/28、DEC-020、Q-M0-71 |
| 六 跨租户隔离 | 外租户 HR 用本租户员工 / 业务 / 实例 ID 请求 403/404、审计为空、删除 404；外租户员工自助读本租户员工 403；本租户员工带外租户头 403；组织列表不含外租户组织；定时任务按租户运行互不触碰 | AC-TEN-01/02、AC-TRF-44、硬规则 7 |

### 2.3 待 #79 / #83 合并后补跑

| 场景 | 依赖 | 现状 |
|---|---|---|
| 带编调动：保存即执行，调入方组织 +1 / 调出方 −1，审批与定时生效路径一致 | #79 F-018（DEC-181） | 基线上带编调动仍为 503 `WITH_ESTABLISHMENT_UNAVAILABLE`（`AC-TRF-31-establishment.test.ts` P3-4）；端到端用例以 `it.todo` 登记 |
| 组织改名 / 改行政上级联动任职：全称与版本随之变化，员工与经理侧可见 | #83 F-007（DEC-137） | 基线无此能力（AC-ORG-11 只覆盖全称按当天上级名称解析）；端到端用例以 `it.todo` 登记 |

### 2.4 执行结果

| 环境 | 结果 |
|---|---|
| PGlite（`pnpm vitest run tests/acceptance/AC-R1-E2E-*.test.ts`） | 15 项通过，2 项 todo（§2.3） |
| 真 PostgreSQL 16（容器内 `scripts/test-pg.sh`，两个端到端文件） | 15 项通过、2 项 todo（2026-10-07 本地 PG 16，第二轮）；CI 的 `test:pg` 作业为准 |
| 全量 `pnpm test` | 见 PR 描述“验证结果” |

## 3. AC 覆盖核对

状态口径：**已覆盖** = 有自动化用例直接断言该 AC 的预期结果；**部分覆盖** = 自动化只覆盖 AC 的一部分分支或口径；**未覆盖** = 没有自动化用例。“建议”分三类：补测 / 已由 DEC 改口径 / 待取证。测试文件均在 `tests/acceptance/`。

### 3.1 路线图 R1“对应验收”所列 AC

#### A. 任职记录与字段继承（AC-EMP-01~11）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-EMP-01 | `AC-EMP-core.test.ts`、`AC-EMP-state.test.ts`；端到端 E2E-01 步骤 3 | 已覆盖 | — |
| AC-EMP-02 | `AC-EMP-inheritance-matrix.test.ts`（用例 `AC-EMP-02`） | 已覆盖 | — |
| AC-EMP-03 | `AC-EMP-inheritance-matrix.test.ts`（`AC-EMP-03只读` / 隐藏） | 已覆盖 | — |
| AC-EMP-04 | `AC-EMP-inheritance-matrix.test.ts` | 已覆盖 | — |
| AC-EMP-05 | `AC-EMP-inheritance-matrix.test.ts`；E2E-01 步骤 3（place 继承） | 已覆盖 | — |
| AC-EMP-06 | `AC-EMP-core.test.ts`（重聘不继承、StaffID 更新） | 已覆盖 | — |
| AC-EMP-07 | `AC-EMP-core.test.ts`（实习转正不换周期） | 已覆盖 | — |
| AC-EMP-08 | `AC-EMP-inheritance-boundaries.test.ts` | 已覆盖 | — |
| AC-EMP-09 | `AC-EMP-core.test.ts`（离职生效日 = D+1） | 已覆盖 | — |
| AC-EMP-10 | `AC-EMP-inheritance-boundaries.test.ts` | 已覆盖 | — |
| AC-EMP-11 | `AC-EMP-core.test.ts`、`AC-EMP-DEC-077.test.ts`、`AC-EMP-uncertain-boundaries.test.ts`；E2E-01 步骤 3 / 4 | 已覆盖 | — |

#### B. 向后更新（AC-FWD-01~12）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-FWD-01 | `AC-FWD-01-07-12.test.ts`（`AC-FWD-01/02`）、`AC-FWD-platform.test.ts`、`AC-FWD-state.test.ts`；E2E-01 步骤 4 | 已覆盖 | — |
| AC-FWD-02 | `AC-FWD-01-07-12.test.ts`（`AC-FWD-01/02` 不匹配记录保留）；E2E-01 步骤 4（部门不匹配不替换） | 已覆盖 | — |
| AC-FWD-03 | `AC-FWD-01-07-12.test.ts`（`AC-FWD-03`） | 已覆盖 | — |
| AC-FWD-04 | `AC-FWD-01-07-12.test.ts`（停用部门不向后更新） | 已覆盖 | — |
| AC-FWD-05 | `AC-FWD-01-07-12.test.ts`、`AC-FWD-rules.test.ts` | 已覆盖 | — |
| AC-FWD-06 | `AC-FWD-01-07-12.test.ts`、`AC-FWD-06-DEC-107.test.ts`、`AC-FWD-rules.test.ts` | 已覆盖 | — |
| AC-FWD-07 | `AC-FWD-01-07-12.test.ts`（是否部门负责人不自动向后更新） | 已覆盖 | — |
| AC-FWD-08 | `AC-FWD-08-11.test.ts`、`AC-FWD-import.test.ts` | 已覆盖 | — |
| AC-FWD-09 | `AC-FWD-08-11.test.ts`（批量编辑不触发） | 已覆盖 | 追溯表标 ⏸（原站无法构造），复刻系统已按口径自动化 |
| AC-FWD-10 | `AC-FWD-08-11.test.ts`（批量导入编辑模式触发） | 已覆盖 | — |
| AC-FWD-11 | `AC-FWD-08-11.test.ts`（兼职不触发） | 部分覆盖 | 兼职任职模块（R2-T05）未上线，用例以主职 / 兼职标志验证规则；建议 R2-T05 后补跑真实兼职记录 |
| AC-FWD-12 | `AC-FWD-01-07-12.test.ts`（DEC-041 默认值取插入点前一条） | 已覆盖 | — |

#### C. 调动闭环（AC-TRF-01~23、30~32）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-TRF-01 | `AC-TRF-01-37-45-self-service.test.ts`、`AC-TRF-01-03-19-25-access.test.ts`、`AC-TRF-03-30-hr-form.test.ts`、`AC-TRF-163-required.test.ts`；E2E-01 步骤 1 | 已覆盖 | — |
| AC-TRF-02 | `AC-TRF-02-40-44-manager.test.ts`、`AC-TRF-02-manager-approval.test.ts`、`AC-TRF-01-03-19-25-access.test.ts`；E2E-02 分支一 | 已覆盖 | — |
| AC-TRF-03 | `AC-TRF-01-03-19-25-access.test.ts`（`AC-TRF-03/19/24`）、`AC-TRF-03-30-hr-form.test.ts`、`AC-TRF-03-process-binding.test.ts` | 已覆盖 | — |
| AC-TRF-04 | `AC-TRF-04-05-06-scheduled.test.ts` | 已覆盖 | — |
| AC-TRF-05 | `AC-TRF-04-05-06-scheduled.test.ts`、`AC-APV-TRF-11-12-21.test.ts`；E2E-02 分支五（迟到审批即生效） | 已覆盖 | — |
| AC-TRF-06 | `AC-TRF-04-05-06-scheduled.test.ts`、`AC-TRF-31-activation-failure.test.ts`；E2E-01 步骤 2 / 3 | 已覆盖 | 原站“提交即写入版本链”为有意差异（DEC-125），复刻按申请单承载 |
| AC-TRF-07 | `AC-TRF-07-10-36-revoke-delete.test.ts`；E2E-02 分支四 | 已覆盖 | — |
| AC-TRF-08 | `AC-TRF-07-10-36-revoke-delete.test.ts`、`AC-TRF-08-36-delete-round2/3.test.ts`、`AC-TRF-08-job-history.test.ts`、`AC-TRF-F017-projection.test.ts`；E2E-02 分支四 | 已覆盖 | — |
| AC-TRF-09 | `AC-LNK-round4.test.ts`（“合同变更执行后删除 409 且无副作用；HR 再次变更该合同后可以删除”，真实合同端口）、`AC-TRF-07-10-36-revoke-delete.test.ts`（探针用例） | 已覆盖 | — |
| AC-TRF-10 | `AC-TRF-07-10-36-revoke-delete.test.ts`；E2E-02 分支二（真实下属转交后删除 409） | 已覆盖 | — |
| AC-TRF-11 | `AC-APV-TRF-11-12-21.test.ts` | 已覆盖 | — |
| AC-TRF-12 | `AC-APV-TRF-11-12-21.test.ts` | 已覆盖 | — |
| AC-TRF-13 | `AC-TRF-13-14-15-26-linkage.test.ts` | 已覆盖 | — |
| AC-TRF-14 | `AC-TRF-13-14-15-26-linkage.test.ts` | 已覆盖 | — |
| AC-TRF-15 | `AC-TRF-13-14-15-26-linkage.test.ts`、`AC-TRF-15-lock-order-pg.test.ts`、`AC-TRF-F017-handover-pg.test.ts`；E2E-02 分支二 | 已覆盖 | — |
| AC-TRF-16 | — | 未覆盖 | 薪资档案与 `*Adjusted` 字段不在首版范围，调动只记“是否调薪”标志并生成待调薪提醒（**DEC-002**，AC-LNK-05 已覆盖该口径）。建议：已由 DEC 改口径，薪酬模块上线前不补测 |
| AC-TRF-17 | — | 未覆盖 | 同 AC-TRF-16（DEC-002，已由 DEC 改口径） |
| AC-TRF-18 | `AC-TRF-18-configuration.test.ts`、`AC-TRF-03-30-hr-form.test.ts` | 已覆盖 | — |
| AC-TRF-19 | `AC-TRF-01-03-19-25-access.test.ts`（标准表单默认放开目标部门） | 已覆盖 | — |
| AC-TRF-20 | `AC-TRF-01-03-19-25-access.test.ts`（`settings(false)` 用例）、`AC-TRF-18-configuration.test.ts` | 已覆盖 | — |
| AC-TRF-21 | `AC-APV-TRF-11-12-21.test.ts` | 已覆盖 | — |
| AC-TRF-22 | — | 未覆盖 | 移动端不在首期范围（**DEC-007** 仅 PC）。建议：已由 DEC 改口径，移动端立项后再测 |
| AC-TRF-23 | — | 未覆盖 | **DEC-226 不复刻**：复刻的人事申请按钮由系统预置（`Transfer.Self` / `Transfer.Manager`），不按描述筛选，反向验证无对象；将来做可配置表单 / 按钮时再补。已由 DEC 改口径 |
| AC-TRF-24（`13` §4.1：开关 31 开 + 标准表单 → 调动后部门可选全公司） | `AC-TRF-01-03-19-25-access.test.ts`（“AC-TRF-03/19/24：标准表单默认放开目标部门”）、`/transfers/departments` 候选 | 已覆盖 | 定义在 `docs/02_业务建模/13` §4.1，集中追溯表漏列（OBS-01） |
| AC-TRF-25（`13` §4.1：开关 31 开 + 自定义表单 → 仍受权限控制） | `AC-TRF-01-03-19-25-access.test.ts`（“AC-TRF-25：自定义表单在开关开启时仍受目标部门范围约束”） | 已覆盖 | 同上 |
| AC-TRF-26（`13` §4.1：开关 98 开，调动时调整组织角色 → 组织生成一条组织变更记录） | `AC-TRF-13-14-15-26-linkage.test.ts`（负责人 / 店长经组织版本写入、后续任职标志生效时补写）、`AC-LNK-01-06.test.ts`（组织角色转交） | 部分覆盖 | 组织角色变更经组织模块追加版本已验证；“组织变更记录”对象结构与开关 98 的产物未取证（`13` §5 G-023），复刻未单独建模。建议：待取证 |
| AC-TRF-27（`13` §4.1：开关 95 开但“任职信息联动薪资范围”未开 → 薪资显示范围设置不生效） | — | 未覆盖 | 薪资档案与薪资显示范围不在首版范围（**DEC-002** 调动只记调薪标志）；开关依赖声明 G-024 未取证。已由 DEC 改口径，薪酬模块上线前不补测 |
| AC-TRF-30 | `AC-TRF-03-30-hr-form.test.ts` | 已覆盖 | — |
| AC-TRF-31（含 R1-T08 失败框架段与 R1-T09 真实编制段，计 1 条） | 失败框架段：`AC-TRF-31-activation-failure.test.ts`、`AC-TRF-31-permission.test.ts`、`AC-TRF-13-14-15-26-linkage.test.ts`（联动失败重试）、`AC-TRF-31-LNK-linkage-failure.test.ts`；真实编制段：`AC-TRF-31-establishment.test.ts` | 已覆盖 | 带编调动分支待 #79（§2.3） |
| AC-TRF-32 | `AC-TRF-32-AC-TEN-05-timezone.test.ts`、`AC-TEN-05.test.ts`；E2E-01 步骤 3 / 6 | 已覆盖 | — |

#### D. 权限与数据范围（AC-PRM-01~08、29）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-PRM-01 | `AC-PRM-01.test.ts` | 已覆盖 | — |
| AC-PRM-02 | — | 未覆盖 | **DEC-227 并入 AC-PRM-24**：原站“菜单上下文鉴权”是原站实现细节，复刻统一按后端对象权限判断，不存在“带菜单上下文才放行”的路径（`AC-PRM-01.test.ts` 已证明无身份即拒绝）。已由 DEC 改口径，覆盖以 AC-PRM-24 为准 |
| AC-PRM-03 | `AC-PRM-employment-scope.test.ts`、`AC-PRM-scope-resolution.test.ts`、`AC-PRM-org-job-est-wiring.test.ts`（`hasDataPermission` 区分无数据）；E2E-01 步骤 5 | 已覆盖 | — |
| AC-PRM-04 | `AC-PRM-34.test.ts`、`AC-PRM-35.test.ts`、`AC-PRM-scope-resolution.test.ts`（含下级）；E2E-01 步骤 5 | 已覆盖 | — |
| AC-PRM-05 | `AC-PRM-34.test.ts`（“范围为 R 不含下级时仍看不到 D 下员工”）、`AC-PRM-employment-scope.test.ts`（`includeDescendants: false`） | 已覆盖 | — |
| AC-PRM-06 | `AC-PRM-data-scope-admin.test.ts`（“每应用范围独立”）、`AC-PRM-scope-resolution.test.ts`（app separation） | 已覆盖 | — |
| AC-PRM-07 | `AC-PRM-07.test.ts`（功能权限并集）、`AC-PRM-scope-resolution.test.ts`（范围并集） | 已覆盖 | — |
| AC-PRM-08 | `AC-PRM-08.test.ts`、`AC-PLT-platform-ops.test.ts` | 已覆盖 | — |
| AC-PRM-29 | `AC-APV-PRM-29.test.ts`、`AC-PRM-employment-scope.test.ts`（DEC-057）；E2E-01 步骤 2 | 已覆盖 | — |

#### E. 组织对象（AC-ORG-01~09、12）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-ORG-01 | `AC-ORG-01-09.test.ts`、`AC-ORG-write-safety.test.ts` | 已覆盖 | — |
| AC-ORG-02 | `AC-ORG-01-09.test.ts` | 已覆盖 | — |
| AC-ORG-03 | `AC-ORG-01-09.test.ts` | 已覆盖 | — |
| AC-ORG-04 | `AC-ORG-01-09.test.ts`、`AC-ORG-05.test.ts` | 已覆盖 | — |
| AC-ORG-05 | `AC-ORG-05.test.ts` | 已覆盖 | — |
| AC-ORG-06 | `AC-ORG-01-09.test.ts` | 已覆盖 | — |
| AC-ORG-07 | `AC-ORG-01-09.test.ts`、`AC-ORG-hierarchy-contract.test.ts`、`AC-ORG-version-safety.test.ts` | 已覆盖 | — |
| AC-ORG-08 | `AC-ORG-01-09.test.ts` | 已覆盖 | — |
| AC-ORG-09 | `AC-ORG-01-09.test.ts` | 已覆盖 | — |
| AC-ORG-12 | `AC-ORG-12.test.ts` | 已覆盖 | — |

#### F. 审批中心新增（AC-APV-13~17）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-APV-13 | `AC-APV-01-04-13-15-routing.test.ts`、`AC-APV-05-09-18-19-versions.test.ts`（发布校验） | 已覆盖 | 原站首节点运行行为仍 🟡 待取证（追溯表“执行前必须补齐的取证”），不影响复刻验收 |
| AC-APV-14 | `AC-APV-14-16-17-20-actions.test.ts`、`AC-APV-14-fields.test.ts` | 已覆盖 | — |
| AC-APV-15 | `AC-APV-01-04-13-15-routing.test.ts`；E2E-02 分支一 | 已覆盖 | — |
| AC-APV-16 | `AC-APV-14-16-17-20-actions.test.ts`；E2E-02 分支三（驳回意见） | 已覆盖 | — |
| AC-APV-17 | `AC-APV-14-16-17-20-actions.test.ts` | 已覆盖 | — |

#### G. 多租户与职务（AC-TEN-05~06、AC-JOB-06）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-TEN-05 | `AC-TEN-05.test.ts`、`AC-TRF-32-AC-TEN-05-timezone.test.ts` | 已覆盖 | — |
| AC-TEN-06 | `AC-TEN-06.test.ts`、`AC-TEN-06-restore-safety.test.ts`、`AC-TEN-06-restore-approval.test.ts` | 部分覆盖 | 恢复三阶段、隔离校验、授权对账、不重放审批已自动化；RPO ≤ 1h / RTO ≤ 4h、保留 30 天与加密须部署环境就绪后演练（追溯表原口径）。建议：部署环境就绪后补演练 |
| AC-JOB-06 | `AC-JOB-01-02-04-06.test.ts`、`AC-JOB-tree-safety.test.ts` | 已覆盖 | — |

### 3.2 R1 各任务新增的 AC

#### 任职 / 向后更新 / 调动（AC-EMP-12~16、AC-FWD-13~15、AC-TRF-28/29/33~46）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-EMP-12 | `AC-EMP-12-personnel.test.ts` | 已覆盖 | — |
| AC-EMP-13 | `AC-EMP-13-14.test.ts`；E2E-01 步骤 4 | 已覆盖 | — |
| AC-EMP-14 | `AC-EMP-13-14.test.ts` | 已覆盖 | — |
| AC-EMP-15 | `AC-EMP-15.test.ts`、`AC-EMP-15-approval.test.ts`、`AC-TRF-08-36-delete-round2.test.ts` | 已覆盖 | — |
| AC-EMP-16 | `AC-EMP-16-SUB-05-order-code.test.ts`、`AC-EMP-16-order-code-scheduler.test.ts`、`AC-EMP-16-order-code-lock-pg.test.ts`、`AC-EMP-16-benchmark.test.ts` | 已覆盖 | — |
| AC-FWD-13 | `AC-FWD-13-14.test.ts` | 已覆盖 | — |
| AC-FWD-14 | `AC-FWD-13-14.test.ts`、`AC-FWD-14-scope.test.ts`、`AC-FWD-rules.test.ts`；E2E-01 步骤 4（预览） | 已覆盖 | — |
| AC-FWD-15 | `AC-FWD-15.test.ts` | 已覆盖 | — |
| AC-TRF-28 | `AC-TRF-07-10-36-revoke-delete.test.ts`、`AC-APV-14-16-17-20-actions.test.ts`；E2E-02 分支三 | 已覆盖 | — |
| AC-TRF-29 | `AC-APV-05-09-18-19-versions.test.ts`（`AC-APV-19 / AC-TRF-29`） | 已覆盖 | — |
| AC-TRF-33 | `AC-TRF-33-35-order.test.ts` | 已覆盖 | — |
| AC-TRF-34 | `AC-TRF-core-validation.test.ts` | 已覆盖 | — |
| AC-TRF-35 | `AC-TRF-33-35-order.test.ts` | 已覆盖 | — |
| AC-TRF-36 | `AC-TRF-07-10-36-revoke-delete.test.ts`、`AC-TRF-08-36-delete-round2/3.test.ts`；E2E-02 分支四 | 已覆盖 | — |
| AC-TRF-37 | `AC-TRF-01-37-45-self-service.test.ts`、`AC-TRF-37-39-45-self-disclosure.test.ts` | 已覆盖 | — |
| AC-TRF-38 | `AC-TRF-01-37-45-self-service.test.ts`、`AC-TRF-38-45-self-service-web.test.ts`；E2E-01 步骤 2 | 已覆盖 | — |
| AC-TRF-39 | `AC-TRF-01-37-45-self-service.test.ts`、`AC-TRF-37-39-45-self-disclosure.test.ts`、`AC-TRF-39-self-adapter.test.ts`、`AC-TRF-39-self-entry-parity.test.ts`、`AC-TRF-39-shared-self-form.test.ts` | 已覆盖 | — |
| AC-TRF-40 | `AC-TRF-02-40-44-manager.test.ts`、`AC-TRF-40-41-manager-review.test.ts` | 已覆盖 | — |
| AC-TRF-41 | `AC-TRF-02-40-44-manager.test.ts`、`AC-TRF-40-41-manager-review.test.ts`、`AC-TRF-41-manager-reference-ui.test.ts`、`AC-TRF-41-42-manager-round3.test.ts` | 已覆盖 | — |
| AC-TRF-42 | `AC-TRF-02-40-44-manager.test.ts`、`AC-TRF-42-43-manager-ui.test.ts`、`AC-TRF-41-42-manager-round3.test.ts`；E2E-01 步骤 5 | 部分覆盖 | “试用中 / 待入职”依赖人员状态 / 入职状态模型（AC 原文已注明待接入），由 **F-022** 补齐后补测 |
| AC-TRF-43 | `AC-TRF-42-43-manager-ui.test.ts` | 已覆盖 | — |
| AC-TRF-44 | `AC-TRF-02-40-44-manager.test.ts`；E2E-02 分支六 | 已覆盖 | — |
| AC-TRF-45 | `AC-TRF-01-37-45-self-service.test.ts`、`AC-TRF-37-39-45-self-disclosure.test.ts`、`AC-TRF-38-45-self-service-web.test.ts`；E2E-01 步骤 1 / 2 | 已覆盖 | — |
| AC-TRF-46 | `AC-TRF-46-self-audit.test.ts`、`AC-TRF-46-self-locks-pg.test.ts`；E2E-01 步骤 6 | 已覆盖 | 真 PG 交错以 CI 为准 |

#### 权限（AC-PRM-09~28、30~37）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-PRM-09 | `AC-PRM-09-11.test.ts`（DEC-143 余额 0 仍允许并提示） | 已覆盖 | 口径已由 DEC-143 定（允许超额并提示） |
| AC-PRM-10 | `AC-PRM-10.test.ts` | 已覆盖 | — |
| AC-PRM-11 | `AC-PRM-09-11.test.ts` | 已覆盖 | — |
| AC-PRM-12 | `AC-PRM-36.test.ts`、`AC-PRM-employment-scope.test.ts`（DEC-177）、`AC-TRF-F017-projection.test.ts`；E2E-01 步骤 5 | 已覆盖 | — |
| AC-PRM-13 | — | 未覆盖 | 动态授权规则停用后是否自动撤销身份：复刻按 DEC-023（官方文档）自定，仓库内无“停用规则”用例。建议：补测（R1-T01 动态授权规则停用 → 自动身份回收） |
| AC-PRM-14 | `AC-PRM-data-scope-admin.test.ts` | 已覆盖 | — |
| AC-PRM-15 | `AC-PRM-data-scope-admin.test.ts`（撤销不回滚） | 已覆盖 | — |
| AC-PRM-16 | `AC-PRM-data-scope-admin.test.ts`（表单预填、显式覆盖） | 已覆盖 | — |
| AC-PRM-17 | `AC-PRM-scope-resolution.test.ts`、`AC-PRM-datasource-wiring.test.ts`、`AC-PRM-policy-ambiguity.test.ts`、`AC-PRM-scope-policy-admin.test.ts` | 已覆盖 | — |
| AC-PRM-18 | `AC-PRM-35.test.ts`（负责人 / HRBP 范围随任职变更）、`AC-PRM-scope-resolution.test.ts` | 已覆盖 | — |
| AC-PRM-19 | `AC-PRM-19.test.ts` | 已覆盖 | 追溯表仍标“前台按钮可见性待单身份账号核对”，属原站取证项，不影响复刻验收 |
| AC-PRM-20 | `AC-PRM-20.test.ts` | 已覆盖 | — |
| AC-PRM-21 | `AC-PRM-scope-resolution.test.ts`（dynamic org grants only in HR/attendance） | 已覆盖 | — |
| AC-PRM-22 | `AC-PRM-22.test.ts`、`AC-PRM-employment-replay.test.ts`、`AC-PRM-employment-wiring.test.ts` | 已覆盖 | — |
| AC-PRM-23 | `AC-PRM-23.test.ts` | 已覆盖 | — |
| AC-PRM-24 | `AC-PRM-01.test.ts`（后端权限为准） | 部分覆盖 | “无菜单但有对象权限时可按数据范围取数”的正向用例未单独写。建议：补测（持对象权限、无菜单配置的用户直接请求调动管理列表 → 200 且按范围取数） |
| AC-PRM-25 | `AC-PRM-01.test.ts`（403 `FORBIDDEN` 机器可读） | 已覆盖 | — |
| AC-PRM-26 | `AC-PRM-30.test.ts`、`AC-PRM-employment-scope.test.ts`、`AC-PRM-scope-resolution.test.ts`（`hasDataPermission`） | 已覆盖 | — |
| AC-PRM-27 | `AC-R1-E2E-02-branches.test.ts` 分支七（普通员工首次获得汇报下属并生效 → 自动取得经理自助身份，工作台 200）；辅证 `AC-TRF-02-manager-approval.test.ts`（负责人身份即时派生） | 已覆盖 | 复刻以“即时派生”实现 DEC-020 的“自动获得”，不写授权行（Q-M0-71）；仅有汇报下属的经理团队按负责组织取数为空（AC-TRF-44 口径） |
| AC-PRM-28 | `AC-R1-E2E-02-branches.test.ts` 分支七（最后一名下属改由他人管理并生效 → 经理入口 403、他人取得；显式授予的字段可见身份保持不变）；辅证 `AC-TRF-02-40-44-manager.test.ts`（AC-TRF-44 负责人撤换立即失效） | 已覆盖 | 同上 |
| AC-PRM-30 | `AC-PRM-30.test.ts` | 已覆盖 | — |
| AC-PRM-31 | `AC-PRM-31-32-33.test.ts`、`AC-PRM-scope-policy-admin.test.ts` | 已覆盖 | — |
| AC-PRM-32 | `AC-PRM-31-32-33.test.ts` | 已覆盖 | — |
| AC-PRM-33 | `AC-PRM-31-32-33.test.ts` | 已覆盖 | — |
| AC-PRM-34 | `AC-PRM-34.test.ts`、`AC-PRM-35.test.ts` | 已覆盖 | — |
| AC-PRM-35 | `AC-PRM-35.test.ts` | 已覆盖 | — |
| AC-PRM-36 | `AC-PRM-36.test.ts` | 已覆盖 | — |
| AC-PRM-37 | `AC-PRM-org-job-est-wiring.test.ts` | 已覆盖 | — |

#### 组织 / 编制 / 职务（AC-ORG-10~11、13~21；AC-EST-01~07；AC-JOB-01~05、07~12）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-ORG-10 | `AC-ORG-10-11.test.ts` | 已覆盖 | — |
| AC-ORG-11 | `AC-ORG-10-11.test.ts` | 已覆盖 | 组织改名联动任职（F-007）待 #83，见 §2.3 |
| AC-ORG-13 | `AC-ORG-13-14.test.ts` | 已覆盖 | — |
| AC-ORG-14 | `AC-ORG-13-14.test.ts`、`AC-PRM-34.test.ts` | 已覆盖 | — |
| AC-ORG-15 | `AC-ORG-15.test.ts` | 已覆盖 | — |
| AC-ORG-16 | `AC-ORG-16.test.ts` | 已覆盖 | — |
| AC-ORG-17 | `AC-ORG-17-18.test.ts` | 已覆盖 | — |
| AC-ORG-18 | `AC-ORG-17-18.test.ts` | 已覆盖 | — |
| AC-ORG-19 | `AC-ORG-19.test.ts` | 已覆盖 | — |
| AC-ORG-20 | `AC-ORG-20.test.ts`、`AC-ORG-15.test.ts` | 已覆盖 | — |
| AC-ORG-21 | `AC-ORG-21.test.ts`、`AC-ORG-21-expiry.test.ts`、`AC-ORG-21-concurrency-pg.test.ts`、`AC-ORG-21-resource-locks-pg.test.ts` | 已覆盖 | — |
| AC-EST-01 | `AC-EST-01.test.ts`、`AC-EST-scope-safety.test.ts`、`AC-TRF-31-establishment.test.ts`（调动严格控编） | 已覆盖 | — |
| AC-EST-02 | `AC-EST-02.test.ts` | 部分覆盖 | 编制模块“非严格控制允许并提示”已自动化；调动入口非严格控编重叠超编时无提示（astra 已复现，OBS-03），**已登记 F-026**，随其补测 |
| AC-EST-03 | `AC-EST-03.test.ts` | 已覆盖 | — |
| AC-EST-04 | `AC-EST-04.test.ts` | 已覆盖 | — |
| AC-EST-05 | `AC-EST-05.test.ts`、`AC-EST-subdivision-period.test.ts`、`AC-EST-temporal.test.ts` | 已覆盖 | — |
| AC-EST-06 | `AC-EST-06.test.ts` | 已覆盖 | — |
| AC-EST-07 | `AC-EST-07.test.ts` | 已覆盖 | — |
| AC-JOB-01 | `AC-JOB-01-02-04-06.test.ts`、`AC-JOB-assignment-safety.test.ts`、`AC-JOB-candidate-validity.test.ts`、`AC-JOB-reference-safety.test.ts` | 已覆盖 | — |
| AC-JOB-02 | `AC-JOB-01-02-04-06.test.ts`、`AC-JOB-future-ancestor-safety.test.ts`、`AC-JOB-tree-safety.test.ts` | 已覆盖 | — |
| AC-JOB-03 | `AC-JOB-03-05.test.ts`、`AC-JOB-personnel-safety.test.ts` | 已覆盖 | — |
| AC-JOB-04 | `AC-JOB-01-02-04-06.test.ts` | 已覆盖 | — |
| AC-JOB-05 | `AC-JOB-03-05.test.ts`、`AC-JOB-05-lock-order-pg.test.ts`、`AC-JOB-05-out-of-scope.test.ts`、`AC-JOB-05-port.test.ts`、`AC-JOB-05-scope.test.ts` | 已覆盖 | — |
| AC-JOB-07 | `AC-JOB-07-org-whole-period.test.ts` | 已覆盖 | — |
| AC-JOB-08 | `AC-JOB-08-11-sequence-sync.test.ts`、`AC-JOB-08-review-activation.test.ts` | 已覆盖 | — |
| AC-JOB-09 | `AC-JOB-09-sequence-form.test.ts`、`AC-JOB-09-candidates.test.ts`、`AC-JOB-08-11-sequence-sync.test.ts` | 已覆盖 | — |
| AC-JOB-10 | `AC-JOB-08-11-sequence-sync.test.ts`、`AC-JOB-10-audit-failures.test.ts`、`AC-JOB-10-sequence-lock-pg.test.ts`、`AC-JOB-11-permissions.test.ts` | 已覆盖 | — |
| AC-JOB-11 | `AC-JOB-08-11-sequence-sync.test.ts`、`AC-JOB-11-limit.test.ts`、`AC-JOB-11-permissions.test.ts` | 已覆盖 | — |
| AC-JOB-12 | `AC-JOB-12-result-visibility.test.ts` | 已覆盖 | — |

#### 审批中心（AC-APV-01~12、18~37）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-APV-01 | `AC-APV-01-04-13-15-routing.test.ts`；E2E-01 步骤 2 | 已覆盖 | — |
| AC-APV-02 | `AC-APV-01-04-13-15-routing.test.ts`（`AC-APV-01/02`）；E2E-01 步骤 2 | 已覆盖 | — |
| AC-APV-03 | `AC-APV-01-04-13-15-routing.test.ts` | 已覆盖 | — |
| AC-APV-04 | `AC-APV-01-04-13-15-routing.test.ts`、`AC-APV-04-routing-rules.test.ts`；E2E-02 分支一 | 已覆盖 | — |
| AC-APV-05 | `AC-APV-05-09-18-19-versions.test.ts`（`AC-APV-05/06/07`） | 已覆盖 | — |
| AC-APV-06 | 同上 | 已覆盖 | — |
| AC-APV-07 | 同上 | 已覆盖 | — |
| AC-APV-08 | `AC-APV-05-09-18-19-versions.test.ts` | 已覆盖 | — |
| AC-APV-09 | `AC-APV-05-09-18-19-versions.test.ts` | 已覆盖 | — |
| AC-APV-10 | — | 未覆盖 | 审批时效首版不做（**DEC-035** ⏸）。建议：已由 DEC 改口径 |
| AC-APV-11 | `AC-APV-11-12-simulation.test.ts` | 已覆盖 | — |
| AC-APV-12 | `AC-APV-11-12-simulation.test.ts` | 已覆盖 | — |
| AC-APV-18 | `AC-APV-05-09-18-19-versions.test.ts` | 已覆盖 | — |
| AC-APV-19 | `AC-APV-05-09-18-19-versions.test.ts` | 已覆盖 | — |
| AC-APV-20 | `AC-APV-14-16-17-20-actions.test.ts` | 已覆盖 | — |
| AC-APV-21 | `AC-APV-21-26-countersign.test.ts` | 已覆盖 | — |
| AC-APV-22 | `AC-APV-21-26-countersign.test.ts` | 部分覆盖 | 其余待办的收回方式为暂定口径（Q-M0-57，issue #56）。建议：待取证 |
| AC-APV-23 | `AC-APV-21-26-countersign.test.ts` | 部分覆盖 | 同上（#56） |
| AC-APV-24 | `AC-APV-21-26-countersign.test.ts`、`AC-APV-32-36-countersign-round3.test.ts` | 部分覆盖 | ③“全部处理完仍无动作达标”暂定自动退回（issue #57）。建议：待取证 |
| AC-APV-25 | `AC-APV-21-26-countersign.test.ts` | 部分覆盖 | 驳回去向为推断（#56）。建议：待取证 |
| AC-APV-26 | `AC-APV-21-26-countersign.test.ts` | 已覆盖 | — |
| AC-APV-27 | `AC-APV-27-28-parallel-add-sign.test.ts` | 已覆盖 | — |
| AC-APV-28 | `AC-APV-27-28-parallel-add-sign.test.ts` | 已覆盖 | — |
| AC-APV-29 | `AC-APV-29-countersign-lifecycle.test.ts` | 已覆盖 | — |
| AC-APV-30 | `AC-APV-30-countersign-concurrency-pg.test.ts` | 已覆盖 | 真 PG 以 CI 为准 |
| AC-APV-31 | `AC-APV-31-countersign-simulation.test.ts` | 已覆盖 | — |
| AC-APV-32 | `AC-APV-32-37-countersign-round2.test.ts`、`AC-APV-32-36-countersign-round3.test.ts`、`AC-TRF-F017-handover-pg.test.ts` | 已覆盖 | — |
| AC-APV-33 | `AC-APV-32-37-countersign-round2.test.ts` | 已覆盖 | — |
| AC-APV-34 | `AC-APV-32-37-countersign-round2.test.ts` | 已覆盖 | — |
| AC-APV-35 | `AC-APV-32-37-countersign-round2.test.ts` | 已覆盖 | — |
| AC-APV-36 | `AC-APV-32-36-countersign-round3.test.ts`、`AC-APV-32-37-countersign-round2.test.ts`、`AC-APV-27-28-parallel-add-sign.test.ts` | 部分覆盖 | 会签前加签细节为暂定口径（DEC-152，代码留 `TODO(需取证 DEC-152)`）。建议：待取证 |
| AC-APV-37 | `AC-APV-32-37-countersign-round2.test.ts` | 已覆盖 | — |

#### 审计 / 多租户 / 联动 / 子集（AC-AUD-01~14、AC-TEN-01~04、AC-LNK-01~06、AC-SUB-01~05）

| 编号 | 自动化测试文件 / 用例 | 状态 | 未覆盖原因与建议 |
|---|---|---|---|
| AC-AUD-01 | `AC-AUD-01-02.test.ts`；E2E-01 步骤 6 | 已覆盖 | — |
| AC-AUD-02 | `AC-AUD-01-02.test.ts`；E2E-02 分支四 | 已覆盖 | — |
| AC-AUD-03 | `AC-AUD-03.test.ts` | 已覆盖 | — |
| AC-AUD-04 | `AC-AUD-04.test.ts`；E2E-01 步骤 6 | 已覆盖 | — |
| AC-AUD-05 | `AC-AUD-05.test.ts` | 已覆盖 | — |
| AC-AUD-06 | `AC-AUD-06.test.ts` | 已覆盖 | — |
| AC-AUD-07~14 | `AC-AUD-07-14.test.ts`；E2E-02 分支二（联动日志对范围内审计员可见） | 已覆盖 | — |
| AC-TEN-01 | `AC-TEN-01.test.ts`、`AC-ORG-TEN-01.test.ts`；E2E-02 分支六 | 已覆盖 | — |
| AC-TEN-02 | `AC-TEN-02.test.ts`、`AC-TEN-02-membership.test.ts`；E2E-02 分支六 | 已覆盖 | — |
| AC-TEN-03 | `AC-TEN-03.test.ts`、`AC-AUD-05.test.ts` | 已覆盖 | — |
| AC-TEN-04 | `AC-TEN-04.test.ts` | 已覆盖 | — |
| AC-LNK-01 | `AC-LNK-01-06.test.ts`；E2E-02 分支二（下属转交段） | 已覆盖 | — |
| AC-LNK-02 | `AC-LNK-01-06.test.ts` | 已覆盖 | — |
| AC-LNK-03 | `AC-LNK-01-06.test.ts`；E2E-02 分支二 | 已覆盖 | — |
| AC-LNK-04 | `AC-LNK-01-06.test.ts`、`AC-LNK-concurrency-pg.test.ts` | 已覆盖 | — |
| AC-LNK-05 | `AC-LNK-01-06.test.ts` | 已覆盖 | — |
| AC-LNK-06 | `AC-LNK-01-06.test.ts`（兼职端口替身） | 部分覆盖 | 兼职模块 R2-T05 未上线，按 DEC-191 只交付端口；失效日期口径待取证（issue #71）。建议：待取证 + R2-T05 后补测 |
| AC-SUB-01 | `AC-SUB-01-04.test.ts`、`AC-SUB-platform.test.ts` | 已覆盖 | — |
| AC-SUB-02 | `AC-SUB-02-sync.test.ts`、`AC-SUB-02-same-day-sync.test.ts` | 已覆盖 | — |
| AC-SUB-03 | `AC-SUB-03-requests.test.ts` | 已覆盖 | — |
| AC-SUB-04 | `AC-SUB-01-04.test.ts`、`AC-SUB-04-query-count.test.ts`、`AC-SUB-04-sort-ranks.test.ts`、`AC-SUB-04-sorting.test.ts` | 已覆盖 | — |
| AC-SUB-05 | `AC-EMP-16-SUB-05-order-code.test.ts` | 已覆盖 | — |

### 3.3 汇总

| 分组 | AC 条数（唯一编号） | 已覆盖 | 部分覆盖 | 未覆盖 |
|---|---|---|---|---|
| 路线图“对应验收”（§3.1，含 `13` §4.1 定义的 AC-TRF-24～27；AC-TRF-31 计 1 条） | 80 | 71 | 3 | 6 |
| R1 任务新增（§3.2，AC-AUD-07~14 计 8 条） | 142 | 131 | 9 | 2 |
| **合计** | **222** | **202** | **12** | **8** |

未覆盖 8 条的处理建议：已有 DEC 的 7 条（AC-TRF-16 / 17 / 27 DEC-002、AC-TRF-22 DEC-007、AC-APV-10 DEC-035、AC-TRF-23 DEC-226 不复刻、AC-PRM-02 DEC-227 并入 AC-PRM-24）；建议补测 1 条（AC-PRM-13）。
部分覆盖 12 条：待取证 7 条（AC-APV-22 / 23 / 24 / 25 / 36、AC-LNK-06、AC-TRF-26）；待其他任务 4 条（AC-FWD-11 R2-T05、AC-TRF-42 F-022、AC-TEN-06 部署环境、AC-EST-02 F-026）；建议补测 1 条（AC-PRM-24 正向用例）。

## 4. 缺陷清单

端到端串联（主线 6 步、分支 7 组，PGlite 15 项通过）**未发现阻塞性产品缺陷**；所有步骤的业务结果与规格 / DEC 一致。以下为核对中发现的**非缺陷观察项**与建议登记的后续事项，供编排窗口判断是否登记 F 任务：

| 编号 | 类型 | 内容 | 涉及模块 / DEC | 建议 |
|---|---|---|---|---|
| OBS-01 | 文档漏列 | AC-TRF-24～27 已在 `docs/02_业务建模/13_调动配置_本租户实际取值.md` §4.1 定义（标准 / 自定义表单目标范围、组织角色变更记录、薪资范围开关依赖），集中追溯表 `docs/05_验收/01` C 节漏列这四条 | 文档 | 编排窗口把 `13` §4.1 的四条补进追溯表（口径照抄，不改） |
| OBS-02 | 已决 | AC-TRF-23（人事申请按钮描述）与 AC-PRM-02（菜单上下文鉴权）均为原站实现细节 → 用户 2026-10-07 决定 **DEC-226**（AC-TRF-23 不复刻）、**DEC-227**（AC-PRM-02 并入 AC-PRM-24） | R1-T13、R1-T01 | 本报告已按两条 DEC 更新状态；追溯表状态列由编排窗口同步 |
| OBS-03 | **产品缺陷（P2，已登记 F-026）** | 复现：目标部门非严格控编、容量 1；HR 先保存一名员工 10-20 调入（201），再保存另一名员工 10-05 调入，两段占编在 10-20 起重叠超编。期望（AC-EST-02）：第二笔允许保存但返回超编提示 / 二次确认。实际：第二笔 201，响应无任何超编警告或确认信息（astra 首审在 head 5b894d1 复现）。原因：编制检查按目标日至周期末峰值只在严格控编时拦截，非严格控编不生成提示（RP-056 遗留） | R1-T09 `transfer/service.ts` 编制判定、DEC-145、AC-EST-02 | 已登记 **F-026**（等 #79 F-018 合并后派发）；待补测试：重叠区间与先后顺序两种回归，调动保存 / 预览返回超编警告 |
| OBS-04 | 行为确认 | 驳回后 HR 撤回再提交，沿用原实例与原流程版本、从首节点重新流转（日志保留 reject / withdraw），符合 DEC-103 | R1-T07、DEC-103 | 无需处理；界面走查时核对“审批记录”页展示两轮记录 |
| OBS-05 | 行为确认 | 带联动的调动在生效前，联动详情只有选项、无转交记录（`dutyTransfer = null`），记录在生效时生成 | R1-T10 | 无需处理；前端应按“选项”渲染生效前状态 |
| OBS-06 | 测试基线 | 真实授权器下 HR 若无组织对象查看权，组织列表 403（符合权限模型，端到端夹具已给 HR 授组织只读） | R1-T01 | 无需处理；提示界面走查时 HR 身份须含组织对象 |
| OBS-07 | 待补跑 | 带编调动（#79）、组织改名 / 改上级联动任职（#83）不在基线内 | F-018、F-007 | 合并后合并 main、重跑端到端用例并更新本报告（§2.3） |

## 5. 结论

- R1 出口标准“员工发起调动申请 → 审批 → HR 执行 → 生效 → 任职记录版本链与向后更新正确 → 员工与经理侧可见变更”在基线 0dd7af5 上以真实权限端到端跑通，并额外验证了经理发起、联动、驳回重提、撤销删除、迟到执行、跨租户隔离、经理身份自动取得与回收七个分支。
- 222 条 R1 相关 AC（唯一编号，含 `13` §4.1 定义、追溯表漏列的 AC-TRF-24～27）中 202 条已覆盖、12 条部分覆盖、8 条未覆盖（其中 7 条已有 DEC，含 DEC-226 / 227）。无需改变任何 AC 口径。
- 带编调动与组织联动场景待 #79 / #83 合并后补跑。
