# R3-T04 PR-B3 盘点内容表单与流程定义：路由权限声明

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.2（forms / form_fields / flows / nodes / node_roles）、§2.7（预置四个表单）、§3.3（流程节点在模板版本内冻结）、§6.1、§6.4（步骤 × 表单逐字段三档）、§6.5“配置对象”行、§7 配置 CRUD / 流程定义 CRUD 行；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；DEC-306①、DEC-304、DEC-121、DEC-082、DEC-043、DEC-080、DEC-067、DEC-216、DEC-194、DEC-361。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/policy.ts` 的 `configRoutes('form' | 'flow', …)`，必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts`（CI 强制）。
> 范围：新增 10 条路由（`/api/tenant/talent-review/forms` 5、`/flows` 5）。作用对象：复刻系统，不涉及北森测试租户。

## 1. 共用契约

- 应用 `TalentReview`；对象 = `TalentReview.Form`、`TalentReview.Flow`（`create@list / update@detail / delete@detail`），字段见 `packages/domain/src/talent-review/catalog.ts`（`fields` / `nodes` 是嵌套字段，权限随字段）。
- 数据范围按（用户 × TalentReview）解析，缺省为空。表单与流程没有组织字段，只认**看全部或创建人**（DEC-121），新建只有看全部可建（DEC-082）。列表在 SQL 分页前按 `configScopeSql(created_by)` 过滤；详情、写入、重放中，不存在与范围外同为 `404 NOT_FOUND`。预置表单的 `created_by` = 开通 / 回补命令的操作人（可为空）。
- **标准身份预置看全部**：`Form`、`Flow` 取保守口径，加入 `TALENT_REVIEW_SEE_ALL_UNAPPROVED`（与 B2a 的评价规则 / 模块等级同口径），确认前盘点管理员对它们没有预置看全部，需租户自行授予；是否预置属于数据范围扩大，须总编排逐次问用户（DEC-374②），本 PR 不替用户决定。
- 响应按对象当前字段查看权裁剪（`trimModuleResponse`，键缺席）；写响应与幂等重放同样按当前权限裁剪。
- REV = 缺或非法 `If-Match` 时 `400 REVISION_REQUIRED`；revision 不符 `409 REVISION_CONFLICT`；新建要求 revision = 0。IDEM = 缺 `Idempotency-Key` 时 `400 IDEMPOTENCY_KEY_REQUIRED`；同键异内容 `409 IDEMPOTENCY_CONFLICT`。
- **写命令的权限复核（B4 `runGuarded` 模式）**：对象操作权、按钮、范围、载荷逐字段编辑权、引用目录的查看权与范围都在命令事务内（`guard.before`）按当前授权重新解析；首次执行、直接重放、失败后回查三条路径都经过它；重放另按当前范围复核结果对象与请求里的引用（`guard.replayed`）。拒绝即整体回滚：业务、revision、审计、台账都不留痕。
- 业务写、字段级审计（`talent-review.form|flow.create|update|delete`）与命令台账同一租户事务。审计查看规则：`audit/visibility.ts` 为 `TALENT_REVIEW_CONFIG_OBJECTS` 登记创建人谓词，随目录自动覆盖。
- 所有标识统一小写规范化（DEC-194）。

## 2. 逐路由声明

路径前缀 `/api/tenant/talent-review`，批次 A。表单与流程各 5 条，规则相同，只列表单；流程把“字段”换成“角色”、`fields` 换成 `nodes`。

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/forms` | object | Form；view；无按钮 | list `configScopeSql(created_by)`，分页前过滤 | projector 裁剪；带 `enabled` 筛选而无 `enabled` 查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission`；排序键只取查看人可见的 sortNo、code，再以 id 收尾；每条带完整聚合 |
| GET | `/forms/:id` | object | 同上 | point id → `requireConfigVisible(createdBy)`；范围外与不存在同为 404 | 同列表 | ETag = revision |
| POST | `/forms` | object | Form；create；create@list；**带字段引用时另需 `TalentReview.Field` 的 view（`requireFieldCatalog`，条件守卫 `talentReview.formFieldReference`）** | `requireConfigCreatable`（只有看全部可建，否则 404）；引用字段按字段目录范围判定可见 | 严格结构；逐字段编辑权 | REV（=0）、IDEM；201 |
| PATCH | `/forms/:id` | object | Form；update；update@detail；带字段引用时同上 | 行锁 → `requireConfigVisible` → REV | 严格结构（不收 `code`，400）；逐字段编辑权；**改名要求看全部**（`NAME_REQUIRES_SEE_ALL`，在查重之前）；`fields` 整组替换 | REV、IDEM |
| DELETE | `/forms/:id` | object | Form；delete；delete@detail | 行锁 → `requireConfigVisible` → REV → 引用守卫 | 无字段赋值；返回删除前聚合（快照入审计） | 被模板引用 409 `FORM_IN_USE`（守卫由 B6 登记）；预置 409 `FORM_PRESET` |
| GET / POST / PATCH / DELETE | `/flows`、`/flows/:id` | object | Flow；同上；引用角色时另需 `TalentReview.Role` 的 view（`requireRoleCatalog`，条件守卫 `talentReview.flowRoleReference`） | 同表单 | `nodes` 整组提交 | 删除被模板引用 409 `FLOW_IN_USE`（B6 登记） |

