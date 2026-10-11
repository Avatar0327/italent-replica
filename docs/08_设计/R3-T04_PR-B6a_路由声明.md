# R3-T04 PR-B6a 盘点模板：结构与版本（路由权限声明）

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.3（templates / versions / steps / step_roles / modules / module_levels / module_fields / step_module_permissions）、§3.3（流程节点在模板版本内冻结）、§5.1（人才标准引用）、§6.1、§6.2（模板可见性）、§6.5、§7；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；DEC-306①、DEC-304、DEC-043、DEC-080、DEC-082、DEC-067、DEC-216、DEC-194、DEC-388①、DEC-391、DEC-387。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/template-policy.ts`，必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts` 的 `TEMPLATE_REQUIRED`（CI 强制）。
> 范围：新增 5 条路由（`/api/tenant/talent-review/templates`）。作用对象：复刻系统，不涉及北森测试租户。
> **本 PR 不含**：步骤表单选用（`step_forms`）与结果设置公式（`result_rules`，DEC-387 / DEC-391 的落地项）——实测体量超出 1500 行，已按 DEC-396 在 PR 上贴【等决定】，拆为 B6a-2。

## 1. 共用契约

- 应用 `TalentReview`；对象 = `TalentReview.Template`（`create@list / update@detail / delete@detail`）。字段：`name / ownerOrgId / downwardPublic / flowId / enabled / steps / modules / permissions`（嵌套字段，权限随字段），系统字段 `currentVersionNo / versionNo / accessLevel / configErrors / versions`（派生，只读）。不属于 `TALENT_REVIEW_CONFIG_OBJECTS`（有组织字段，不是设置类）。**DEC-415（用户定）**：新对象的“看全部”默认给所属模块的预置管理员——本 PR 给盘点管理员预置 `Template`，并把 B2b 字段映射、B3 表单 / 流程一并预置（`SEE_ALL_BACKFILL_APPROVED` 新增 4 行 DEC-415，`TALENT_REVIEW_SEE_ALL_UNAPPROVED` 清空；`TALENT_REVIEW_SEE_ALL_OBJECTS` = 配置对象 + 模板）；非管理员身份的范围不变。授权码集合变化：`STANDARD_GRANT_VERSION` 11 → 12（最后一次合 main 时按 DEC-404 取 main 当时值 +1）。
- **数据范围**（设计 §6.2）：按（用户 × TalentReview）的组织范围 ∪ 创建人；缺省为空（fail-closed）。列表在 SQL 分页前用 `templateReadable`（`readableSql`：范围内 ∪ 创建人 ∪ 向下公开）过滤，B7 项目选用模板复用同一谓词。详情 / 写入 / 重放中，范围外与不存在同为 `404 NOT_FOUND`。
- **向下公开**：模板 `downwardPublic = true` 时，查看人范围内有其下级组织的可查看与选用，`accessLevel = readonly`，不能改不能删（`403 TEMPLATE_PUBLIC_DOWN_READONLY`，在行锁后、revision 之前判定）；范围内 / 创建人命中为 `manage`。审计查看规则**不因向下公开放宽**（`audit/visibility.ts` 登记 `orgRule`，按日志写入时的所属组织）。
- **新建 / 改所属组织**：目标组织须在范围内（不因创建人或向下公开放行，DEC-082），范围外 404；组织不存在 404。
- 响应按对象当前字段查看权裁剪（`trimModuleResponse`，键缺席）；写响应与幂等重放同样按当前权限裁剪。列表只含头部（不含 `steps / modules / permissions / configErrors / versions`），详情含当前版本的完整结构，`?version=n` 读历史版本（不存在 404）。
- REV = 缺或非法 `If-Match` 时 `400 REVISION_REQUIRED`；revision 不符 `409 REVISION_CONFLICT`；新建要求 revision = 0。IDEM = 缺 `Idempotency-Key` 时 `400 IDEMPOTENCY_KEY_REQUIRED`；同键异内容 `409 IDEMPOTENCY_CONFLICT`。
- **写命令的权限复核（B4 / B3 `runGuarded` 模式）**：对象操作权、按钮、所属组织范围、载荷逐字段编辑权、被引用目录（流程 / 评价规则 / 模块等级 / 盘点字段）的查看权与范围都在命令事务内（`guard.before`）按当前授权重新解析；首次执行、直接重放、失败后回查三条路径都经过它；重放另按当前范围复核结果模板的可编辑性与请求里的目录引用（`guard.replayed`）。拒绝即整体回滚：业务、revision、审计、台账都不留痕。
- 业务写、字段级审计（`talent-review.template.create|update|delete`，归属 `scope.orgId` = 模板所属组织）与命令台账同一租户事务；删除保留快照（含当时版本的完整结构）。
- 所有标识统一小写规范化（DEC-194）。

## 2. 逐路由声明

