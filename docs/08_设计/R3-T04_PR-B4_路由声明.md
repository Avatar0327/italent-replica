# R3-T04 PR-B4 九宫格：路由权限声明

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.2（九宫格、位置字段占用、轴分段、格子、比例规则）、§2.7、§6.1、§6.5“配置对象”行、§7 九宫格 CRUD 行；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；TR-R31～R35；DEC-121、DEC-082、DEC-043、DEC-080、DEC-067、DEC-216、DEC-194、DEC-361。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/matrix-policy.ts`（并入 `policy.ts`），必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts`（CI 强制）。
> 范围：新增 8 条路由（`/api/tenant/talent-review/matrices` 下：九宫格 5、比例规则组 3）。作用对象：复刻系统，不涉及北森测试租户。

## 1. 共用契约

- 应用 `TalentReview`；对象 = `TalentReview.Matrix`（`create@list / update@detail / delete@detail`），字段见 `packages/domain/src/talent-review/catalog.ts`（`positionFields / axisLevels / cells / ratioGroups` 是嵌套字段，权限随字段）。
- 数据范围按（用户 × TalentReview）解析，缺省为空。九宫格没有组织字段，只认**看全部或创建人**（DEC-121），新建只有看全部可建（DEC-082）。列表在 SQL 分页前按 `configScopeSql(created_by)` 过滤；详情、写入、重放中，不存在与范围外同为 `404 NOT_FOUND`。预置九宫格 `created_by` 为空（系统），只有看全部可见。
- 标准身份“盘点管理员（人才盘点）”对 `TalentReview.Matrix` 预置看全部（`TALENT_REVIEW_CONFIG_OBJECTS` 追加 `matrix`，实体级；存量租户的标准身份补装随 F-061）。
- 响应按对象当前字段查看权裁剪（`trimModuleResponse`，键缺席）；写响应与幂等重放同样按当前权限裁剪。
- REV = 缺或非法 `If-Match` 时 `400 REVISION_REQUIRED`；revision 不符 `409 REVISION_CONFLICT`；新建要求 revision = 0。IDEM = 缺 `Idempotency-Key` 时 `400 IDEMPOTENCY_KEY_REQUIRED`；同键异内容 `409 IDEMPOTENCY_CONFLICT`。
- 业务写、字段级审计（`talent-review.matrix.create|update|delete`）与命令台账同一租户事务。审计查看规则：`audit/visibility.ts` 为 `TALENT_REVIEW_CONFIG_OBJECTS` 登记创建人谓词，随目录自动覆盖。规则组的增改删记在九宫格的 `update` 上（变更字段 `ratioGroups`）。
- 所有标识（路径、请求体里的字段 / 用户 ID）统一小写规范化（DEC-194）。

## 2. 逐路由声明

路径前缀 `/api/tenant/talent-review`，批次 A。

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/matrices` | object | Matrix；view；无按钮 | list `configScopeSql(created_by)`，分页前过滤 | projector 裁剪；带 `enabled` 筛选而无 `enabled` 查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission`；排序 sortNo + 编码；每条带完整聚合 |
| GET | `/matrices/:id` | object | 同上 | point id → `requireConfigVisible(createdBy)`；范围外与不存在同为 404 | 同列表 | UUID 规范为小写；ETag = revision |
| POST | `/matrices` | object | Matrix；create；create@list；**另需字段目录 `TalentReview.Field` 的 view（`requireFieldReference`，条件守卫 `talentReview.matrixFieldReference`）** | `requireConfigCreatable`（只有看全部可建，否则 404）；引用字段按字段目录范围判定可见 | 严格结构；逐字段编辑权；返回按当前查看权投影 | REV（=0）、IDEM；201；错误见 §3 |
| PATCH | `/matrices/:id` | object | Matrix；update；update@detail；带字段引用时同上 | 行锁 → `requireConfigVisible` → REV；返回前复核 | 严格结构（不收编码，400）；逐字段编辑权（含 `zFieldId: null` 显式清空）；**改名要求看全部**（`NAME_REQUIRES_SEE_ALL`）；**改位置字段要求看全部**（`MATRIX_POSITION_REQUIRES_SEE_ALL`），判定都在任何查重之前 | REV、IDEM；`axisLevels` 与 `cells` 必须同时提交（否则 400） |
| DELETE | `/matrices/:id` | object | Matrix；delete；delete@detail | 行锁 → `requireConfigVisible` → REV → 引用守卫 | 无字段赋值；返回删除前聚合 | 被引用 409 `MATRIX_IN_USE`；预置 409 `MATRIX_PRESET`；子数据随之删除，删除快照含全部子数据 |
| POST | `/matrices/:id/ratio-groups` | object | Matrix；**update**；update@detail | 同 PATCH | `ratioGroups` 字段编辑权；严格结构 | If-Match = 九宫格 revision（写后 +1）；201，响应为九宫格聚合 |
| PATCH | `/matrices/:id/ratio-groups/:groupId` | object | 同上 | 同上；组不属于该九宫格 404 | 同上；`rules` 整组替换 | 组 id 保持不变 |
| DELETE | `/matrices/:id/ratio-groups/:groupId` | object | 同上 | 同上 | 清掉 `ratioGroups` 的一项，同样校验 `ratioGroups` 字段编辑权 | 被项目引用 409 `RATIO_GROUP_IN_USE`（引用守卫，B7 登记） |

## 3. 业务规则与错误码

