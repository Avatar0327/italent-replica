# R3-T04 PR-B1 配置骨架：路由权限声明

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.2、§6.1、§6.5“配置对象”行、§7 配置 CRUD 行；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；DEC-121、DEC-082、DEC-043、DEC-080、DEC-067、DEC-216、DEC-194。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/policy.ts`，必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts`（CI 强制）。
> 范围：新增 17 条路由（`/api/tenant/talent-review/` 下的 `settings` 2、`categories` / `roles` / `fields` 各 5）。

## 1. 共用契约

- 应用 `TalentReview`；对象 SET = `TalentReview.Settings`（只有 `update@detail` 按钮）、CAT = `TalentReview.Category`、ROL = `TalentReview.Role`、FLD = `TalentReview.Field`（`create@list / update@detail / delete@detail`）。字段见 `packages/domain/src/talent-review/catalog.ts`。
- 数据范围按（用户 × TalentReview）解析，缺省为空。四个对象都没有组织字段：CAT / ROL / FLD 只认**看全部或创建人**（DEC-121），新建只有看全部可建（DEC-082）；SET 是单例，读写都只有看全部。列表在 SQL 分页前按 `configScopeSql(created_by)` 过滤；详情、写入、重放中，不存在与范围外同为 `404 NOT_FOUND`。
- 标准身份“盘点管理员（人才盘点）”对四个对象预置看全部（`TALENT_REVIEW_CONFIG_OBJECTS`，实体级）。
- 响应按对象当前字段查看权裁剪（`trimModuleResponse`，键缺席）；写响应与幂等重放同样按当前权限裁剪。
- REV = 缺或非法 `If-Match` 时 `400 REVISION_REQUIRED`；revision 不符 `409 REVISION_CONFLICT`；新建要求 revision = 0（设置首次保存也是 0，之后按实际 revision）。IDEM = 缺 `Idempotency-Key` 时 `400 IDEMPOTENCY_KEY_REQUIRED`；同键异内容 `409 IDEMPOTENCY_CONFLICT`。
- 业务写、字段级审计（`talent-review.<settings|category|role|field>.create|update|delete`）与命令台账同一租户事务。审计查看规则：`audit/visibility.ts` 为 `TALENT_REVIEW_CONFIG_OBJECTS` 登记创建人谓词，随目录自动覆盖新对象。
- 所有标识（路径、请求体里的字段 / 用户 ID）统一小写规范化（DEC-194）。

## 2. 逐路由声明

路径前缀 `/api/tenant/talent-review`，批次 A。CAT / ROL / FLD 三组路由同构，下表以 `{x}` 代表 `categories` / `roles` / `fields`。

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/{x}` | object | 对应对象；view；无按钮 | list `configScopeSql(created_by)`，分页前过滤 | projector 裁剪；带 `enabled` 筛选而无 `enabled` 查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission = 看全部 ∨ 创建人规则`；排序 sortNo + 编码 / 名称 + id |
| GET | `/{x}/:id` | object | 同上 | point id → `requireConfigVisible(createdBy)`；范围外与不存在同为 404 | 同列表 | UUID 规范为小写；ETag = revision |
| POST | `/{x}` | object | 对应对象；create；create@list（FLD 带 `pairFieldId` 时另需 update 权与 update@detail 按钮） | `requireConfigCreatable`（只有看全部可建，否则 404）；返回前按当前范围复核 | 严格结构（多余键 400）；逐字段编辑权（`writeFields`）；返回按当前查看权投影 | REV（=0）、IDEM；重复 409 `CATEGORY_DUPLICATE` / `ROLE_DUPLICATE` / `FIELD_DUPLICATE`；201 |
| PATCH | `/{x}/:id` | object | 对应对象；update；update@detail | 行锁 → `requireConfigVisible` → REV；返回前复核 | 严格结构（不收编码、字段类型：建后不可改，400）；逐字段编辑权；**改名要求看全部**：创建人范围下名称实际变化一律 403 `NAME_REQUIRES_SEE_ALL`，判定在查重之前 | REV、IDEM；字段目录另有 400 `FIELD_OPTION_REMOVED` 等规则（见 §3） |
| DELETE | `/{x}/:id` | object | 对应对象；delete；delete@detail | 行锁 → `requireConfigVisible` → REV → 引用守卫 | 无字段赋值；返回删除前视图 | 被引用 409 `<对象>_IN_USE`（`referrer`）；预置字段 409 `FIELD_PRESET`；成对字段 409 `FIELD_PAIRED`；删除快照审计 |
| GET | `/settings` | object | SET；view；无按钮 | `requireConfigCreatable`（只有看全部，否则 404） | projector 裁剪 | 没有记录时返回默认值与 revision 0；ETag = revision |
| PATCH | `/settings` | object | SET；update；update@detail | 同上，返回前复核 | 严格结构；逐字段编辑权（含 `systemPrincipalUserId` 显式清空）；系统主体须是本租户有效成员（400 `SYSTEM_PRINCIPAL_NOT_MEMBER`） | REV（首次 0 建立，并发首次保存只有一个成功）、IDEM；只记改动字段的审计 |

