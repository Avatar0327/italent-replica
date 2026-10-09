# R3-T04 PR-B 拆分方案（DEC-353 已确认）

> 状态：**已确认（DEC-353）**，B1 已实现（#148），前置小 PR 为 DEC-361 种子补装登记表（#160，已合并）。设计 §12 把 PR-B 写成一个 PR（“§2.2～2.4；表单三档；位置字段占用与恰两行；计算规则保存校验；项目状态机与可见性；人才标准引用 + 引用守卫；1 个迁移”），实际体量远超 1500 行，故按下面拆分。
> 作用对象：全部是复刻系统，不涉及北森测试租户。

## 1. 为什么超出

PR-A 的准备度字典是最简单的配置对象（1 张表、5 条路由），实际体量约 1050 行（schema + service + routes + input 约 320、权限接入 129、测试约 550、路由声明 49）。设计 §2.2～2.4 共约 14 个聚合根、约 40 张表，估算 7000～9000 行；再叠加 F-039 声明与必需项表、范围外 404 / 缺按钮 403 / 字段裁剪 / 幂等重放 / 被引用拒删 / 真 PG 并发等必须逐项覆盖的负例，一个 PR 无法在 1500 行内完成，也无法审查。

## 2. 拆分（共 9 个子 PR + DEC-361 前置 PR；依赖关系见表末，B2～B5 在 B1 合并后可并行，B6a 起按顺序）

约定：每个子 PR 带自己的表与迁移（迁移号合并时按 DEC-221 顺延）、自己的 `AC-TR-*` 测试（先失败后实现，分两次提交）、自己的路由权限声明文档（`docs/08_设计/R3-T04_PR-Bx_路由声明.md`，F-039 格式）。分支 `claude/R3-T04-pr-bN-简述`。对象目录、审计标签、审计查看规则都落在 PR-A 已指定的 `packages/domain/src/talent-review/catalog.ts` 追加；除此之外只有 §3 第 6 条列出的两类共享文件例外（预置接线走 DEC-361 登记表，F-039 必需表登记由 CI 强制）。

| 子 PR | 内容（设计章节） | 主要表 | 估算 | 前置 |
|---|---|---|---|---|
| **B1 配置骨架与字段目录** | 提取配置对象通用骨架（列表 / 详情 / 增改删 / 审计 / 引用守卫登记，供 B2～B5 复用）；租户设置（含系统主体指定，§4.1）；盘点分类；盘点角色；字段目录 + 选项（pair 双向一致、多选标记、预置字段种子 §2.7）；字段权限目录接入 `registerTenantFieldSource` **顺延到 PR-C**（`TalentReview.Object` 对象随 PR-C 才登记，B1 里接入无法验证；B1 实施时确定） | settings、categories、roles、fields、field_options | 1400 | — |
| **B2 评价规则、模块等级、字段映射** | 评价规则 + 等级；模块等级 + 项（区间含下界不含上界）；字段映射（类型相同、选项值集合相同）；被模板引用拒删（守卫登记，B6 接入） | score_rules、_levels、module_grades、_items、field_mappings | 1200 | B1 |
| **B3 表单三档与流程定义** | 盘点内容表单 + 字段三档 + required（§2.2、DEC-306①）；预置四个表单；流程定义 + 节点 + 角色（countersign 约束、node_key 不可改）；`AC-TR-form-permissions`（定义侧） | forms、form_fields、flows、nodes、node_roles | 1300 | B1 |
| **B4 九宫格** | 九宫格、轴分段、格子、位置字段占用（租户内唯一 + 每九宫格最多两行 + 保存命令恰两行 `MATRIX_POSITION_FIELDS_INCOMPLETE`）、比例规则组与规则与格子集合；预置两个九宫格；`AC-TR-08-matrix` + 真 PG 交叉列并发 | matrices、axis_levels、cells、position_fields、ratio_rule_groups、_rules、_rule_cells | 1500 | B1 |
| **B5 计算规则** | 计算规则 + 计算项目；保存校验 `validateFormula`；`orderComputationItems` 循环 / 依赖提示不拦截（DEC-274）；`uses_ranking` 派生；目标字段类型允许性 `TARGET_FIELD_NOT_ALLOWED`；**公式引用多选字段 400 `MULTI_OPTION_IN_FORMULA`**（DEC-314②）；规则 `revision` 递增 | calc_rules、_items | 1100 | B1 |
| **B6a 模板结构与版本** | 模板 + 版本（每次结构保存新版本）+ 步骤 + 角色 + 模块 + 等级 / 表单快照 + 模块字段 + 步骤模块权限 + 步骤表单选用 + 结果设置公式；`configErrors: WEIGHT_SUM_NOT_100`；模板向下公开 / owner_org 可见性谓词（§6.2，B7 复用）；人才标准引用校验 `CRITERION_NOT_REFERENCEABLE` + `registerTalentCriterionReferenceGuard`（§5.1，模板侧）；`AC-TR-04-template`、`AC-TR-15-freeze` | templates、_versions、_steps、_step_roles、_modules、_module_levels、_module_fields、_step_module_permissions、_step_forms、_result_rules | 1500 | B2、B3、B5（结果公式 / 字段）|
| **B6b 模板复制、删除、引用保护** | 复制（流程清空、权限与表单恢复默认、停用）；删除被项目 / 对象引用 409 `TEMPLATE_IN_USE`；模板停用；`AC-TR-template-copy`；被引用的评价规则 / 表单 / 流程 / 九宫格 / 计算规则的拒删守卫接线 | — | 800 | B6a |
| **B7a 项目配置与状态机** | 项目 CRUD（计划起止必填、业务日期、年度 / 周期、所属组织）；共享组织、排除分类、项目九宫格 + 规则组、校准原因字段；状态机 new → in_progress → ended → in_progress、删除须无对象；`AC-TR-project`、`AC-TR-01`（定义侧）；`calc_state` 派生列只建不写（PR-C 填） | projects、shared_orgs、excluded_categories、project_matrices、calibration_fields | 1500 | B4、B5、B6a |
| **B7b 项目可见性与人才标准引用** | 项目可见性谓词（管理 / 向下公开只读 / 共享组织只读，`PROJECT_READONLY` 403，§6.2）；项目侧人才标准引用校验 + 引用守卫；`AC-TR-03-visibility`（含 TenantBase 有范围 / TalentReview 无范围） | — | 900 | B7a |

