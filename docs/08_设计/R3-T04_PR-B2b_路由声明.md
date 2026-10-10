# R3-T04 PR-B2b 字段映射：路由权限声明

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.2、§6.1、§6.5“配置对象”行、§7 配置 CRUD 行；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；DEC-121、DEC-082、DEC-043、DEC-080、DEC-067、DEC-216、DEC-361。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/policy.ts`，必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts`（CI 强制）。
> 作用对象：全部是复刻系统，不涉及北森测试租户。
> 范围：新增 5 条路由（`/api/tenant/talent-review/field-mappings`）。叠在 B2a（#180，评价规则 / 模块等级）之上。

## 1. 共用契约

同 B1（`R3-T04_PR-B1_路由声明.md` §1）与 B2a（`R3-T04_PR-B2a_路由声明.md` §1）：应用 `TalentReview`，范围按（用户 × TalentReview）解析、缺省为空；对象 `TalentReview.FieldMapping` 没有组织字段，只认**看全部或创建人**（DEC-121），新建只有看全部可建（DEC-082）；列表在分页前过滤，排序只用查看人看得到的字段（scene）；范围外与不存在同为 `404 NOT_FOUND`；写入走命令台账（`If-Match`、`Idempotency-Key`），首次与重放按当前按钮与范围复核；业务写与字段级审计（`talent-review.field-mapping.*`）同一事务；响应按字段查看权裁剪（键缺席）。映射**没有名称**，因此没有改名守卫。

## 2. 逐路由声明

路径前缀 `/api/tenant/talent-review`，批次 A。

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/field-mappings` | object | MAP；view；无按钮 | list `configScopeSql(created_by)`，分页前过滤 | projector 裁剪；带 `scene` 筛选而无 `scene` 查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission`；可按 `scene` 筛选 |
| GET | `/field-mappings/:id` | object | 同上 | point id → `requireConfigVisible(createdBy)`；范围外与不存在同为 404 | 同列表 | ETag = revision |
| POST | `/field-mappings` | object | MAP；create；create@list | `requireConfigCreatable`（只有看全部可建，否则 404）；返回前复核 | 严格结构；逐字段编辑权 | REV（=0）、IDEM；重复 409 `MAPPING_DUPLICATE`；另需字段对象权限（§2.1） |
| PATCH | `/field-mappings/:id` | object | MAP；update；update@detail | 行锁 → `requireConfigVisible` → REV；返回前复核 | 严格结构（`scene` 建后不可改，400）；逐字段编辑权 | 预置映射 409 `MAPPING_PRESET`；改来源 / 目标字段时另需字段对象权限（§2.1） |
| DELETE | `/field-mappings/:id` | object | MAP；delete；delete@detail | 行锁 → `requireConfigVisible` → REV → 引用守卫 | 无字段赋值；返回删除前视图 | 预置映射 409 `MAPPING_PRESET`；删除快照审计 |

### 2.1 引用字段 = 读取字段对象

`POST` 与改动来源 / 目标字段的 `PATCH` 在路由里先于读取字段校验：另需字段对象（`TalentReview.Field`）的**查看权**（无则 403）与**数据范围**（`reviewScope('field')`）；命令内字段不存在与范围外**同一个 404**（不暴露字段是否存在）。条件守卫名 `talentReview.mappingFieldVisible`，条件准入 `obj:TalentReview.Field:view`。

## 3. 业务规则（命令内）

- 场景 `carry_last | talent_pool`；来源与目标字段类型相同，选项类字段的选项值集合相同（`MAPPING_KIND_MISMATCH` / `MAPPING_OPTIONS_MISMATCH`）；两端字段须已启用（`MAPPING_FIELD_DISABLED`，停用后不可新引用）。
- 唯一键（租户, 场景, 来源, 目标）；来源可等于目标（预置“标签 → 标签”）。
- 先共享锁住来源 / 目标字段行（按 id 升序），与字段删除的 `FOR UPDATE` 串行：删除先到则映射新建 404，映射先提交则字段删除 409 `FIELD_IN_USE`（真 PG 交错测试 `AC-TR-field-mappings-pg`）。
- **预置**：“标签 → 标签”沿用上次结果映射（场景 `carry_last`）走 DEC-361 `registerSeed({ module: 'talent-review', key: 'preset-field-mappings', codes: ['carry_last:tags'] })`；依赖 B1 的预置标签字段，缺失时不装；预置映射不可改不可删。
- 之后字段选项变化可能使已存在的映射不再兼容；PR-C 带入时用同一个 `mappingCompatibility` 复核。

## 4. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 被授予“看全部”的人（**预置盘点管理员默认没有字段映射的看全部**，待用户确认，DEC-374②；租户管理员可显式授予；评价规则 / 模块等级的预置看全部已由 DEC-408② 批准） | 全部记录，字段按查看权 | 按数据操作权、按钮与字段编辑权；另需字段对象查看权与范围 | 日志入口权 + 对象查看权 + 看全部 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404 | 新建 404（不落库）；修改 / 删除 404 | 不可见 |
| 有创建人规则 | 只看自己建的 | 只能改 / 删自己建的；新建 404（DEC-082） | 只看自己建的 |
| 缺某字段查看权 | 该键缺席；按 `scene` 筛选 403 | 写该字段 403；响应同样缺席 | 该字段裁剪 |
| 缺按钮 | 正常读取 | 首次与重放都 403，业务不变 | — |
| 撤看全部后重放 | — | 404，业务不变 | — |
| 缺字段对象查看权 | — | 403；字段范围为空时 404，且不落库 | — |
| 无对象查看权 | 403 | 403 | 不可见 |
| 其他租户 | 列表不带出；详情 404 | 404 | 不可见 |

## 5. 引用守卫（非路由）

| 名称 | 位置 | 说明 |
|---|---|---|
| `registerConfigReferenceGuard('field', …)` | `mapping-service.ts` | 字段被字段映射引用时拒删，409 `FIELD_IN_USE`（`referrer = FIELD_MAPPING`）；`RESTRICT` 外键兜底 |
| `mappingCompatibility(source, target)` | `packages/domain/src/talent-review/scoring-config.ts` | 保存时校验；PR-C 在带入点复核 |
