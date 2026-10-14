# R1 底座 AC 覆盖报告与端到端验收（F-024，DEC-221③）

> 版本：v1.5（2026-10-07，Claude 开发窗口；第六轮修订：按 DEC-254 删除静态解析的覆盖统计脚本，覆盖数改为人工核对结果）。
> **本报告覆盖数为人工核对结果（R1 原 238 项：217 已覆盖 / 13 部分 / 8 未覆盖 / 0 未定义；含合入 main 后新增 AC 共 243 项：222 / 13 / 8 / 0），脚本统计待 F-030（Vitest 运行时采集，DEC-254）完成后复核。**
> 本报告只核对覆盖情况，**不改变任何 AC 口径**；AC 原文以 `docs/05_验收/01_验收场景与追溯表.md` 及各规格 §AC 节为准。

## 1. 验收基线与范围

| 项目 | 内容 |
|---|---|
| 基线提交 | 首轮 `origin/main` 0dd7af5（RP-068，R1 底座 19/19）；第二轮合并 0504d88（仅文档）；第三轮合并 main 962e1c8，含 #79 F-018 带编调动（fd226c7）、#90 R3-T00 表达式引擎（7f27667）；第四轮合并 main 95c57f2，另含 #98 F-028 审批人“直接上级”（449afc1）及文档；第五轮合并 main 336abb5，另含 #92 F-025（本地演示环境）；**第六轮合并 main 4d1c0fe**，另含 #93 F-022（人员状态，235f925）。§3 人工核对的基线为 336abb5，#93 新增或改判的 AC（如 AC-TRF-42 原记“待其他任务 F-022”）未在本轮重核，待 F-030 复核 |
| **未包含的在途 PR** | **#83 F-007**（组织改名 / 改行政上级联动任职，DEC-137）。组织联动用例在 §2.3 标为“待 #83 合并后补跑”，合并后本 PR 合并 main、重跑端到端用例并更新本报告 |
| 对象 | 路线图 R1 阶段“对应验收”所列 AC，以及 R1 各任务与已合并 F 任务新增的 AC（含 F-018 的 AC-TRF-47～50、AC-EST-08～19，F-028 的 AC-APV-38～42）；范围清单即 §3 明细表所列编号 |
| 自动化证据来源 | `tests/acceptance/*.test.ts`（PGlite 离线全量；真 PostgreSQL 16 以 CI 的 `test:pg` 作业为准）；本任务新增 `AC-R1-E2E-*.test.ts` |
| 执行方式 | `pnpm test`（PGlite）全量；`bash scripts/test-pg.sh tests/acceptance/AC-R1-E2E-*.test.ts`（容器内 PG 16） |

## 2. 端到端验收测试（新增）

文件：`tests/acceptance/AC-R1-E2E-support.ts`（夹具）、`AC-R1-E2E-01-transfer-closure.test.ts`（主线）、`AC-R1-E2E-02-branches.test.ts`（分支）、`AC-R1-E2E-03-with-establishment.test.ts`（带编调动）。

原则：**全程真实授权器、真实身份**，不注入替身绕过权限。员工本人只有账号绑定（R1-T13 自动自助身份）；审批人与异常管理员只授“任职记录字段可见”身份、不带数据范围（DEC-057）；范围内 / 范围外 HR 持任职记录、员工、编制写权限与组织只读，数据范围各不相同；审计员为日志审计管理员 + 字段可见身份 + 数据范围。组织、入职、流程发布、职务 / 职位 / 编制等前置数据经可信夹具建立。定时任务经平台入口 `runEmploymentActivations` 按注入的 UTC 时钟运行（DEC-056）。负向用例断言具体响应码，并前后各读一次对比业务数据（派发规则 §1）。

### 2.1 主线 E2E-01（6 步，每步断言业务结果）

| 步骤 | 内容 | 核对的 AC / DEC |
|---|---|---|
| 1 员工发起 | 员工本人预览（表单 = HR 同一张，新经理随新部门带出）→ 提交本人调动申请 → 匹配到已发布调动流程，首节点待办在调出部门负责人、不在本人；“我的申请”显示审批中；版本链不新增 | AC-TRF-01/37/45、DEC-205/209、DEC-017/058、DEC-125 |
| 2 逐节点审批 | 调出负责人 → 调入 HRBP → 调入负责人依次同意（各自真实身份）；审批人借审批读员工任职返回 404；实例 approved；业务单停在「审批通过」、`record = null`、生效结果 pending；员工侧“我的申请”= 通过；任职列表含在途行且入职记录结束日不截断 | AC-APV-01/02、AC-PRM-29、AC-TRF-06/38 |
| 3 定时生效 | 北京时间 10-14 23:30 不生效；10-15 01:15（UTC 10-14 17:15）生效；版本链 +1、前一条止于 10-14；未改字段（place）继承上一条；恰一条当前生效；“变更前”从版本链上一条取；重复运行不重复生效 | AC-TRF-06/32、AC-EMP-01/05/11、硬规则 2/3、DEC-056 |
| 4 向后更新 + 同日顺序 | HR 补录 10-10 调动改地点：预览列出 10-15 记录的 place 变化、部门不匹配不替换；保存后 10-15 记录 place 被替换、前一条重链为补录记录；同日再保存直接转正：排在调动之后、当前任职为转正、变更前取同日前一条 | AC-FWD-01/02/03/14、AC-EMP-13、DEC-108 |
| 5 各侧可见 | 员工自助：调动记录的新部门 / 新经理为变更后值，place 不在员工可见字段内、不返回；经理工作台：调入负责人看到该员工的新部门 / 新经理，邮箱与手机号被裁剪，调出负责人看不到；范围内 HR 当前记录为变更后值；范围外 HR 列表为空且 `hasDataPermission` 为真（无数据），详情一律 404，用有效 revision 直接 POST 调动 404 且版本链、revision 不变 | AC-TRF-38/42、AC-PRM-04/26、DEC-177、AC-TRF-44 |
| 6 审计 | 范围内审计员看到员工发起（操作人 = 员工）、系统生效（操作人为空、事件时间 UTC 10-14 17:15 = 租户时区 10-15）、向后更新（place 变化）三类日志；范围外审计员列表为空、详情 404 | AC-AUD-04、AC-TRF-46、DEC-197 |

### 2.2 分支 E2E-02

| 分支 | 内容 | 核对的 AC / DEC |
|---|---|---|
| 一 经理发起他人调动 | 纯经理（调出部门负责人）为负责组织内员工发起调往下级组；首节点解析为本人 → 自审跳过、转异常管理员；调入组无 HRBP → 异常管理员；下级组负责人审批；到期生效后仍在其团队内，直线经理随新部门负责人带出 | AC-TRF-02/40、AC-APV-04/15、DEC-058/068 |
| 二 带联动的调动 | HR 发起带“下属转交”（R1-T10）与“新增下属”（R1-T09）的调动：审批通过后联动不执行（联动视图 executedAt 为空）；到期生效同事务改写原下属与新增下属的直线经理，转交记录 succeeded；有联动时删除 409 `EMPLOYMENT_LINKED_CHANGES_EXIST`，业务、版本链与下属经理前后不变 | AC-LNK-01/03、AC-TRF-10/15、DEC-012/172 |
| 三 驳回后撤回再提交 | 调入负责人驳回 → 实例 returned、业务 rejected；HR 撤回到草稿（任职不变）→ 修改地点 → 再提交：沿用原实例与原流程版本、从首节点重新流转（DEC-103），日志含 reject / withdraw；重新走完审批后字段为修改后值 | AC-TRF-28、DEC-103 |
| 四 撤销与删除 | 撤销审批中申请 → voided、实例 cancelled、版本链不变、定时任务不落地；重复撤销 409 与范围外 HR 删除 404 均前后对比不变；作废后可删除。已生效调动删除后前一条恢复“至今”；其后有在途申请时删除 409 `EMPLOYMENT_PENDING_APPLICATION_EXISTS` 且前后不变、撤销后可删；删除日志带快照 | AC-TRF-07/08/36、AC-AUD-02、DEC-126 |
| 五 迟到执行 / 迟到审批 | 定时任务迟到：生效日改为实际执行日 10-23，原计划日 10-20 保留在审计；审批通过时已过计划日：当天生效、生效日 = 批准日，不倒签 | AC-TRF-05、DEC-186/195 |
| 六 跨租户隔离 | 外租户 HR 用本租户员工 / 业务 / 实例 ID 请求一律 404、审计为空；用有效 revision 删除 404 且前后不变；外租户员工自助读本租户员工 403；本租户员工带外租户头 403；组织列表不含外租户组织；定时任务按租户运行互不触碰 | AC-TEN-01/02、AC-TRF-44、硬规则 7 |
| 七 经理身份自动取得与回收 | 普通员工甲无经理入口（403）；下属的直线经理改为甲并生效 → 甲自动取得经理自助身份（工作台 200，团队按负责组织取数为空，AC-TRF-44 口径）；最后一名下属改由他人管理并生效 → 甲入口回收（403），他人取得；甲显式授予的字段可见身份不受影响 | AC-PRM-27/28、DEC-020、Q-M0-71 |