路径前缀 `/api/tenant/talent-review`，批次 A。

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/templates` | object | Template；view；无按钮 | list `templateReadable`，分页前过滤 | projector 裁剪；带 `enabled` 筛选而无 `enabled` 查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission`；排序键只取查看人可见的 `name`，再以 id 收尾；每条带 `accessLevel` |
| GET | `/templates/:id` | object | 同上 | point id → `requireReadable`（范围内 ∪ 创建人 ∪ 向下公开）；范围外与不存在同为 404 | 同列表 | ETag = revision；`?version=n` 读历史版本 |
| POST | `/templates` | object | Template；create；create@list；**带引用时另需 `Flow / ScoreRule / ModuleGrade / Field` 的 view（`requireCatalogs`，条件守卫 `talentReview.templateCatalogReference`）** | `requireCreatable`（目标组织须在范围内，否则 404）；引用按目录范围判定可见 | 严格结构；逐字段编辑权 | REV（=0）、IDEM；201 |
| PATCH | `/templates/:id` | object | Template；update；update@detail；带引用时同上 | 行锁 → `requireEditable`（404 / 403 `TEMPLATE_PUBLIC_DOWN_READONLY`）→ REV；改所属组织须目标组织在范围内 | 严格结构；逐字段编辑权；`steps / modules / permissions` 整组提交 | REV、IDEM |
| DELETE | `/templates/:id` | object | Template；delete；delete@detail | 行锁 → `requireEditable` → REV → 引用守卫 | 无字段赋值；返回删除前聚合（快照入审计） | 被引用 409 `TEMPLATE_IN_USE`（项目引用的守卫由 B7a 登记） |

## 3. 业务规则与错误码

| 规则 | 码 | 依据 |
|---|---|---|
| 名称租户唯一 | 409 `TEMPLATE_DUPLICATE` | 设计 §2.3 |
| 启用须已选流程 | 400 `TEMPLATE_FLOW_REQUIRED`（库 CHECK 兜底） | 设计 §2.3 |
| 头部字段（名称 / 所属组织 / 向下公开 / 启停）修改**不生成版本**；换流程、或提交 `steps / modules / permissions` 任一结构件**生成新版本**（`currentVersionNo + 1`），旧版本不变 | — | TR-R12、D-02 |
| 步骤 = 流程节点在版本内的冻结副本（含角色 resolver）；**流程换了才重新冻结**，同一流程之后修改不影响已保存版本；`show_matrix` 是模板自己的设置，按 `node_key` 保留；提交的 `steps` 只收 `{nodeKey, showMatrix}` | 400 `TEMPLATE_STEP_UNKNOWN` / `TEMPLATE_STEP_DUPLICATE` | 设计 §3.3 |
| 新引用已停用的流程 / 评价规则 / 模块等级 / 字段；已持有的原样保留可改 | 400 `TEMPLATE_FLOW_DISABLED` / `MODULE_RULE_DISABLED` / `MODULE_GRADE_DISABLED` / `MODULE_FIELD_DISABLED` | 设计 §7 启停行 |
| 引用不存在或不在目录范围内的目录对象（含原样带上的已有引用；重放按当前范围重新复核） | 404 `NOT_FOUND`（同一个响应） | AGENTS §10 权限 |
| 模块名称版本内唯一；指标评估模块须选来源、算分方式与评价规则；任职资格来源不带人才标准设置；人才标准来源须选“按主职职务 / 指定标准”，指定须选标准；维度只能是能力 / 潜力 / 经历；非指标模块不带评分配置；信息模块之外不带展示字段 | 400 `MODULE_NAME_DUPLICATE / MODULE_SOURCE_REQUIRED / MODULE_SCORING_REQUIRED / MODULE_CRITERION_* / MODULE_DIMENSION_INVALID / MODULE_KIND_MISMATCH / MODULE_FIELD_DUPLICATE` | TR-R13、R14 |
| 按指标数目算分只能配等级类评价规则，且须选按指标数目的模块等级；其他算分方式不能选按指标数目的模块等级 | 400 `MODULE_BY_COUNT_RULE / MODULE_BY_COUNT_GRADE / MODULE_GRADE_MODE` | TR-R15；🟡 `MODULE_GRADE_MODE` 为本设计自定项 |
| 指定的人才标准须存在且已启用（新引用；已持有的原样保留）；行加 `FOR KEY SHARE` 与人才标准删除互斥 | 400 `CRITERION_NOT_REFERENCEABLE` | 设计 §5.1 |
| 权限行：对应已有步骤 / 模块；会签步骤须指到该步骤的角色，单人步骤不带角色；必填以启用为前提；权重只在启用评分时有意义；继任两项只用于继任模块；信息模块没有权限行；同一步骤 × 角色 × 模块至多一行 | 400 `PERMISSION_STEP_UNKNOWN / _MODULE_UNKNOWN / _INFO_MODULE / _ROLE_INVALID / _DUPLICATE / _KIND_MISMATCH / _REQUIRED_NEEDS_ENABLED / _WEIGHT_NEEDS_SCORE` | TR-R16、R18 |
| **权限行由服务端物化**：步骤（单人一个、会签每个角色一个）× 非信息模块的每个席位都有一行；提交了 `permissions` 就以提交行为准、未提交的席位取缺省（指标：可见、评分 / 评语启用、非必填、权重空；继任：两项 `hidden`）；没提交整组则沿用当前版本同席位的行 | — | TR-R16；🟡 缺省值为本设计自定项 |
| 权重之和 ≠ 100 → `configErrors: [{moduleName, code: 'WEIGHT_SUM_NOT_100', sum}]`，**允许保存、不拦截**（照原站只标红） | — | TR-R16，D-03 |
| 评价规则头部与等级、模块等级项在版本保存时**整份快照**；之后改规则 / 模块等级不影响已保存版本，只有再次保存模块的新版本才取新内容；未重新提交模块的新版本沿用当时的快照 | — | TR-R20、AC-TR-15 |
| 流程 / 角色 / 评价规则 / 模块等级 / 盘点字段被模板版本引用不能删（外键 restrict 兜底，守卫给出可读 409）；人才标准被模板模块引用不能删 | 409 `FLOW_IN_USE / ROLE_IN_USE / SCORE_RULE_IN_USE / MODULE_GRADE_IN_USE / FIELD_IN_USE`；人才标准侧 `CRITERION_REFERENCED`（引用方 `TALENT_REVIEW_TEMPLATE`） | 设计 §5.1；本 PR 登记 `flow / role / scoreRule / moduleGrade / field` 的模板侧守卫，B6b 接线其余（表单 / 九宫格 / 计算规则） |

