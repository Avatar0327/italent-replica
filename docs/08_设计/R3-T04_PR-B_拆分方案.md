# R3-T04 PR-B 拆分方案（待总编排确认；DEC-338：实现 PR 建议 ≤ 1500 行，不含生成文件）

> 状态：**提议，未开工**。设计 §12 把 PR-B 写成一个 PR（“§2.2～2.4；表单三档；位置字段占用与恰两行；计算规则保存校验；项目状态机与可见性；人才标准引用 + 引用守卫；1 个迁移”）。按下面的估算，一个 PR 装不下，所以先停下等确认。
> 作用对象：全部是复刻系统，不涉及北森测试租户。

## 1. 为什么超出

PR-A 的准备度字典是最简单的配置对象（1 张表、5 条路由），实际体量如下（不含迁移快照）：

| 部分 | 行数 |
|---|---|
| schema 40 + service 160 + routes 100 + input 19 | 约 320 |
| 权限接入 access.ts（共用骨架） | 129 |
| 测试 4 个文件（AC-TR-readiness、-permissions、-sidechannel + support） | 约 550 |
| 路由权限声明文档 | 49 |
| 合计 | 约 1050 |

设计 §2.2～2.4 共约 14 个聚合根、约 40 张表（设置、分类、角色、评价规则与等级、模块等级与项、字段目录与选项、字段映射、表单与字段、流程与节点与角色、九宫格与轴分段与格子与位置字段与比例规则组、计算规则与项目、模板与版本与步骤与模块与权限与表单选用与结果规则、项目与四张子表）。即使用通用 CRUD 骨架压缩重复，也只能把每个聚合根压到约 400～700 行（含测试），合计估算 **7000～9000 行**，是 1500 行建议值的 5 倍左右。再叠加这些必须逐项覆盖的负例：范围外 404、缺按钮 403、字段裁剪、幂等重放复核、被引用拒删 409、真 PG 并发。一个 PR 无法在 1500 行内完成，也无法审查。

## 2. 拆分提议（共 9 个 PR，均在 PR-A 合并后的 main 上依次提交）

约定：每个子 PR 带自己的表与迁移（迁移号合并时按 DEC-221 顺延）、自己的 `AC-TR-*` 测试（先失败后实现，分两次提交）、自己的路由权限声明文档（`docs/08_设计/R3-T04_PR-Bx_路由声明.md`，F-039 格式）。分支 `claude/R3-T04-pr-bN-简述`。对象目录、审计标签、审计查看规则都落在 PR-A 已指定的 `packages/domain/src/talent-review/catalog.ts` 追加，**不再改其他共享文件**。

| 子 PR | 内容（设计章节） | 主要表 | 估算 | 前置 |
|---|---|---|---|---|
| **B1 配置骨架与字段目录** | 提取配置对象通用骨架（列表 / 详情 / 增改删 / 审计 / 引用守卫登记，供 B2～B5 复用）；租户设置（含系统主体指定，§4.1）；盘点分类；盘点角色；字段目录 + 选项（pair 双向一致、多选标记、预置字段种子 §2.7）；字段权限目录接入 `registerTenantFieldSource`（PR-A 已留扩展点） | settings、categories、roles、fields、field_options | 1400 | — |
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

## 3. 需要总编排确认的事

1. **是否同意按上表拆成 9 个子 PR**（替代设计 §12 的“PR-B 一个 PR、1 个迁移”）。迁移因此由 1 个变为每个有表的子 PR 各 1 个（B6b、B7b 无表），共 7 个，合并时顺延（DEC-221）。如果更希望保持“PR-B 只占 1 个迁移”，备选是先出 **B0 全部 schema + 迁移（约 900 行 schema，无路由）**，其余子 PR 不再带迁移；缺点是 B0 无法用业务测试验证、后续实现发现表要改时仍要追加迁移。**建议按上表各自带表。**
2. **并行度**：B2～B5 在 B1 合并后可并行（互不依赖，但都追加 `catalog.ts` 与 `schema/talent-review.ts` 末尾，会有机械冲突，由合并窗口顺延处理）。是否分给多个开发窗口，还是本窗口依次做？默认本窗口依次做。
3. **项目状态机的范围**（B7a）：设计 §3.1 的 start / end / restart 带有对象、calc run、同步 run 的副作用，对象与 run 在 PR-C / PR-D 才有。建议 B7a 只做状态转换本身与“删除须无对象”“已结束项目拒绝编辑”这些 PR-B 内能验证的守卫；start 的“执行人解析与建任务”、end 的“比例校验与 calc run 409”、restart 的“同步 run superseded”由 PR-C / PR-D 通过登记守卫点接入。是否同意？不同意的话需要说明 start / end 在 PR-B 中的预期表现。
4. **路由权限声明**：F-039（#110）还没合并，`tests/acceptance/support/route-policy/required/` 尚不存在，所以每个子 PR 仍按 PR-A 的做法写声明文档（`docs/08_设计/R3-T04_PR-Bx_路由声明.md`，F-039 格式），#110 合并后再补显式必需表登记。

## 4. 本 PR 说明

本 Draft PR 只含这份拆分方案，没有代码。收到确认（或修改后的拆分）后，从 B1 起开工；每个子 PR 单独先交失败测试再交实现，并走 dev-selfcheck 与“开发完成，待审”。