| 规则 | 码 | 依据 |
|---|---|---|
| 编码 / 名称租户唯一 | 409 `MATRIX_DUPLICATE`（规则组名在九宫格内唯一：409 `RATIO_GROUP_DUPLICATE`） | 设计 §2 通用约定 |
| 位置字段租户内唯一：覆盖 before-before、after-after、两向 before-after、同一九宫格 before = after；并发由库唯一约束兜底，恰一个成功 | 409 `MATRIX_POSITION_FIELD_IN_USE` | 设计 §2.2、D-20、AC-TR-08 |
| 保存命令恰两行（before / after 各一） | 400 `MATRIX_POSITION_FIELDS_INCOMPLETE` | 设计 §2.2、P3-01 |
| 位置字段必须是“位置”分组的数值字段 | 400 `MATRIX_POSITION_FIELD_KIND` | 设计 §2.7（位置字段 number、`system_written`） |
| X ≠ Y；轴字段为单选或数值 | 400 `MATRIX_AXIS_SAME_FIELD` / `MATRIX_AXIS_FIELD_KIND` | TR-R31 |
| 轴分段 2～9 段、序号连续；单选轴选项值属于字段且各段不重复；数值轴第一段无下界、其余下界递增 | 400 `MATRIX_LEVELS_INVALID` | 🟡 设计自定项 D-B4-1（需取证 #181） |
| 格子铺满 X 段 × Y 段网格，格子号唯一 | 400 `MATRIX_CELLS_INCOMPLETE` | 🟡 设计自定项 D-B4-1（需取证 #181） |
| 新引用已停用的字段 | 400 `MATRIX_FIELD_DISABLED` | 设计 §7 启停行（停用后不可新引用） |
| 被比例规则引用的格子不能删 | 409 `MATRIX_CELL_IN_USE` | TR-R33 |
| 范围运算（between）需要上限且 ≥ 下限，其他运算不带上限；格子集合非空、无重复、属于本九宫格；一组至少一条规则；组内规则为“且”（PR-D 求值） | 400 `RATIO_RULE_INVALID` / `RATIO_RULE_CELL_UNKNOWN` | TR-R33 |
| 默认规则组至多一个（设为默认会取消原默认） | — | TR-R33“一组为默认” |
| 引用字段不存在或不在字段目录范围内 | 404 `NOT_FOUND`（同一个响应，不暴露隐藏字段的存在与类型） | AGENTS §10 权限、OCR 路由规则 |

## 4. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除 / 规则组写入与重放 | 审计 |
|---|---|---|---|
| 盘点管理员（预置，看全部） | 全部九宫格（含预置），字段按查看权 | 按数据操作权、按钮与字段编辑权；引用字段另需字段目录查看权 | 日志入口权 + 对象查看权 + 看全部 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404 | 新建 / 修改 / 删除 / 规则组 404（不落库） | 不可见 |
| 有创建人规则 | 只看自己建的 | 只能改 / 删自己建的，不能改名、不能改位置字段（403，唯一约束不暴露隐藏记录）；新建 404（DEC-082） | 只看自己建的 |
| 缺某字段查看权 | 该键缺席；按 `enabled` 筛选而无 `enabled` 查看权 403 | 写该字段（含显式清空）403；响应同样缺席 | 该字段裁剪 |
| 缺 `ratioGroups` 编辑权 | 正常读取 | 规则组增改删 403 | — |
| 缺字段目录查看权 | 正常读取 | 带字段引用的新建 / 修改 403；字段在其字段目录范围外 404 | — |
| 缺按钮 | 正常读取 | 首次与重放都 403，业务不变 | — |
| 撤看全部后重放 | — | 404，业务不变 | — |
| 无对象查看权 | 403 | 403 | 不可见 |
| 其他租户 | 列表不带出；详情 404 | 404 | 不可见 |

## 5. 写入口 × 值来源（DEC-251）

| 写入口 | 人工输入 | 继承 / 保留 | 派生 | 系统值 | 测试 |
|---|---|---|---|---|---|
| `POST /matrices` | 编码、名称、轴 / 第三维度字段、拖拽开关、落位来源、绿化率参考、位置字段、轴分段、格子 | — | revision = 1、preset = false | 创建人 / 时间 | `AC-TR-08-matrix` |
| `PATCH /matrices/:id` | 同上（编码不收） | 未提交字段保留；`axisLevels` / `cells` 未提交则保留；格子按格子号原位更新 | revision + 1 | 更新人 / 时间 | `AC-TR-08-matrix`、`-sidechannel` |
| `DELETE /matrices/:id` | — | — | 级联删子数据 | — | `AC-TR-08-matrix`、`-ratio` |
| 规则组增改删 | 名称、是否默认、控制范围 / 方式、起始人数、规则 | 组 id 与未提交字段保留 | 九宫格 revision + 1；设为默认时取消原默认 | — | `AC-TR-08-matrix-ratio` |
| 种子补装 `registerSeed('talent-review/preset-matrices')` | — | 已有编码不覆盖 | 预置字段按编码取 id | 系统写入 + 审计 | `AC-TR-08-matrix-preset` |

## 6. 引用守卫（非路由）

| 名称 | 位置 | 说明 |
|---|---|---|
| `registerConfigReferenceGuard('matrix', guard)` | `config-kit.ts` | 项目（B7）、模板（B6）引用九宫格时登记；删除时同事务询问，任一引用即 409 `MATRIX_IN_USE` |
| `registerRatioGroupReferenceGuard(guard)` | `matrix-service.ts` | 项目的“九宫格 + 规则组”引用（B7）登记；删除规则组时询问，409 `RATIO_GROUP_IN_USE` |
| `registerConfigReferenceGuard('field', …)`（本 PR 登记） | `matrix-service.ts` | 被九宫格的轴 / 第三维度 / 位置字段引用的字段不能删（`FIELD_IN_USE`，referrer = `MATRIX`）；库外键 restrict 兜底 |