## 3. 业务规则与错误码

| 规则 | 码 | 依据 |
|---|---|---|
| 表单编码 / 名称、流程名称租户唯一；表单编码建后不可改 | 409 `FORM_DUPLICATE` / `FLOW_DUPLICATE` | 设计 §2.2 |
| 字段在表单里至多出现一次 | 400 `FORM_FIELD_DUPLICATE` | 设计 §2.2 |
| required 只能设在 `edit` 字段上（view / hidden 的字段谁也填不了） | 400 `FORM_REQUIRED_NEEDS_EDIT` | 🟡 设计自定项 D-B3-1（设计 §2.2 只写“先做必填开关”） |
| 新引用已停用的字段 / 角色；已持有的原样保留可改 | 400 `FORM_FIELD_DISABLED` / `FLOW_ROLE_DISABLED` | 设计 §7 启停行（停用后不可新引用，已引用保留） |
| 引用不存在或不在目录范围内的字段 / 角色（幂等重放按当前范围重新复核） | 404 `NOT_FOUND`（同一个响应） | AGENTS §10 权限 |
| 字段被表单引用时不能删；角色被流程节点引用时不能删 | 409 `FIELD_IN_USE` / `ROLE_IN_USE` | config-kit 引用守卫 |
| node_key 流程内唯一，格式 `^[a-z][a-z0-9_]{0,31}$` | 400 `FLOW_NODE_KEY_DUPLICATE` | 设计 §2.2 |
| node_key 保存后不可改：带 `id` 的已有节点 key 与库中不一致 | 400 `FLOW_NODE_KEY_IMMUTABLE`；`id` 不属于本流程 400 `FLOW_NODE_NOT_FOUND` | 设计 §2.2 |
| countersign 只能 evaluate + single | 400 `FLOW_COUNTERSIGN_INVALID`（库 CHECK 兜底） | 设计 §2.2 |
| single 节点恰一个角色，countersign ≥ 1；同一节点角色不重复 | 400 `FLOW_ROLE_COUNT_INVALID` / `FLOW_ROLE_DUPLICATE` | 设计 §2.2 |
| 流程至少一个节点（≤ 20），节点角色 ≤ 20 | 400 校验失败 | 🟡 设计自定项 D-B3-2（上限） |
| 节点同步：带 id 保留并可改（key 不可改）、不带 id 新增、缺席删除 | — | 设计 §2.2 |

## 4. 预置（DEC-361，`form-presets.ts`）

四个预置表单（编码 `self_info` / `supervisor_info` / `admin_view` / `batch_calibrate`）按预置字段分组与成对角色生成，覆盖全部预置字段，未列出的为 `hidden`：自评 = 评价分组 `edit`；上级评价 = 结果分组校准前字段 + 标签 + 评价分组 `edit`；管理员查看 = 全部 `view`；批量盘点可编辑（`calibrate_edit`）= 结果分组校准后字段 + 标签 + 校准分组 `edit`（设计 §2.7 🟡 种子数据，取证可后补）。可重复执行、不覆盖租户定制；名称被租户自建的表单占用时不装并在报告里给出 `FORM_NAME_TAKEN`；写字段级审计（系统写入）。预置表单不可删除、可停用。

## 5. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 盘点管理员（看全部由租户授予，见 §1） | 全部（含预置），字段按查看权 | 按数据操作权、按钮与字段编辑权；引用字段 / 角色另需对应目录查看权 | 日志入口权 + 对象查看权 + 看全部 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404 | 新建 / 修改 / 删除 404（不落库） | 不可见 |
| 缺某字段查看权 | 该键缺席；按 `enabled` 筛选而无查看权 403 | 写该字段（含显式清空）403 | 该字段裁剪 |
| 缺目录查看权 | 正常读取 | 带引用的新建 / 修改 403；引用在其目录范围外 404 | — |
| 缺按钮 / 撤范围 / 撤目录范围 | — | 首次与重放都被拒（403 / 404 / 404），业务不变 | — |
