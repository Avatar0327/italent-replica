# R3-T04 PR-B5 计算规则：路由权限声明

> 依据：设计 `docs/08_设计/R3-T04_人才盘点_设计.md` §2.2（计算规则 / 计算项目）、§4.3、§4.5(d)、§6.1、§6.5“配置对象”行、§7 计算规则行；拆分方案 `R3-T04_PR-B_拆分方案.md`（DEC-353）；TR-R27～R30；DEC-274、DEC-287、DEC-260、DEC-314②、DEC-121、DEC-082、DEC-043、DEC-080、DEC-067、DEC-216、DEC-194。
> 格式沿用 F-039 的逐路由声明；声明本体在 `apps/api/src/modules/talent-review/calc-rule-policy.ts`（并入 `policy.ts`），必需项表在 `tests/acceptance/support/route-policy/required/talent-review.ts`（CI 强制）。
> 范围：新增 5 条路由（`/api/tenant/talent-review/calc-rules`）。作用对象：复刻系统，不涉及北森测试租户。

## 1. 共用契约

- 应用 `TalentReview`；对象 = `TalentReview.CalcRule`（`create@list / update@detail / delete@detail`），字段：`name / enabled / assessmentLatestWindow / description / items / sortNo`，`hints` 是系统字段（保存提示，只读、不可写）。
- 数据范围按（用户 × TalentReview）解析，缺省为空。计算规则没有组织字段，只认**看全部或创建人**（DEC-121），新建只有看全部可建（DEC-082）；列表在 SQL 分页前按 `configScopeSql(created_by)` 过滤；详情、写入、重放中，不存在与范围外同为 `404 NOT_FOUND`。
- 标准身份“盘点管理员（人才盘点）”对 `TalentReview.CalcRule` 预置看全部（`TALENT_REVIEW_CONFIG_OBJECTS` 追加 `calcRule`；存量租户补装随 F-061）。
- 响应按字段查看权裁剪（键缺席）；写响应与幂等重放同样按当前权限裁剪。REV / IDEM 同 B1。业务写、字段级审计（`talent-review.calc-rule.create|update|delete`）与命令台账同一租户事务；审计快照含全部计算项目，**不含 `hints`**。
- 标识统一小写规范化（DEC-194）。

## 2. 逐路由声明

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 其他 |
|---|---|---|---|---|---|---|
| GET | `/calc-rules` | object | CalcRule；view；无按钮 | list `configScopeSql(created_by)`，分页前过滤 | projector 裁剪；带 `enabled` 筛选而无 `enabled` 查看权 → 403 `FILTER_FIELD_HIDDEN` | 信封 `hasDataPermission`；每条带完整聚合（不含 `hints`） |
| GET | `/calc-rules/:id` | object | 同上 | point id → `requireConfigVisible(createdBy)`；范围外与不存在同为 404 | 同列表 | ETag = revision |
| POST | `/calc-rules` | object | CalcRule；create；create@list；**另需字段目录 `TalentReview.Field` 的 view（`requireCatalogAccess`，条件守卫 `talentReview.calcRuleFieldCatalog`）** | `requireConfigCreatable`（只有看全部可建，否则 404）；目标字段与公式字段按字段目录范围解析可见 | 严格结构；逐字段编辑权；返回含 `hints`（经 `hints` 字段查看权裁剪） | REV（=0）、IDEM；201 |
| PATCH | `/calc-rules/:id` | object | CalcRule；update；update@detail；带 `items` 时同上 | 行锁 → `requireConfigVisible` → REV；返回前复核 | 严格结构；逐字段编辑权（含 `items: []` 显式清空）；**改名要求看全部**（`NAME_REQUIRES_SEE_ALL`，在查重之前） | REV、IDEM；`items` 整组替换 |
| DELETE | `/calc-rules/:id` | object | CalcRule；delete；delete@detail | 行锁 → `requireConfigVisible` → REV → 引用守卫 | 无字段赋值；返回删除前聚合 | 被引用 409 `CALC_RULE_IN_USE`；计算项目随规则删除，快照含全部项目 |

## 3. 业务规则与错误码

