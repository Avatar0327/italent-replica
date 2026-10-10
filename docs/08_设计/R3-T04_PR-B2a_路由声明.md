# R3-T04 PR-B2a 评价规则、模块等级：路由权限声明

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.2、§6.1、§6.5“配置对象”行、§7 配置 CRUD 行；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；DEC-121、DEC-082、DEC-043、DEC-080、DEC-067、DEC-216、DEC-361。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/policy.ts`，必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts`（CI 强制）。
> 作用对象：全部是复刻系统，不涉及北森测试租户。
> 范围：新增 10 条路由（`/api/tenant/talent-review/` 下的 `score-rules`、`module-grades` 各 5）。字段映射在 B2b（叠在本 PR 上）。

## 1. 共用契约

同 B1（`R3-T04_PR-B1_路由声明.md` §1）：应用 `TalentReview`，范围按（用户 × TalentReview）解析、缺省为空；两个对象都没有组织字段，只认**看全部或创建人**（DEC-121），新建只有看全部可建（DEC-082）；列表在分页前过滤；范围外与不存在同为 `404 NOT_FOUND`；写入走命令台账（`If-Match`、`Idempotency-Key`），首次与重放都按当前按钮与范围复核；业务写与字段级审计同一事务；响应按字段查看权裁剪（键缺席）。

对象与按钮：SCR = `TalentReview.ScoreRule`、MGR = `TalentReview.ModuleGrade`（`create@list / update@detail / delete@detail`）。审计标签 `talent-review.score-rule` / `module-grade`，审计查看规则随 `TALENT_REVIEW_CONFIG_OBJECTS` 自动覆盖。

## 2. 逐路由声明

路径前缀 `/api/tenant/talent-review`，批次 A。`{x}` 代表 `score-rules` / `module-grades`。

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/{x}` | object | 对应对象；view；无按钮 | list `configScopeSql(created_by)`，分页前过滤 | projector 裁剪；带 `enabled` 筛选而无该字段查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission`；评价规则带等级、模块等级带项（同一事务读取） |
| GET | `/{x}/:id` | object | 同上 | point id → `requireConfigVisible(createdBy)`；范围外与不存在同为 404 | 同列表 | ETag = revision |
| POST | `/{x}` | object | 对应对象；create；create@list | `requireConfigCreatable`（只有看全部可建，否则 404）；返回前复核 | 严格结构；逐字段编辑权；返回按当前查看权投影 | REV（=0）、IDEM；重复 409 `SCORE_RULE_DUPLICATE` / `MODULE_GRADE_DUPLICATE` |
| PATCH | `/{x}/:id` | object | 对应对象；update；update@detail | 行锁 → `requireConfigVisible` → REV；返回前复核 | 严格结构（评价规则 `kind` 建后不可改，400）；逐字段编辑权；**改名要求看全部**（`NAME_REQUIRES_SEE_ALL`，在查重之前） | 合并后整体重新校验形态；等级 / 项整体替换 |
| DELETE | `/{x}/:id` | object | 对应对象；delete；delete@detail | 行锁 → `requireConfigVisible` → REV → 引用守卫 | 无字段赋值；返回删除前视图 | 被引用 409 `<对象>_IN_USE`；删除快照审计 |

### 2.1 命令事务内的当前权限复核（DEC-388①）

6 个写入口都用同一个 `CommandGuard`（`scoring-routes.ts#runGuardedWrite`）：命令事务内、查台账之前，重新解析操作权、按钮、提交字段的编辑权（含显式清空）和数据范围。三个出口都经过它：首次执行（拒绝即整体回滚，业务、revision、审计、台账都不提交）、直接重放与失败后回查台账（命中台账后再按当前范围复核结果对象，撤范围 404；撤按钮 / 撤字段编辑权 403）。

| 写入口 | 首次执行 | 直接重放 | 失败后回查 |
|---|---|---|---|
| POST `/score-rules` `/module-grades` | 撤看全部 404 / 撤按钮 403 | 404 | 404 |
| PATCH 两处 | 撤看全部 404 / 撤字段编辑权 403 / 撤按钮 403 | 撤字段编辑权 403 | 404 |
| DELETE 两处 | 撤看全部 404 / 撤按钮 403 | 404 | 404 |

## 3. 业务规则（命令内）

- **评价规则**：`kind = numeric | grade`；numeric 需 `minScore < maxScore`（≤4 位小数），不得带等级；grade 必须有等级（名称不重复，等级 `value` 不要求唯一），不得带分数范围；`display` 缺省 `dropdown`；`allowUnable` 为布尔。
- **模块等级**：按分数区间时 `[from, to)` 含下界不含上界，**最后一段含上界**，区间有效且互不重叠；按指标数目时每项给出 `minCount`（达到的指标个数门槛）（不重复，`GRADE_COUNT_DUPLICATE`）；项名称与 `value` 不重复（`GRADE_ITEM_DUPLICATE`）；同一等级项不能既带分数边界又带 `minCount`、同一模块等级也不得混用两种形态（均 400 `GRADE_ITEMS_MIXED`，失败后子表、revision、审计、台账都不变）；`mode` 由项派生、不收。

## 4. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 被授予“看全部”的人（**预置盘点管理员默认没有**这两个对象的看全部，待用户确认，DEC-374②；租户管理员可显式授予） | 全部记录，字段按查看权 | 按数据操作权、按钮与字段编辑权 | 日志入口权 + 对象查看权 + 看全部 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404 | 新建 404（不落库）；修改 / 删除 404 | 不可见 |
| 有创建人规则 | 只看自己建的 | 只能改 / 删自己建的，不能改名（403）；新建 404（DEC-082） | 只看自己建的 |
| 缺某字段查看权 | 该键缺席；按该字段筛选 403 | 写该字段 403；响应同样缺席 | 该字段裁剪 |
| 缺按钮 | 正常读取 | 首次与重放都 403，业务不变 | — |
| 撤看全部后重放 | — | 404，业务不变 | — |
| 无对象查看权 | 403 | 403 | 不可见 |
| 其他租户 | 列表不带出；详情 404 | 404 | 不可见 |

## 5. 引用守卫（非路由）

| 名称 | 位置 | 说明 |
|---|---|---|
| 评价规则 / 模块等级的被模板引用拒删 | 待 B6a / B6b 接线 | 模板（B6）加载时 `registerConfigReferenceGuard('scoreRule' / 'moduleGrade', …)` |