## 4. 与 DEC-387 / DEC-391 的关系

结果设置公式（`result_rules`）与步骤表单选用（`step_forms`）不在本 PR（见开头）。按 F-082 §8，结果公式字段目录 = 版本内部模块 `模块.<名>.得分/等级`，模块名称版本内冻结，因此**本 PR 的数据模型已满足**：模块名称版本内唯一（`MODULE_NAME_DUPLICATE`）、名称建后可改但每次保存都是新版本。`bindFormula / 绑定凭证 / refs 表 / 投影`的接入与 D-15（文本与数值比较）按 DEC-391 “编辑期允许 / 运行期报错”的处理，随 B6a-2 实现。

## 5. 写入口 × 值来源

| 入口 | 请求体字段 | 值来源 / 校验位置 |
|---|---|---|
| POST `/templates` | `name / ownerOrgId / downwardPublic / flowId / enabled / steps / modules / permissions` | 严格结构（`template-input.ts`）；范围 `requireCreatable`；流程 / 规则 / 等级 / 字段在命令内按目录范围复核；快照取自命令事务内读到的规则 / 等级（`FOR KEY SHARE` 锁住引用行） |
| PATCH `/templates/:id` | 同上，全部可选 | 同上；`flowId` 变化触发重新冻结；`steps / modules / permissions` 缺席 = 沿用当前版本 |
| DELETE `/templates/:id` | 无 | 行锁后 `requireEditable` + 引用守卫；快照入审计 |

## 6. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 范围内组织的管理者（TalentReview 管理单元） | 范围内 ∪ 创建人 ∪ 上级向下公开的模板；字段按查看权；`accessLevel` manage / readonly | 范围内的模板按数据操作权、按钮与字段编辑权；引用目录另需对应目录查看权 | 日志入口权 + 对象查看权 + 所属组织在范围内 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404 | 新建 / 修改 / 删除 404（不落库） | 不可见 |
| 仅因向下公开可见 | 可读（`accessLevel = readonly`） | 修改 / 删除 403 `TEMPLATE_PUBLIC_DOWN_READONLY`，数据不变 | 不可见（审计不因向下公开放宽） |
| 缺某字段查看权 | 该键缺席；按 `enabled` 筛选而无查看权 403 | 写该字段（含显式清空）403 | 该字段裁剪 |
| 缺目录查看权 | 正常读取 | 带引用的新建 / 修改 403；引用在其目录范围外 404 | — |
| 缺按钮 / 撤范围 / 撤目录范围 | — | 首次与重放都被拒（403 / 404 / 404），业务不变 | — |

## 7. 🟡 保守口径与自定项（请审查方确认）

1. **名称租户唯一会让范围受限的操作人通过 409 探测到范围外模板名称是否存在**（与 IDP 模板同口径，未像设置类配置对象那样要求“改名须看全部”）。若要堵，可改成“名称在所属组织内唯一”或加探测限流，属契约变更，等总编排定。
2. 流程**换了才重新冻结**：同一流程之后改节点 / 角色不会自动进入已有模板，要换一个流程再换回来（或后续补“重新同步流程”入口）。本 PR 不做同步入口。
3. 提交 `flowId`（即使与当前相同）要求流程的目录查看权与范围可见（“显式提交的引用都须可见”，与 B3 同口径），但不触发重新冻结 / 新版本。
4. 缺省权限行的取值（见 §3）与 `MODULE_GRADE_MODE`、继任模块三项开关缺省 `true` 为设计自定项。