### 2.3 带编调动 E2E-03（第三轮补跑，#79 F-018 合并后）与待补跑

真实 HR（任职 + 编制写权限，范围含调出 / 调入组）在严格控编的调出组（职位细分 2、预留 1）与调入组（细分 0）之间带编调动：

| 步骤 | 内容 | 核对的 AC / DEC |
|---|---|---|
| 1 保存即调编 → 审批 → 定时生效 | 带编调动申请保存后立即调编：调出细分 2 → 1、调入组织与职位细分 0 → 1、预留不动，各一条编制审计；三节点逐个同意后业务停在审批通过、编制不变；调动日定时生效，任职落到调入组与新职位，编制与审计不再重复增减 | AC-TRF-47/49、AC-EST-08、DEC-181/125 |
| 2 撤销回退 | 第二名员工带编申请保存后调编，HR 撤销 → 按原分配反向调整、审计 +2；重复撤销 409，编制、审计、业务前后一致 | AC-TRF-48 |
| 3 范围外拒绝 | 范围外 HR 用有效 revision 发起带编调动 → 404，编制、审计、版本链、员工 revision 前后一致 | AC-EST-14 |
| 4 删除回退 | 删除已生效的带编调动 → 编制回到初始（细分 2 / 预留 1、调入 0），员工回到调出组 | AC-TRF-48、AC-TRF-08 |

| 待补跑场景 | 依赖 | 现状 |
|---|---|---|
| 组织改名 / 改行政上级联动任职：全称与版本随之变化，员工与经理侧可见 | #83 F-007（DEC-137） | 基线无此能力（AC-ORG-11 只覆盖全称按当天上级名称解析）；端到端用例以 `it.todo` 登记 |

### 2.4 执行结果

| 环境 | 结果 |
|---|---|
| PGlite（`pnpm vitest run tests/acceptance/AC-R1-E2E-0`） | 3 个文件 19 项通过，1 项 todo（#83） |
| 真 PostgreSQL 16（容器内 `scripts/test-pg.sh`，三个端到端文件） | 19 项通过、1 项 todo（2026-10-07 本地 PG 16，第四轮合并 main 95c57f2 后重跑）；CI 的 `test:pg` 作业为准 |
| 全量 | 见 PR 描述“验证结果”（CI 两项） |

## 3. AC 覆盖核对（人工核对）

**本报告覆盖数为人工核对结果（R1 原 238 项：217 已覆盖 / 13 部分 / 8 未覆盖 / 0 未定义；含合入 main 后新增 AC 共 243 项：222 / 13 / 8 / 0），脚本统计待 F-030（Vitest 运行时采集，DEC-254）完成后复核。**

核对口径：
- **用例**：`tests/acceptance` 中的 describe / it / test（含 `.each`、`.runIf`、`.skipIf`）；用例标题 = 各级 describe 标题 + 自身标题，参数化用例按标题里实际出现的编号计。`it.todo` / `.skip` 不计覆盖；只在真 PostgreSQL 上运行的用例计覆盖并标“含条件执行”。
- **定义**：追溯表及 `13` / `14` / `20` / `21` / `22` 规格中首列为单个 AC 编号的表格行；下表“定义位置”列出处。
- **已覆盖**：至少一个用例标题含该编号，或用例标题未写编号但经人工核对确实验证该 AC（下表“人工映射”列），且备注没有改状态。
- **部分覆盖 / 未覆盖**：没有用例，或经人工判定（分类：已有 DEC / 待取证 / 待其他任务 / 建议补测）。标题里出现编号但并未验证该 AC 的情况也按人工判定改判，例如 AC-TRF-23。

核对过程：第一、二轮人工逐条核对（222 条）；第三轮纳入 F-018 新增 16 条（238 条，AC-EST-13 待取证 #78 记部分覆盖）；第四轮纳入已合并 F-028 的 AC-APV-38～42（243 条）。第三至五轮曾用静态解析脚本辅助统计（DEC-245），第 5 轮审查确认该脚本对多种写法仍会算错，按 **DEC-254** 已从本 PR 删除，覆盖统计改由 **F-030**（Vitest 运行时采集）实现。下表数字与第五轮结果一致，作为人工核对结果保留。第五轮为适配该脚本改写的 17 个验收测试文件 + 1 个 support 文件保留（只改参数表与标题写法，不改断言、参数矩阵与执行顺序）。

| 分组 | AC 条数 | 已覆盖 | 部分覆盖 | 未覆盖 | 未定义 |
|---|---|---|---|---|---|
| 路线图 R1“对应验收” | 80 | 71 | 3 | 6 | 0 |
| R1 任务新增（含 F 任务） | 163 | 151 | 10 | 2 | 0 |
| **合计** | **243** | **222** | **13** | **8** | **0** |

| 状态 · 分类 | 条数 |
|---|---|
| 未覆盖 · 已有 DEC | 7 |
| 未覆盖 · 建议补测 | 1 |
| 部分覆盖 · 建议补测 | 1 |
| 部分覆盖 · 待其他任务 | 4 |
| 部分覆盖 · 待取证 | 8 |

其中 2 条的用例标题未写编号，靠人工映射（已人工核对用例存在）计入。

#### 路线图 R1“对应验收”