## 3. 字段目录（FLD）的跨行规则

number 才有小数位（0～4，缺省 2）；option / multi_option 必须至少一个选项且 value 唯一；已有选项 value 不能删除，只能停用（`FIELD_OPTION_REMOVED`，DEC-257）；成对字段（校准前 / 后）类型相同、角色相反、一对一，同一事务双向写入（`PAIR_INVALID`、`PAIR_ROLE_REQUIRED`、`PAIR_ALREADY_USED`）；`preset` / `systemWritten` 不能由请求设置。预置字段登记进种子补装登记表（DEC-361）：新租户开通与平台回补命令 `POST /api/platform/tenants/:tenantId/seeds/backfill` 走同一个 `installMissingSeeds`，只补缺失编码、不覆盖租户定制、写审计。

**新建时指定成对字段 = 同时修改另一端字段**：请求体带 `pairFieldId` 时，另需字段的数据操作更新权、`update@detail` 按钮与 `pairFieldId` 编辑权（路由里先于读取另一端校验，条件守卫 `talentReview.pairRequiresUpdate`）；随后在命令内先校验新建范围（范围为空 404），另一端不存在与范围外同一个 404，再校验类型相同 / 角色相反 / 已启用（停用后不可新引用，400 `PAIR_TARGET_DISABLED`）/ 尚未成对（409 `PAIR_ALREADY_USED`）。新建字段的创建审计在选项写入之后生成，快照含完整选项。

## 4. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 盘点管理员（预置，看全部） | 全部记录，字段按查看权 | 按数据操作权、按钮与字段编辑权 | 日志入口权 + 对象查看权 + 看全部 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404；设置 404 | 新建 404（不落库）；修改 / 删除 404 | 不可见 |
| 有创建人规则 | 只看自己建的 | 只能改 / 删自己建的，不能改名（403，名称冲突不暴露隐藏记录）；新建 404（DEC-082）；设置 404 | 只看自己建的 |
| 缺某字段查看权 | 该键缺席；按 `enabled` 筛选而无 `enabled` 查看权 403 | 写该字段 403；响应同样缺席 | 该字段裁剪 |
| 缺按钮 | 正常读取 | 首次与重放都 403，业务不变 | — |
| 撤看全部后重放 | — | 404，业务不变 | — |
| 无对象查看权 | 403 | 403 | 不可见 |
| 其他租户 | 列表不带出；详情 404；设置读到的是本租户自己的默认值 | 404 | 不可见 |

## 5. 可信端口 / 引用守卫（非路由）

| 名称 | 位置 | 说明 |
|---|---|---|
| `registerConfigReferenceGuard(object, guard)` | `apps/api/src/modules/talent-review/config-kit.ts` | 引用方（B2 评价规则 / 映射、B3 表单 / 流程、B4 九宫格、B5 计算规则、B6 模板、B7 项目）加载时登记；删除时同事务逐个询问，任一引用即 409 `<对象>_IN_USE` |
| `registerSeed({ module: 'talent-review', key: 'preset-fields', ... })` | `apps/api/src/modules/talent-review/presets.ts`，收录于 `seeds/index.ts` | 预置字段登记项（DEC-361）；后续子 PR 在此追加九宫格、表单、映射的登记项 |