估算均含测试与路由声明、不含迁移 SQL 与快照；B4、B6a、B7a 贴着 1500 线，开发中若实测超出，会再停下报告而不是硬塞。

依赖图：B1 →（B2、B3、B4、B5 可并行）→ B6a → B6b；B4 + B5 + B6a → B7a → B7b。

## 3. 已确认事项（DEC-353）

1. 拆成 9 个子 PR；每个有表的子 PR 带自己的迁移（合并时按 DEC-221 顺延）。
2. B1 先做；B1 合并后，B2～B5 分两个会话并行（B2+B3、B4+B5），之后依次 B6a → B6b → B7a → B7b。
3. B7a 只做状态转换与 PR-B 内可验证的守卫；start / end / restart 相关由 PR-C / PR-D 通过守卫点接入。
4. F-039（#110）已合并：每个子 PR 按 F-039 格式在 `policy.ts` 声明、在 `tests/acceptance/support/route-policy/required/` 登记义务与证据（CI 强制）；路由声明文档仍随子 PR 提交，便于审查。
5. **DEC-361**：预置数据统一走种子补装登记表（`apps/api/src/seeds/`，前置 PR #160）；各子 PR 的预置（九宫格、表单、映射等）在自己的模块里 `registerSeed`，不再在 `provisioning.ts` 直接调用安装函数。B1 的 25 个预置字段已按此接入。
6. 共享文件：对象目录、审计标签、审计查看规则落在 PR-A 指定的 `packages/domain/src/talent-review/catalog.ts` 追加；除此之外的例外有两类——开通接线（`provisioning.ts`，已由 DEC-361 统一为一次 `installMissingSeeds` 调用，各子 PR 不再改）和 F-039 必需表登记（`required/`、基准、摘要、`primitives.ts` 守卫名，按 CI 强制要求随路由改动）。

## 4. 实施记录

- B1（#148）：设置、分类、角色、字段目录 + 预置字段；字段权限目录接入（`registerTenantFieldSource`）顺延到 PR-C，因为 `TalentReview.Object` 对象随 PR-C 才登记。
- 每个子 PR 单独先交失败测试再交实现，并走 dev-selfcheck 与“开发完成，待审”。