| 编号 | 状态 | 用例数（标题含编号 / 人工映射） | 测试文件 | 定义位置 | 备注 |
|---|---|---|---|---|---|
| AC-APV-13 | 已覆盖 | 2 / 0 | AC-APV-01-04-13-15-routing.test.ts、AC-APV-05-09-18-19-versions.test.ts | 01_验收场景与追溯表.md:308 | 原站首节点运行行为仍待取证，不影响复刻验收 |
| AC-APV-14 | 已覆盖 | 2 / 0 | AC-APV-14-16-17-20-actions.test.ts | 01_验收场景与追溯表.md:309 | — |
| AC-APV-15 | 已覆盖 | 3 / 0 | AC-APV-01-04-13-15-routing.test.ts、AC-R1-E2E-02-branches.test.ts | 01_验收场景与追溯表.md:310 | — |
| AC-APV-16 | 已覆盖 | 1 / 0 | AC-APV-14-16-17-20-actions.test.ts | 01_验收场景与追溯表.md:311 | — |
| AC-APV-17 | 已覆盖 | 1 / 0 | AC-APV-14-16-17-20-actions.test.ts | 01_验收场景与追溯表.md:312 | — |
| AC-EMP-01 | 已覆盖 | 13 / 0 | AC-EMP-core.test.ts、AC-EMP-state.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:29 | — |
| AC-EMP-02 | 已覆盖 | 1 / 0 | AC-EMP-inheritance-matrix.test.ts | 01_验收场景与追溯表.md:30 | — |
| AC-EMP-03 | 已覆盖 | 1 / 0 | AC-EMP-inheritance-matrix.test.ts | 01_验收场景与追溯表.md:31 | — |
| AC-EMP-04 | 已覆盖 | 1 / 0 | AC-EMP-inheritance-matrix.test.ts | 01_验收场景与追溯表.md:32 | — |
| AC-EMP-05 | 已覆盖 | 2 / 0 | AC-EMP-inheritance-matrix.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:33 | — |
| AC-EMP-06 | 已覆盖 | 6 / 0 | AC-EMP-core.test.ts | 01_验收场景与追溯表.md:34 | — |
| AC-EMP-07 | 已覆盖 | 6 / 0 | AC-EMP-core.test.ts | 01_验收场景与追溯表.md:35 | — |
| AC-EMP-08 | 已覆盖 | 2 / 0 | AC-EMP-inheritance-boundaries.test.ts | 01_验收场景与追溯表.md:36 | — |
| AC-EMP-09 | 已覆盖 | 6 / 0 | AC-EMP-core.test.ts | 01_验收场景与追溯表.md:37 | — |
| AC-EMP-10 | 已覆盖 | 1 / 0 | AC-EMP-inheritance-boundaries.test.ts | 01_验收场景与追溯表.md:38 | — |
| AC-EMP-11 | 已覆盖 | 18 / 0 | AC-EMP-DEC-077.test.ts、AC-EMP-core.test.ts、AC-EMP-state.test.ts、AC-EMP-uncertain-boundaries.test.ts 等 5 个 | 01_验收场景与追溯表.md:39 | — |
| AC-FWD-01 | 已覆盖 | 20 / 0 | AC-FWD-01-07-12.test.ts、AC-FWD-platform.test.ts、AC-FWD-state.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:50 | — |
| AC-FWD-02 | 已覆盖 | 20 / 0 | AC-FWD-01-07-12.test.ts、AC-FWD-platform.test.ts、AC-FWD-state.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:51 | — |
| AC-FWD-03 | 已覆盖 | 10 / 0 | AC-FWD-01-07-12.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:52 | — |
| AC-FWD-04 | 已覆盖 | 9 / 0 | AC-FWD-01-07-12.test.ts | 01_验收场景与追溯表.md:53 | — |
| AC-FWD-05 | 已覆盖 | 12 / 0 | AC-FWD-01-07-12.test.ts、AC-FWD-rules.test.ts | 01_验收场景与追溯表.md:54 | — |
| AC-FWD-06 | 已覆盖 | 16 / 0 | AC-FWD-01-07-12.test.ts、AC-FWD-06-DEC-107.test.ts、AC-FWD-rules.test.ts | 01_验收场景与追溯表.md:55 | — |
| AC-FWD-07 | 已覆盖 | 9 / 0 | AC-FWD-01-07-12.test.ts | 01_验收场景与追溯表.md:56 | — |
| AC-FWD-08 | 已覆盖 | 10 / 0 | AC-FWD-08-11.test.ts、AC-FWD-import.test.ts | 01_验收场景与追溯表.md:57 | — |
| AC-FWD-09 | 已覆盖 | 6 / 0 | AC-FWD-08-11.test.ts | 01_验收场景与追溯表.md:58 | 原站无法构造（⏸），复刻按口径自动化 |
| AC-FWD-10 | 已覆盖 | 10 / 0 | AC-FWD-08-11.test.ts、AC-FWD-import.test.ts | 01_验收场景与追溯表.md:59 | — |
| AC-FWD-11 | 部分覆盖 | 6 / 0 | AC-FWD-08-11.test.ts | 01_验收场景与追溯表.md:60 | 待其他任务：兼职任职模块 R2-T05 未上线，用例按主职 / 兼职标志验证规则；R2-T05 后补跑真实兼职记录 |
| AC-FWD-12 | 已覆盖 | 9 / 0 | AC-FWD-01-07-12.test.ts | 01_验收场景与追溯表.md:61 | — |
| AC-JOB-06 | 已覆盖 | 5 / 0 | AC-JOB-01-02-04-06.test.ts、AC-JOB-tree-safety.test.ts | 01_验收场景与追溯表.md:223 | — |
| AC-ORG-01 | 已覆盖 | 11 / 0 | AC-ORG-01-09.test.ts | 01_验收场景与追溯表.md:164 | — |
| AC-ORG-02 | 已覆盖 | 11 / 0 | AC-ORG-01-09.test.ts | 01_验收场景与追溯表.md:165 | — |
| AC-ORG-03 | 已覆盖 | 11 / 0 | AC-ORG-01-09.test.ts | 01_验收场景与追溯表.md:166 | — |
| AC-ORG-04 | 已覆盖 | 14 / 0 | AC-ORG-01-09.test.ts、AC-ORG-05.test.ts | 01_验收场景与追溯表.md:167 | — |
| AC-ORG-05 | 已覆盖 | 14 / 0 | AC-ORG-01-09.test.ts、AC-ORG-05.test.ts | 01_验收场景与追溯表.md:168 | — |
| AC-ORG-06 | 已覆盖 | 11 / 0 | AC-ORG-01-09.test.ts | 01_验收场景与追溯表.md:169 | — |
| AC-ORG-07 | 已覆盖 | 26 / 0 | AC-ORG-01-09.test.ts、AC-ORG-hierarchy-contract.test.ts、AC-ORG-version-safety.test.ts | 01_验收场景与追溯表.md:170 | — |
| AC-ORG-08 | 已覆盖 | 11 / 0 | AC-ORG-01-09.test.ts | 01_验收场景与追溯表.md:171 | — |
| AC-ORG-09 | 已覆盖 | 11 / 0 | AC-ORG-01-09.test.ts | 01_验收场景与追溯表.md:172 | — |
| AC-ORG-12 | 已覆盖 | 6 / 0 | AC-ORG-12.test.ts | 01_验收场景与追溯表.md:175 | — |
| AC-PRM-01 | 已覆盖 | 4 / 0 | AC-PRM-01.test.ts | 01_验收场景与追溯表.md:122 | — |
| AC-PRM-02 | 未覆盖 | 0 / 0 | — | 01_验收场景与追溯表.md:123 | 已有 DEC：DEC-227：并入 AC-PRM-24，复刻统一按后端对象权限判断 |
| AC-PRM-03 | 已覆盖 | 12 / 0 | AC-PRM-employment-scope.test.ts、AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:124 | — |
| AC-PRM-04 | 已覆盖 | 5 / 0 | AC-PRM-scope-resolution.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:125 | — |
| AC-PRM-05 | 已覆盖 | 4 / 0 | AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:126 | — |
| AC-PRM-06 | 已覆盖 | 4 / 0 | AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:127 | — |
| AC-PRM-07 | 已覆盖 | 5 / 0 | AC-PRM-07.test.ts、AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:128 | — |
| AC-PRM-08 | 已覆盖 | 3 / 0 | AC-PRM-08.test.ts | 01_验收场景与追溯表.md:129 | — |
| AC-PRM-29 | 已覆盖 | 10 / 0 | AC-APV-PRM-29.test.ts、AC-PRM-employment-scope.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:150 | — |
| AC-TEN-05 | 已覆盖 | 8 / 0 | AC-TEN-05.test.ts、AC-TRF-32-AC-TEN-05-timezone.test.ts | 01_验收场景与追溯表.md:260 | — |
| AC-TEN-06 | 部分覆盖 | 18 / 0 | AC-TEN-06-restore-approval.test.ts、AC-TEN-06-restore-safety.test.ts、AC-TEN-06.test.ts | 01_验收场景与追溯表.md:261 | 待其他任务：恢复三阶段、隔离校验、授权对账已自动化；RPO / RTO、30 天保留与加密须部署环境就绪后演练 |
| AC-TRF-01 | 已覆盖 | 24 / 0 | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-01-03-19-25-access.test.ts、AC-TRF-01-37-45-self-service.test.ts、AC-TRF-03-30-hr-form.test.ts 等 5 个 | 01_验收场景与追溯表.md:70 | — |
| AC-TRF-02 | 已覆盖 | 31 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TRF-01-03-19-25-access.test.ts、AC-TRF-02-40-44-manager.test.ts、AC-TRF-02-manager-approval.test.ts | 01_验收场景与追溯表.md:71 | — |
| AC-TRF-03 | 已覆盖 | 24 / 0 | AC-TRF-01-03-19-25-access.test.ts、AC-TRF-03-30-hr-form.test.ts、AC-TRF-03-process-binding.test.ts | 01_验收场景与追溯表.md:72 | — |
| AC-TRF-04 | 已覆盖 | 6 / 0 | AC-TRF-04-05-06-scheduled.test.ts | 01_验收场景与追溯表.md:73 | — |
| AC-TRF-05 | 已覆盖 | 9 / 0 | AC-APV-TRF-11-12-21.test.ts、AC-R1-E2E-02-branches.test.ts、AC-TRF-04-05-06-scheduled.test.ts | 01_验收场景与追溯表.md:74 | — |
| AC-TRF-06 | 已覆盖 | 9 / 0 | AC-APV-TRF-11-12-21.test.ts、AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-04-05-06-scheduled.test.ts | 01_验收场景与追溯表.md:75 | 复刻按 DEC-125 审批期间只存申请单、到期才写版本链（有意差异） |
| AC-TRF-07 | 已覆盖 | 7 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TRF-07-10-36-revoke-delete.test.ts | 01_验收场景与追溯表.md:76 | — |
| AC-TRF-08 | 已覆盖 | 12 / 0 | AC-R1-E2E-02-branches.test.ts、AC-R1-E2E-03-with-establishment.test.ts、AC-TRF-07-10-36-revoke-delete.test.ts、AC-TRF-08-job-history.test.ts 等 5 个 | 01_验收场景与追溯表.md:77 | — |
| AC-TRF-09 | 已覆盖 | 1 / 0 | AC-TRF-07-10-36-revoke-delete.test.ts | 01_验收场景与追溯表.md:78 | — |
| AC-TRF-10 | 已覆盖 | 2 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TRF-07-10-36-revoke-delete.test.ts | 01_验收场景与追溯表.md:79 | — |
| AC-TRF-11 | 已覆盖 | 1 / 0 | AC-APV-TRF-11-12-21.test.ts | 01_验收场景与追溯表.md:80 | — |
| AC-TRF-12 | 已覆盖 | 1 / 0 | AC-APV-TRF-11-12-21.test.ts | 01_验收场景与追溯表.md:81 | — |
| AC-TRF-13 | 已覆盖 | 2 / 0 | AC-TRF-13-14-15-26-linkage.test.ts | 01_验收场景与追溯表.md:82 | — |
| AC-TRF-14 | 已覆盖 | 2 / 0 | AC-TRF-13-14-15-26-linkage.test.ts | 01_验收场景与追溯表.md:83 | — |
| AC-TRF-15 | 已覆盖 | 4 / 0（含条件执行） | AC-R1-E2E-02-branches.test.ts、AC-TRF-13-14-15-26-linkage.test.ts、AC-TRF-15-lock-order-pg.test.ts | 01_验收场景与追溯表.md:84 | — |
| AC-TRF-16 | 未覆盖 | 0 / 0 | — | 01_验收场景与追溯表.md:85 | 已有 DEC：DEC-002：首版不接薪资档案，调动只记“是否调薪”并生成待调薪提醒（AC-LNK-05） |
| AC-TRF-17 | 未覆盖 | 0 / 0 | — | 01_验收场景与追溯表.md:86 | 已有 DEC：DEC-002，同 AC-TRF-16 |
| AC-TRF-18 | 已覆盖 | 11 / 0 | AC-TRF-03-30-hr-form.test.ts、AC-TRF-18-configuration.test.ts | 01_验收场景与追溯表.md:87 | — |
| AC-TRF-19 | 已覆盖 | 20 / 0 | AC-TRF-01-03-19-25-access.test.ts | 01_验收场景与追溯表.md:88 | — |
| AC-TRF-20 | 已覆盖 | 20 / 0 | AC-TRF-01-03-19-25-access.test.ts | 01_验收场景与追溯表.md:89 | — |
| AC-TRF-21 | 已覆盖 | 1 / 0 | AC-APV-TRF-11-12-21.test.ts | 01_验收场景与追溯表.md:90 | — |
| AC-TRF-22 | 未覆盖 | 0 / 0 | — | 01_验收场景与追溯表.md:91 | 已有 DEC：DEC-007：首期仅 PC，移动端立项后再测 |
| AC-TRF-23 | 未覆盖 | 3 / 0 | AC-TRF-01-03-19-25-access.test.ts、AC-TRF-03-30-hr-form.test.ts、AC-TRF-163-required.test.ts | 01_验收场景与追溯表.md:92 | 已有 DEC：DEC-226 不复刻；标题写“AC-TRF-01/23”的用例验证员工端表单复用（AC-TRF-01 范畴），不是本条“按钮描述”反向验证，不计覆盖 |
| AC-TRF-24 | 已覆盖 | 20 / 0 | AC-TRF-01-03-19-25-access.test.ts | 13_调动配置_本租户实际取值.md:119 | 定义在 `13` §4.1，集中追溯表漏列（OBS-01） |
| AC-TRF-25 | 已覆盖 | 20 / 0 | AC-TRF-01-03-19-25-access.test.ts | 13_调动配置_本租户实际取值.md:120 | 定义在 `13` §4.1，集中追溯表漏列（OBS-01） |
| AC-TRF-26 | 部分覆盖 | 3 / 0 | AC-TRF-13-14-15-26-linkage.test.ts | 13_调动配置_本租户实际取值.md:121 | 待取证：组织角色变更经组织模块追加版本已验证；“组织变更记录”对象（G-023）未取证、未单独建模 |
| AC-TRF-27 | 未覆盖 | 0 / 0 | — | 13_调动配置_本租户实际取值.md:122 | 已有 DEC：DEC-002：薪资显示范围不在首版；开关依赖声明 G-024 未取证 |
| AC-TRF-30 | 已覆盖 | 4 / 0 | AC-TRF-03-30-hr-form.test.ts | 01_验收场景与追溯表.md:95 | — |
| AC-TRF-31 | 已覆盖 | 23 / 0 | AC-TRF-13-14-15-26-linkage.test.ts、AC-TRF-31-LNK-linkage-failure.test.ts、AC-TRF-31-activation-failure.test.ts、AC-TRF-31-establishment.test.ts 等 5 个 | 01_验收场景与追溯表.md:96 | 含 R1-T08 失败框架段与 R1-T09 真实编制段，计 1 条 |
| AC-TRF-32 | 已覆盖 | 4 / 0 | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-32-AC-TEN-05-timezone.test.ts | 01_验收场景与追溯表.md:98 | — |