| 规则 | 码 | 依据 |
|---|---|---|
| 规则名称租户唯一 | 409 `CALC_RULE_DUPLICATE` | 设计 §2 通用约定 |
| 计算项目按目标字段对应：规则内目标字段唯一；保存后只读（改目标 = 删除再新增） | 400 `CALC_ITEM_TARGET_DUPLICATE` | 设计 §2.2、§7（目标字段保存后只读） |
| 目标字段不存在 / 不在字段目录范围内 | 404 `NOT_FOUND`（同一个响应） | AGENTS §10、OCR 路由规则 |
| 目标字段不能是多选、系统写入字段 | 400 `TARGET_FIELD_NOT_ALLOWED`（带项目下标 `item`） | 设计 §4.5(d) 表 |
| 新选作目标的字段须已启用 | 400 `CALC_TARGET_DISABLED` | 设计 §7 启停行 |
| 保存校验 validateFormula：语法、函数、参数个数、未知字段、类型 | 400 `FORMULA_INVALID`（带 `item`、`issues[{code,message,line,column}]`） | 设计 §4.3、DEC-287 |
| 公式引用多选字段 | 400 `MULTI_OPTION_IN_FORMULA`（带 `item`、`fields`） | DEC-314②（取证前禁用 🟡） |
| 循环依赖、优先级与依赖矛盾、类型不确定：**只提示、不拦截**，写响应的 `hints`（`order / warnings / cycles / blocked`）给出 | — | DEC-274、DEC-287② |
| `uses_ranking` 由公式用到的函数派生（排名函数 `skipInTodoTrigger`） | — | DEC-260 |
| 规则 `revision` 随规则或其项目的任何保存 +1 | — | 设计 §2.2（run 冻结核对“规则已改”） |

## 4. 设计自定项（🟡）

- **C-B5-1 公式按字段名引用盘点字段**：`盘点对象.<字段名>`（`26` §8 原站写法），固定字段 `盘点活动.项目名称 / 盘点活动.盘点年度 / 盘点对象.盘点方案`；字段目录里重名的字段不进公式字段目录。字段改名不会改写已存公式——B1 的字段名没有唯一约束也没有改名联动，设计未规定；需要总编排决定是否改成按编码 / id 存公式或加改名守卫（已写进 PR 描述“待决策”）。
- **C-B5-2** 公式和目标字段只在**当前操作人可见**的字段里解析：看不到的字段名与不存在的字段名同为未知字段，不暴露隐藏字段。
- **C-B5-3** 启用（`enabled: true`）不重新分析公式：公式在最近一次提交 `items` 时已校验；不带 `items` 的修改不需要字段目录权限。
- **C-B5-4** `hints` 只在提交了 `items` 的写响应里出现（GET 不带）；设计未规定提示的载体。

## 5. 查看人 × 接口 × 字段

| 查看人 | 列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 盘点管理员（预置，看全部） | 全部规则，字段按查看权 | 按数据操作权、按钮与字段编辑权；提交项目另需字段目录查看权 | 日志入口权 + 对象查看权 + 看全部 |
| 有对象查看权、范围缺省为空 | 列表空、`hasDataPermission = false`；详情 404 | 新建 / 修改 / 删除 404（不落库） | 不可见 |
| 有创建人规则 | 只看自己建的 | 只能改 / 删自己建的，不能改名（403）；新建 404（DEC-082） | 只看自己建的 |
| 缺某字段查看权 | 该键缺席（含 `hints`）；按 `enabled` 筛选而无查看权 403 | 写该字段（含 `items: []`）403 | 该字段裁剪 |
| 缺字段目录查看权 | 正常读取 | 提交项目的新建 / 修改 403；目标字段在其范围外 404；公式里看不到的字段名 400（与不存在相同） | — |
| 缺按钮 / 撤看全部后重放 | — | 首次与重放 403 / 404，业务不变 | — |
| 其他租户 | 列表不带出；详情 404 | 404 | 不可见 |

## 6. 写入口 × 值来源（DEC-251）

| 写入口 | 人工输入 | 继承 / 保留 | 派生 | 系统值 | 测试 |
|---|---|---|---|---|---|
| `POST /calc-rules` | 名称、窗口、说明、启用、计算项目（目标字段、优先级、公式、说明） | — | `uses_ranking`、`hints`、revision = 1 | 创建人 / 时间 | `AC-TR-calc-rule-save` |
| `PATCH /calc-rules/:id` | 同上 | 未提交字段保留；未提交 `items` 保留；相同目标的项目更新 | `uses_ranking`、`hints`、revision + 1 | 更新人 / 时间 | `AC-TR-calc-rule-save`、`-permissions`、`-pg` |
| `DELETE /calc-rules/:id` | — | — | 项目级联删除 | — | `AC-TR-calc-rule-save` |

无导入 / 批量 / 调度 / 向后更新 / 草稿 / 审批入口。

## 7. 引用守卫（非路由）

| 名称 | 位置 | 说明 |
|---|---|---|
| `registerConfigReferenceGuard('calcRule', guard)` | `config-kit.ts` | 项目（B7）引用计算规则时登记；删除时同事务询问，409 `CALC_RULE_IN_USE` |
| `registerConfigReferenceGuard('field', …)`（本 PR 登记） | `calc-rule-service.ts` | 被计算项目作目标的字段不能删（`FIELD_IN_USE`，referrer = `CALC_RULE`）；库外键 restrict 兜底。公式里按名称引用的字段无法守卫（C-B5-1） |