#### R1 任务新增（含 F 任务）

| 编号 | 状态 | 用例数（标题含编号 / 人工映射） | 测试文件 | 定义位置 | 备注 |
|---|---|---|---|---|---|
| AC-APV-01 | 已覆盖 | 3 / 0 | AC-APV-01-04-13-15-routing.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 14_审批流模型_实测.md:209 | — |
| AC-APV-02 | 已覆盖 | 3 / 0 | AC-APV-01-04-13-15-routing.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 14_审批流模型_实测.md:210 | — |
| AC-APV-03 | 已覆盖 | 1 / 0 | AC-APV-01-04-13-15-routing.test.ts | 14_审批流模型_实测.md:211 | — |
| AC-APV-04 | 已覆盖 | 2 / 0 | AC-APV-01-04-13-15-routing.test.ts、AC-R1-E2E-02-branches.test.ts | 14_审批流模型_实测.md:212 | — |
| AC-APV-05 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:213 | — |
| AC-APV-06 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:214 | — |
| AC-APV-07 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:215 | — |
| AC-APV-08 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:216 | — |
| AC-APV-09 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:217 | — |
| AC-APV-10 | 未覆盖 | 0 / 0 | — | 14_审批流模型_实测.md:218 | 已有 DEC：DEC-035：首版不做审批时效 |
| AC-APV-11 | 已覆盖 | 2 / 0 | AC-APV-11-12-simulation.test.ts | 14_审批流模型_实测.md:219 | — |
| AC-APV-12 | 已覆盖 | 3 / 0 | AC-APV-11-12-simulation.test.ts | 14_审批流模型_实测.md:220 | — |
| AC-APV-18 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:302 | — |
| AC-APV-19 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 14_审批流模型_实测.md:303 | — |
| AC-APV-20 | 已覆盖 | 1 / 0 | AC-APV-14-16-17-20-actions.test.ts | 01_验收场景与追溯表.md:313 | — |
| AC-APV-21 | 已覆盖 | 2 / 0 | AC-APV-21-26-countersign.test.ts | 01_验收场景与追溯表.md:319 | — |
| AC-APV-22 | 部分覆盖 | 2 / 0 | AC-APV-21-26-countersign.test.ts | 01_验收场景与追溯表.md:320 | 待取证：其余待办的收回方式为暂定口径（Q-M0-57，#56） |
| AC-APV-23 | 部分覆盖 | 2 / 0 | AC-APV-21-26-countersign.test.ts | 01_验收场景与追溯表.md:321 | 待取证：其余待办收回方式暂定（#56） |
| AC-APV-24 | 部分覆盖 | 4 / 0 | AC-APV-21-26-countersign.test.ts、AC-APV-32-36-countersign-round3.test.ts | 01_验收场景与追溯表.md:322 | 待取证：③ 全部处理完仍无动作达标暂定自动退回（#57） |
| AC-APV-25 | 部分覆盖 | 2 / 0 | AC-APV-21-26-countersign.test.ts | 01_验收场景与追溯表.md:323 | 待取证：会签驳回后其余待办的去向为推断（Q-M0-57，#56） |
| AC-APV-26 | 已覆盖 | 5 / 0 | AC-APV-21-26-countersign.test.ts | 01_验收场景与追溯表.md:324 | — |
| AC-APV-27 | 已覆盖 | 5 / 0 | AC-APV-27-28-parallel-add-sign.test.ts | 01_验收场景与追溯表.md:325 | — |
| AC-APV-28 | 已覆盖 | 2 / 0 | AC-APV-27-28-parallel-add-sign.test.ts | 01_验收场景与追溯表.md:326 | — |
| AC-APV-29 | 已覆盖 | 9 / 0 | AC-APV-29-countersign-lifecycle.test.ts | 01_验收场景与追溯表.md:327 | — |
| AC-APV-30 | 已覆盖 | 5 / 0（含条件执行） | AC-APV-30-countersign-concurrency-pg.test.ts | 01_验收场景与追溯表.md:328 | — |
| AC-APV-31 | 已覆盖 | 2 / 0 | AC-APV-31-countersign-simulation.test.ts | 01_验收场景与追溯表.md:329 | — |
| AC-APV-32 | 已覆盖 | 5 / 0 | AC-APV-32-36-countersign-round3.test.ts、AC-APV-32-37-countersign-round2.test.ts | 01_验收场景与追溯表.md:330 | — |
| AC-APV-33 | 已覆盖 | 2 / 0 | AC-APV-32-37-countersign-round2.test.ts | 01_验收场景与追溯表.md:331 | — |
| AC-APV-34 | 已覆盖 | 2 / 0 | AC-APV-32-37-countersign-round2.test.ts | 01_验收场景与追溯表.md:332 | — |
| AC-APV-35 | 已覆盖 | 1 / 0 | AC-APV-32-37-countersign-round2.test.ts | 01_验收场景与追溯表.md:333 | — |
| AC-APV-36 | 部分覆盖 | 7 / 0 | AC-APV-27-28-parallel-add-sign.test.ts、AC-APV-32-36-countersign-round3.test.ts、AC-APV-32-37-countersign-round2.test.ts | 01_验收场景与追溯表.md:334 | 待取证：会签前加签细节为暂定口径（DEC-152，代码留 TODO(需取证 DEC-152)） |
| AC-APV-37 | 已覆盖 | 1 / 0 | AC-APV-32-37-countersign-round2.test.ts | 01_验收场景与追溯表.md:335 | — |
| AC-APV-38 | 已覆盖 | 1 / 0 | AC-APV-38-42-direct-manager.test.ts | 01_验收场景与追溯表.md:336 | F-028 按复刻指定口径实现；原站来源待取证（#95），不影响复刻验收 |
| AC-APV-39 | 已覆盖 | 1 / 0 | AC-APV-38-42-direct-manager.test.ts | 01_验收场景与追溯表.md:337 | — |
| AC-APV-40 | 已覆盖 | 1 / 0 | AC-APV-38-42-direct-manager.test.ts | 01_验收场景与追溯表.md:338 | — |
| AC-APV-41 | 已覆盖 | 2 / 0 | AC-APV-38-42-direct-manager.test.ts | 01_验收场景与追溯表.md:339 | — |
| AC-APV-42 | 已覆盖 | 1 / 0 | AC-APV-38-42-direct-manager.test.ts | 01_验收场景与追溯表.md:340 | — |
| AC-AUD-01 | 已覆盖 | 3 / 0 | AC-AUD-01-02.test.ts | 20_审计日志_规格.md:56 | — |
| AC-AUD-02 | 已覆盖 | 3 / 0 | AC-AUD-01-02.test.ts、AC-R1-E2E-02-branches.test.ts | 20_审计日志_规格.md:57 | — |
| AC-AUD-03 | 已覆盖 | 4 / 0 | AC-AUD-03.test.ts | 20_审计日志_规格.md:58 | — |
| AC-AUD-04 | 已覆盖 | 2 / 0 | AC-AUD-04.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 20_审计日志_规格.md:59 | — |
| AC-AUD-05 | 已覆盖 | 4 / 0 | AC-AUD-05.test.ts | 20_审计日志_规格.md:60 | — |
| AC-AUD-06 | 已覆盖 | 4 / 0 | AC-AUD-06.test.ts | 20_审计日志_规格.md:61 | — |
| AC-AUD-07 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:241 | — |
| AC-AUD-08 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:242 | — |
| AC-AUD-09 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:243 | — |
| AC-AUD-10 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:244 | — |
| AC-AUD-11 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:245 | — |
| AC-AUD-12 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:246 | — |
| AC-AUD-13 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:247 | — |
| AC-AUD-14 | 已覆盖 | 14 / 0 | AC-AUD-07-14.test.ts | 01_验收场景与追溯表.md:248 | — |
| AC-EMP-12 | 已覆盖 | 4 / 0 | AC-EMP-12-personnel.test.ts | 01_验收场景与追溯表.md:40 | — |
| AC-EMP-13 | 已覆盖 | 4 / 0 | AC-EMP-13-14.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:41 | — |
| AC-EMP-14 | 已覆盖 | 2 / 0 | AC-EMP-13-14.test.ts | 01_验收场景与追溯表.md:42 | — |
| AC-EMP-15 | 已覆盖 | 11 / 0 | AC-EMP-15-approval.test.ts、AC-EMP-15.test.ts | 01_验收场景与追溯表.md:43 | — |
| AC-EMP-16 | 已覆盖 | 18 / 0（含条件执行） | AC-EMP-16-SUB-05-order-code.test.ts、AC-EMP-16-benchmark.test.ts、AC-EMP-16-order-code-lock-pg.test.ts、AC-EMP-16-order-code-scheduler.test.ts | 01_验收场景与追溯表.md:44 | — |
| AC-EST-01 | 已覆盖 | 5 / 0 | AC-EST-01.test.ts、AC-EST-scope-safety.test.ts | 01_验收场景与追溯表.md:192 | — |
| AC-EST-02 | 部分覆盖 | 1 / 0 | AC-EST-02.test.ts | 01_验收场景与追溯表.md:193 | 待其他任务：编制模块已自动化；调动入口非严格控编重叠超编时无提示（OBS-03），已登记 F-026，随其补测 |
| AC-EST-03 | 已覆盖 | 8 / 0 | AC-EST-03.test.ts、AC-EST-scope-safety.test.ts | 01_验收场景与追溯表.md:194 | — |
| AC-EST-04 | 已覆盖 | 5 / 0 | AC-EST-04.test.ts、AC-EST-scope-safety.test.ts | 01_验收场景与追溯表.md:195 | — |
| AC-EST-05 | 已覆盖 | 6 / 0 | AC-EST-05.test.ts、AC-EST-subdivision-period.test.ts、AC-EST-temporal.test.ts | 01_验收场景与追溯表.md:196 | — |
| AC-EST-06 | 已覆盖 | 1 / 0 | AC-EST-06.test.ts | 01_验收场景与追溯表.md:197 | — |
| AC-EST-07 | 已覆盖 | 1 / 0 | AC-EST-07.test.ts | 01_验收场景与追溯表.md:198 | — |
| AC-EST-08 | 已覆盖 | 9 / 0 | AC-R1-E2E-03-with-establishment.test.ts、AC-TRF-47-EST-08-with-establishment.test.ts | 01_验收场景与追溯表.md:199 | — |
| AC-EST-09 | 已覆盖 | 1 / 0 | AC-TRF-47-EST-08-with-establishment.test.ts | 01_验收场景与追溯表.md:200 | — |
| AC-EST-10 | 已覆盖 | 1 / 0 | AC-TRF-47-EST-08-with-establishment.test.ts | 01_验收场景与追溯表.md:201 | — |
| AC-EST-11 | 已覆盖 | 1 / 0 | AC-TRF-47-EST-08-with-establishment.test.ts | 01_验收场景与追溯表.md:202 | — |
| AC-EST-12 | 已覆盖 | 3 / 0（含条件执行） | AC-EST-12-carried-concurrency-pg.test.ts | 01_验收场景与追溯表.md:203 | — |
| AC-EST-13 | 部分覆盖 | 2 / 0 | AC-EST-13-carried-evidence-boundaries.test.ts | 01_验收场景与追溯表.md:204 | 待取证：取证结论前整单拒绝已自动化；多方案 / 调入职位无匹配细分的分配规则待取证（#78，Q-M0-74） |
| AC-EST-14 | 已覆盖 | 8 / 0 | AC-EST-14-carried-authorization.test.ts、AC-R1-E2E-03-with-establishment.test.ts | 01_验收场景与追溯表.md:205 | — |
| AC-EST-15 | 已覆盖 | 1 / 0 | AC-EST-15-carried-future-scheme.test.ts | 01_验收场景与追溯表.md:206 | — |
| AC-EST-16 | 已覆盖 | 4 / 0 | AC-EST-16-carried-audit.test.ts | 01_验收场景与追溯表.md:207 | — |
| AC-EST-17 | 已覆盖 | 3 / 0 | AC-EST-17-carried-scope-errors.test.ts | 01_验收场景与追溯表.md:208 | — |
| AC-EST-18 | 已覆盖 | 1 / 0 | AC-EST-18-19-carried-authorization-boundaries.test.ts | 01_验收场景与追溯表.md:209 | — |
| AC-EST-19 | 已覆盖 | 1 / 0 | AC-EST-18-19-carried-authorization-boundaries.test.ts | 01_验收场景与追溯表.md:210 | — |
| AC-FWD-13 | 已覆盖 | 2 / 0 | AC-FWD-13-14.test.ts | 01_验收场景与追溯表.md:62 | — |
| AC-FWD-14 | 已覆盖 | 5 / 0 | AC-FWD-13-14.test.ts、AC-FWD-14-scope.test.ts、AC-FWD-rules.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:63 | — |
| AC-FWD-15 | 已覆盖 | 2 / 0 | AC-FWD-15.test.ts | 01_验收场景与追溯表.md:64 | — |
| AC-JOB-01 | 已覆盖 | 11 / 0 | AC-JOB-01-02-04-06.test.ts、AC-JOB-assignment-safety.test.ts、AC-JOB-candidate-validity.test.ts、AC-JOB-reference-safety.test.ts | 01_验收场景与追溯表.md:218 | — |
| AC-JOB-02 | 已覆盖 | 11 / 0 | AC-JOB-01-02-04-06.test.ts、AC-JOB-future-ancestor-safety.test.ts、AC-JOB-tree-safety.test.ts | 01_验收场景与追溯表.md:219 | — |
| AC-JOB-03 | 已覆盖 | 7 / 0 | AC-JOB-03-05.test.ts、AC-JOB-personnel-safety.test.ts | 01_验收场景与追溯表.md:220 | — |
| AC-JOB-04 | 已覆盖 | 7 / 0 | AC-JOB-01-02-04-06.test.ts、AC-JOB-reference-safety.test.ts | 01_验收场景与追溯表.md:221 | — |
| AC-JOB-05 | 已覆盖 | 21 / 0 | AC-JOB-03-05.test.ts、AC-JOB-05-out-of-scope.test.ts、AC-JOB-05-port.test.ts、AC-JOB-05-scope.test.ts 等 5 个 | 01_验收场景与追溯表.md:222 | — |
| AC-JOB-07 | 已覆盖 | 6 / 0 | AC-JOB-07-org-whole-period.test.ts | 01_验收场景与追溯表.md:224 | — |
| AC-JOB-08 | 已覆盖 | 9 / 0 | AC-JOB-08-11-sequence-sync.test.ts、AC-JOB-08-review-activation.test.ts | 01_验收场景与追溯表.md:225 | — |
| AC-JOB-09 | 已覆盖 | 10 / 0 | AC-JOB-08-11-sequence-sync.test.ts、AC-JOB-09-candidates.test.ts、AC-JOB-09-sequence-form.test.ts | 01_验收场景与追溯表.md:226 | — |
| AC-JOB-10 | 已覆盖 | 14 / 0（含条件执行） | AC-JOB-08-11-sequence-sync.test.ts、AC-JOB-10-audit-failures.test.ts、AC-JOB-10-sequence-lock-pg.test.ts、AC-JOB-11-permissions.test.ts | 01_验收场景与追溯表.md:227 | — |
| AC-JOB-11 | 已覆盖 | 7 / 0 | AC-JOB-08-11-sequence-sync.test.ts、AC-JOB-11-limit.test.ts、AC-JOB-11-permissions.test.ts | 01_验收场景与追溯表.md:228 | — |
| AC-JOB-12 | 已覆盖 | 4 / 0 | AC-JOB-12-result-visibility.test.ts | 01_验收场景与追溯表.md:229 | — |
| AC-LNK-01 | 已覆盖 | 3 / 0 | AC-LNK-01-06.test.ts、AC-R1-E2E-02-branches.test.ts | 21_调动跨对象联动_对象规格.md:53 | — |
| AC-LNK-02 | 已覆盖 | 2 / 0 | AC-LNK-01-06.test.ts | 21_调动跨对象联动_对象规格.md:54 | — |
| AC-LNK-03 | 已覆盖 | 4 / 0 | AC-LNK-01-06.test.ts、AC-R1-E2E-02-branches.test.ts | 21_调动跨对象联动_对象规格.md:55 | — |
| AC-LNK-04 | 已覆盖 | 3 / 0 | AC-LNK-01-06.test.ts | 21_调动跨对象联动_对象规格.md:56 | — |
| AC-LNK-05 | 已覆盖 | 1 / 0 | AC-LNK-01-06.test.ts | 21_调动跨对象联动_对象规格.md:57 | — |
| AC-LNK-06 | 部分覆盖 | 1 / 0 | AC-LNK-01-06.test.ts | 21_调动跨对象联动_对象规格.md:58 | 待取证：兼职模块 R2-T05 未上线，DEC-191 只交付端口与替身；失效日期口径待取证（#71） |
| AC-ORG-10 | 已覆盖 | 5 / 0 | AC-ORG-10-11.test.ts | 01_验收场景与追溯表.md:173 | — |
| AC-ORG-11 | 已覆盖 | 13 / 0 | AC-ORG-10-11.test.ts、AC-ORG-version-safety.test.ts | 01_验收场景与追溯表.md:174 | — |
| AC-ORG-13 | 已覆盖 | 5 / 0 | AC-ORG-13-14.test.ts | 01_验收场景与追溯表.md:176 | — |
| AC-ORG-14 | 已覆盖 | 3 / 0 | AC-ORG-13-14.test.ts | 01_验收场景与追溯表.md:177 | — |
| AC-ORG-15 | 已覆盖 | 7 / 0 | AC-ORG-15.test.ts | 01_验收场景与追溯表.md:178 | — |
| AC-ORG-16 | 已覆盖 | 2 / 0 | AC-ORG-16.test.ts | 01_验收场景与追溯表.md:179 | — |
| AC-ORG-17 | 已覆盖 | 5 / 0 | AC-ORG-17-18.test.ts | 01_验收场景与追溯表.md:180 | — |
| AC-ORG-18 | 已覆盖 | 2 / 0 | AC-ORG-17-18.test.ts | 01_验收场景与追溯表.md:181 | — |
| AC-ORG-19 | 已覆盖 | 1 / 0 | AC-ORG-19.test.ts | 01_验收场景与追溯表.md:182 | — |
| AC-ORG-20 | 已覆盖 | 12 / 0 | AC-ORG-20.test.ts | 01_验收场景与追溯表.md:183 | — |
| AC-ORG-21 | 已覆盖 | 23 / 0（含条件执行） | AC-ORG-21-concurrency-pg.test.ts、AC-ORG-21-expiry.test.ts、AC-ORG-21-resource-locks-pg.test.ts、AC-ORG-21.test.ts | 01_验收场景与追溯表.md:184 | — |
| AC-PRM-09 | 已覆盖 | 2 / 0 | AC-PRM-09-11.test.ts | 01_验收场景与追溯表.md:130 | 口径由 DEC-143 定：余额 0 仍允许授予并提示超额 |
| AC-PRM-10 | 已覆盖 | 4 / 0 | AC-PRM-10.test.ts | 01_验收场景与追溯表.md:131 | — |
| AC-PRM-11 | 已覆盖 | 1 / 0 | AC-PRM-09-11.test.ts | 01_验收场景与追溯表.md:132 | — |
| AC-PRM-12 | 已覆盖 | 0 / 2 | AC-PRM-36.test.ts、AC-PRM-employment-scope.test.ts | 01_验收场景与追溯表.md:133 | 复刻按 DEC-177：调出范围后只见在范围内期间的记录，asOf 回溯也不恢复 |
| AC-PRM-13 | 未覆盖 | 0 / 0 | — | 01_验收场景与追溯表.md:134 | 建议补测：动态授权规则停用后自动回收身份（DEC-023 口径）尚无用例 |
| AC-PRM-14 | 已覆盖 | 6 / 0 | AC-PRM-data-scope-admin.test.ts | 01_验收场景与追溯表.md:135 | — |
| AC-PRM-15 | 已覆盖 | 6 / 0 | AC-PRM-data-scope-admin.test.ts | 01_验收场景与追溯表.md:136 | — |
| AC-PRM-16 | 已覆盖 | 6 / 0 | AC-PRM-data-scope-admin.test.ts | 01_验收场景与追溯表.md:137 | — |
| AC-PRM-17 | 已覆盖 | 13 / 0 | AC-PRM-policy-ambiguity.test.ts、AC-PRM-scope-policy-admin.test.ts、AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:138 | — |
| AC-PRM-18 | 已覆盖 | 9 / 0 | AC-PRM-scope-policy-admin.test.ts、AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:139 | — |
| AC-PRM-19 | 已覆盖 | 1 / 0 | AC-PRM-19.test.ts | 01_验收场景与追溯表.md:140 | — |
| AC-PRM-20 | 已覆盖 | 1 / 0 | AC-PRM-20.test.ts | 01_验收场景与追溯表.md:141 | — |
| AC-PRM-21 | 已覆盖 | 9 / 0 | AC-PRM-scope-policy-admin.test.ts、AC-PRM-scope-resolution.test.ts | 01_验收场景与追溯表.md:142 | — |
| AC-PRM-22 | 已覆盖 | 16 / 0 | AC-PRM-22.test.ts、AC-PRM-employment-scope.test.ts、AC-PRM-employment-wiring.test.ts | 01_验收场景与追溯表.md:143 | — |
| AC-PRM-23 | 已覆盖 | 2 / 0 | AC-PRM-23.test.ts | 01_验收场景与追溯表.md:144 | — |
| AC-PRM-24 | 部分覆盖 | 0 / 1 | AC-PRM-01.test.ts | 01_验收场景与追溯表.md:145 | 建议补测：后端以对象权限为准已由 AC-PRM-01 验证；“无菜单配置但有对象权限 → 按范围取数”的正向用例未单独写 |
| AC-PRM-25 | 已覆盖 | 0 / 1 | AC-PRM-01.test.ts | 01_验收场景与追溯表.md:146 | 以机器可读错误码 FORBIDDEN 表示“无权限”（AGENTS §10 不靠中文文案判断） |
| AC-PRM-26 | 已覆盖 | 1 / 1 | AC-PRM-30.test.ts、AC-R1-E2E-01-transfer-closure.test.ts | 01_验收场景与追溯表.md:147 | “无数据”见端到端步骤 5（hasDataPermission 为真、列表为空）；“无数据权限”见 AC-PRM-30（hasDataPermission 为假） |
| AC-PRM-27 | 已覆盖 | 1 / 0 | AC-R1-E2E-02-branches.test.ts | 01_验收场景与追溯表.md:148 | 复刻以“即时派生”实现 DEC-020 的自动获得，不写授权行（Q-M0-71） |
| AC-PRM-28 | 已覆盖 | 1 / 0 | AC-R1-E2E-02-branches.test.ts | 01_验收场景与追溯表.md:149 | — |
| AC-PRM-30 | 已覆盖 | 6 / 0 | AC-PRM-30.test.ts | 01_验收场景与追溯表.md:151 | — |
| AC-PRM-31 | 已覆盖 | 4 / 0 | AC-PRM-31-32-33.test.ts | 01_验收场景与追溯表.md:152 | — |
| AC-PRM-32 | 已覆盖 | 4 / 0 | AC-PRM-31-32-33.test.ts | 01_验收场景与追溯表.md:153 | — |
| AC-PRM-33 | 已覆盖 | 5 / 0 | AC-PRM-31-32-33.test.ts | 01_验收场景与追溯表.md:154 | — |
| AC-PRM-34 | 已覆盖 | 5 / 0 | AC-PRM-34.test.ts | 01_验收场景与追溯表.md:155 | — |
| AC-PRM-35 | 已覆盖 | 7 / 0 | AC-PRM-35.test.ts | 01_验收场景与追溯表.md:156 | — |
| AC-PRM-36 | 已覆盖 | 7 / 0 | AC-PRM-36.test.ts | 01_验收场景与追溯表.md:157 | — |
| AC-PRM-37 | 已覆盖 | 1 / 0 | AC-PRM-org-job-est-wiring.test.ts | 01_验收场景与追溯表.md:158 | — |
| AC-SUB-01 | 已覆盖 | 11 / 0 | AC-SUB-01-04.test.ts、AC-SUB-03-requests.test.ts、AC-SUB-platform.test.ts | 22_人员子集_对象规格.md:52 | — |
| AC-SUB-02 | 已覆盖 | 6 / 0 | AC-SUB-02-same-day-sync.test.ts、AC-SUB-02-sync.test.ts | 22_人员子集_对象规格.md:53 | — |
| AC-SUB-03 | 已覆盖 | 1 / 0 | AC-SUB-03-requests.test.ts | 22_人员子集_对象规格.md:54 | — |
| AC-SUB-04 | 已覆盖 | 7 / 0 | AC-SUB-01-04.test.ts、AC-SUB-04-sorting.test.ts | 22_人员子集_对象规格.md:55 | — |
| AC-SUB-05 | 已覆盖 | 10 / 0 | AC-EMP-16-SUB-05-order-code.test.ts | 22_人员子集_对象规格.md:56 | — |
| AC-TEN-01 | 已覆盖 | 4 / 0 | AC-ORG-TEN-01.test.ts、AC-R1-E2E-02-branches.test.ts、AC-TEN-01.test.ts | 01_验收场景与追溯表.md:256 | — |
| AC-TEN-02 | 已覆盖 | 11 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TEN-02.test.ts | 01_验收场景与追溯表.md:257 | — |
| AC-TEN-03 | 已覆盖 | 9 / 0 | AC-TEN-03.test.ts | 01_验收场景与追溯表.md:258 | — |
| AC-TEN-04 | 已覆盖 | 11 / 0 | AC-TEN-04.test.ts | 01_验收场景与追溯表.md:259 | — |
| AC-TRF-28 | 已覆盖 | 2 / 0 | AC-APV-14-16-17-20-actions.test.ts、AC-R1-E2E-02-branches.test.ts | 01_验收场景与追溯表.md:93 | — |
| AC-TRF-29 | 已覆盖 | 1 / 0 | AC-APV-05-09-18-19-versions.test.ts | 01_验收场景与追溯表.md:94 | — |
| AC-TRF-33 | 已覆盖 | 7 / 0 | AC-TRF-33-35-order.test.ts | 01_验收场景与追溯表.md:99 | — |
| AC-TRF-34 | 已覆盖 | 1 / 0 | AC-TRF-core-validation.test.ts | 01_验收场景与追溯表.md:100 | — |
| AC-TRF-35 | 已覆盖 | 3 / 0 | AC-TRF-33-35-order.test.ts | 01_验收场景与追溯表.md:101 | — |
| AC-TRF-36 | 已覆盖 | 3 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TRF-07-10-36-revoke-delete.test.ts | 01_验收场景与追溯表.md:102 | — |
| AC-TRF-37 | 已覆盖 | 11 / 0 | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-01-37-45-self-service.test.ts、AC-TRF-37-39-45-self-disclosure.test.ts | 01_验收场景与追溯表.md:103 | — |
| AC-TRF-38 | 已覆盖 | 4 / 0 | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-01-37-45-self-service.test.ts、AC-TRF-38-45-self-service-web.test.ts | 01_验收场景与追溯表.md:104 | — |
| AC-TRF-39 | 已覆盖 | 24 / 0 | AC-TRF-01-37-45-self-service.test.ts、AC-TRF-37-39-45-self-disclosure.test.ts、AC-TRF-39-self-adapter.test.ts、AC-TRF-39-self-entry-parity.test.ts 等 5 个 | 01_验收场景与追溯表.md:105 | — |
| AC-TRF-40 | 已覆盖 | 15 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TRF-01-37-45-self-service.test.ts、AC-TRF-02-40-44-manager.test.ts、AC-TRF-40-41-manager-review.test.ts | 01_验收场景与追溯表.md:106 | — |
| AC-TRF-41 | 已覆盖 | 15 / 0 | AC-TRF-02-40-44-manager.test.ts、AC-TRF-40-41-manager-review.test.ts、AC-TRF-41-42-manager-round3.test.ts、AC-TRF-41-manager-reference-ui.test.ts | 01_验收场景与追溯表.md:107 | — |
| AC-TRF-42 | 部分覆盖 | 11 / 0 | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-02-40-44-manager.test.ts、AC-TRF-41-42-manager-round3.test.ts、AC-TRF-42-43-manager-ui.test.ts | 01_验收场景与追溯表.md:108 | 待其他任务：“试用中 / 待入职”依赖人员状态 / 入职状态模型，由 F-022 补齐后补测 |
| AC-TRF-43 | 已覆盖 | 2 / 0 | AC-TRF-02-40-44-manager.test.ts、AC-TRF-42-43-manager-ui.test.ts | 01_验收场景与追溯表.md:109 | — |
| AC-TRF-44 | 已覆盖 | 2 / 0 | AC-R1-E2E-02-branches.test.ts、AC-TRF-02-40-44-manager.test.ts | 01_验收场景与追溯表.md:110 | — |
| AC-TRF-45 | 已覆盖 | 11 / 0 | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-01-37-45-self-service.test.ts、AC-TRF-37-39-45-self-disclosure.test.ts、AC-TRF-38-45-self-service-web.test.ts | 01_验收场景与追溯表.md:111 | — |
| AC-TRF-46 | 已覆盖 | 5 / 0（含条件执行） | AC-R1-E2E-01-transfer-closure.test.ts、AC-TRF-46-self-audit.test.ts、AC-TRF-46-self-locks-pg.test.ts | 01_验收场景与追溯表.md:112 | — |
| AC-TRF-47 | 已覆盖 | 11 / 0 | AC-R1-E2E-03-with-establishment.test.ts、AC-TRF-47-EST-08-with-establishment.test.ts、AC-TRF-47-carried-permissions.test.ts | 01_验收场景与追溯表.md:113 | — |
| AC-TRF-48 | 已覆盖 | 5 / 0 | AC-R1-E2E-03-with-establishment.test.ts、AC-TRF-48-carried-rollback.test.ts | 01_验收场景与追溯表.md:114 | — |
| AC-TRF-49 | 已覆盖 | 7 / 0 | AC-R1-E2E-03-with-establishment.test.ts、AC-TRF-47-EST-08-with-establishment.test.ts、AC-TRF-49-carried-projection.test.ts | 01_验收场景与追溯表.md:115 | — |
| AC-TRF-50 | 已覆盖 | 3 / 0 | AC-TRF-50-carried-shared-form.test.ts | 01_验收场景与追溯表.md:116 | — |

## 4. 缺陷清单

端到端串联（主线 6 步、分支 7 组、带编调动 4 步）发现 **1 项产品缺陷**：OBS-03（P2），非严格控编重叠调入超编时无提示，已登记 **F-026** 并派发。它不影响 R1 出口标准的主链路。其余均为观察项，包括文档漏列、已决口径、行为确认与待补跑：

| 编号 | 类型 | 内容 | 涉及模块 / DEC | 建议 |
|---|---|---|---|---|
| OBS-01 | 文档漏列 | AC-TRF-24～27 已在 `docs/02_业务建模/13_调动配置_本租户实际取值.md` §4.1 定义（标准 / 自定义表单目标范围、组织角色变更记录、薪资范围开关依赖），集中追溯表 `docs/05_验收/01` C 节漏列这四条 | 文档 | 编排窗口把 `13` §4.1 的四条补进追溯表（口径照抄，不改） |
| OBS-02 | 已决 | AC-TRF-23（人事申请按钮描述）与 AC-PRM-02（菜单上下文鉴权）均为原站实现细节 → 用户 2026-10-07 决定 **DEC-226**（AC-TRF-23 不复刻）、**DEC-227**（AC-PRM-02 并入 AC-PRM-24） | R1-T13、R1-T01 | 本报告已按两条 DEC 更新状态；追溯表状态列由编排窗口同步 |
| OBS-03 | **产品缺陷（P2，已登记 F-026）** | 复现：目标部门非严格控编、容量 1；HR 先保存一名员工 10-20 调入（201），再保存另一名员工 10-05 调入，两段占编在 10-20 起重叠超编。期望（AC-EST-02）：第二笔允许保存但返回超编提示 / 二次确认。实际：第二笔 201，响应无任何超编警告或确认信息（astra 首审在 head 5b894d1 复现）。原因：编制检查按目标日至周期末峰值只在严格控编时拦截，非严格控编不生成提示（RP-056 遗留） | R1-T09 `transfer/service.ts` 编制判定、DEC-145、AC-EST-02 | 已登记 **F-026**，10-07 已派 Codex（`后续任务.md` §30）；待补测试：重叠区间与先后顺序两种回归，调动保存 / 预览返回超编警告 |
| OBS-04 | 行为确认 | 驳回后 HR 撤回再提交，沿用原实例与原流程版本、从首节点重新流转（日志保留 reject / withdraw），符合 DEC-103 | R1-T07、DEC-103 | 无需处理；界面走查时核对“审批记录”页展示两轮记录 |
| OBS-05 | 行为确认 | 带联动的调动在生效前，联动详情只有选项、无转交记录（`dutyTransfer = null`），记录在生效时生成 | R1-T10 | 无需处理；前端应按“选项”渲染生效前状态 |
| OBS-06 | 测试基线 | 真实授权器下 HR 若无组织对象查看权，组织列表 403（符合权限模型，端到端夹具已给 HR 授组织只读） | R1-T01 | 无需处理；提示界面走查时 HR 身份须含组织对象 |
| OBS-07 | 待补跑 | 带编调动（#79）已在第三轮合并 main 后补跑（E2E-03）；组织改名 / 改上级联动任职（#83）仍不在基线内 | F-018、F-007 | #83 合并后合并 main、重跑端到端用例并更新本报告（§2.3） |

## 5. 结论

- R1 出口标准“员工发起调动申请 → 审批 → HR 执行 → 生效 → 任职记录版本链与向后更新正确 → 员工与经理侧可见变更”在 main 95c57f2 上以真实权限端到端跑通。另外验证了七个分支：经理发起、联动、驳回重提、撤销删除、迟到执行、跨租户隔离、经理身份自动取得与回收；并补跑了 #79 带编调动的保存调编、审批、定时生效与回退。
- AC 覆盖以 §3 人工核对结果为准，未改变任何 AC 口径；脚本统计待 F-030（DEC-254）完成后复核。
- 组织改名 / 改行政上级联动任职待 #83 合并后补跑。
