# F-039 权限框架强制 PR-B：设计与拆分 v1

> 任务：F-039 PR-B（C 档，设计先行 DEC-249 / 285③；DEC-338①：设计与拆分由 Opus 做，实现拆小交 Sonnet，审查由 Codex 做）
> 分支：`claude/F-039-pr-b-design`（基于 main e2e2979，PR-A #110 已合并为 6bf3b13）｜状态：**只交设计，未写代码**
> 依据：DEC-285①、DEC-291、DEC-297④、DEC-300、DEC-303、DEC-333、DEC-338、DEC-348②、DEC-351；PR-A 设计 `docs/08_设计/F-039_权限框架强制_设计.md`（下称“PR-A 设计”）
> 输入：PR #110 描述 §七“PR-B 待办”与“第 5 轮止损转入项”6 项；审查原文——设计审第 6 轮（#issuecomment-6051601031）、实现审第 1～4 轮（6074970833、6076506504、6077749331、6080378392）、修法说明复审（6078712761）与确认（6078713272）、两次补登窄审（6080892877、6081336908）；PR-A 设计 §4.4～4.8、§8、§10.6、§10.7

## 0. 一页摘要

- **PR-B 的定位**：把 PR-A 的“声明门禁”从**结构比对**补到**语义比对**，全程**零行为变化**——改动只落在 `tests/acceptance/**` 和各模块 `policy.ts` 的声明登记（IDP 嵌套披露拆分）；处理函数、授权调用、查询过滤、响应裁剪一律不动。
- **十二项**（§2 逐项写修法、零行为影响、测试与反例）：
  - **B-01～B-05**：PR-A 第 4 轮转入的 5 项门禁漏报。披露分支丢失 OR 与嵌套语义；证据摘要不覆盖决定实参的依赖；范围没有绑定到提供权限的节点；R9 去重键缺调用点；突变覆盖断言不记录备选位置。
  - **B-06**：IDP 嵌套内容按对象拆成披露分支。
  - **B-07**：动态输入分支与对象 / 操作 / 按钮的逐值对应。
  - **B-08**：多维身份探测。用测试内的**可编程授权替身**（注入 `authorize` 并登记范围提供器，现有机制）实现“每次只改一个授权答案”；先做不需要样本的 Tier 0，覆盖全部端点。
  - **B-09**：Tier 1 成功对照样本，覆盖拒绝码、嵌套字段路径、台账、过度声明、关系，即 FW-03～08。
  - **B-10**：recorded 事实的双向闭环。
  - **B-11**：可信基线协议按 DEC-303 重新界定。PENDING_B 已取消，PR-A 设计 §10.6 的 allowlist 协议失去对象，改为“削减登记”。
  - **B-12**：声明接管运行时授权（T1～T4）。**本期不做**，列出前置条件与分阶段方式，等用户决定。
- **会改变运行时授权的项：无。** 只有 B-12 的接管路线会改变运行时，本设计不实现，写成口径 Q-B1 请用户决定。
- **拆分（§4）**：
  - 静态门禁 3 个：PR-B1 披露语义 + 范围绑定 + 覆盖 + R9；PR-B2 证据依赖闭包 + 分支值绑定；PR-B3 IDP 嵌套披露拆分。
  - 探测框架 1 个：PR-B4 授权替身 + Tier 0 + recorded 收集器 + invalidId。
  - Tier 1 样本按模块组 8 个：PR-B5a～B5h，是否全部纳入本期见 Q-B2。
  - 治理 1 个 + `ci.yml` 1 个：PR-B6 / PR-B6-ci，是否做见 Q-B4。
  - 每个约 800～1500 行（不含生成文件）。PR-B1 / B2 / B4 可并行；B3 依赖 B1；B5x 依赖 B4。
- **口径（§5）**：Q-B1 接管路线、Q-B2 Tier 1 范围、Q-B3 嵌套字段路径的声明侧登记时机、Q-B4 可信基线协议、Q-B5 §4.8 矩阵是否保留为人读产物、Q-B6 FW 测试文件命名。均为**复刻系统**口径，不涉及北森测试租户。

## 1. 范围与零行为变化边界

### 1.1 来源 → 编号

| 编号 | 来源（审查原文 / PR #110 描述） | 级别 |
|---|---|---|
| B-01 | 转入项 1：披露分支丢失 OR 与嵌套 optional 语义，33 个披露位置施加 OR 弱化全部漏报（6080378392 二-1；`perms.ts` branchPerms 递归并集、`required.ts` R3 只查键存在） | P2 |
| B-02 | 转入项 2：证据摘要没覆盖全部决定授权实参的实现（360 `levelOf`；6080378392 二-2） | P2 |
| B-03 | 转入项 3：范围要求没有绑定到提供对应权限的节点（360 自动添加评价者、IDP 删除流程 / 模板 / 计划；6080378392 二-3） | P2 |
| B-04 | 转入项 4：R9 去重键没有调用点（`evidence.ts` identity；6080378392 P3） | P3 |
| B-05 | 转入项 5：突变覆盖断言不记备选位置、排除了“或”组义务（`AC-PRM-FW-02-required` 覆盖断言；6080378392 P3） | P3 |
| B-06 | 转入项 6：IDP 嵌套内容（`projectionOf`）没有按对象拆成披露分支（开发自查登记） | P2 |
| B-07 | 实现审第 2 轮能力边界：“输入分支 → 对象 / 操作”对应关系（人才表单六键映射全改成指标库，比较器零发现；6076506504） | 限定版能力缺口 |
| B-08 | 设计审第 6 轮 P2-2：探测器把多维身份变化误判成单维事实（6051601031）；PR-A 设计 §10.6“多维身份探测” | P2（转入） |
| B-09 | PR-A 设计 §10.6“PR-A 基准测不到的突变”：删嵌套字段路径、拒绝码改宽 / 改错、`ledger` perItem→single、无依据 N/A；过度声明方向；FW-03～08 | 转入 |
| B-10 | 设计审第 6 轮 P2-3：recorded 事实的防同步删减没有闭环（6051601031） | P2（转入） |
| B-11 | PR-A 设计 §10.6 可信基线 / 有限例外 / retired / `OPEN_BATCHES` / 初始化批准 / 门禁协议（含第 5 轮 P2-② / P2-③） | 转入 |
| B-12 | PR-A 设计 §9 / §10.1～10.5“接管 PR 系列 T1～T4”与 §10.7 提醒 | 路线 |

### 1.2 零行为变化边界（PR-B 全体）

| 允许改动 | 不允许改动 |
|---|---|
| `tests/acceptance/**`：比较器、显式表、突变、证据、探测器、样本、冻结文件 | 任何处理函数、授权辅助函数、查询过滤、响应裁剪 |
| `apps/api/src/**/policy.ts` 与 `app-policy.ts`：声明登记的增补与改正（B-06 的 IDP 嵌套披露分支；审定中发现的登记错误） | `apps/api/src/route-policy/*` 的运行时行为（包装仍只做注册身份核对与自检） |
| 测试代码以相对路径**只读引用**产品内部导出（先例：`domains.ts` 引用 `approval/adapters.ts`）。B-08 用 `modules/permission/module-access.ts` 的 `registerScopeProvider` 给测试替身登记范围提供器，不改产品代码 | 产品代码 import 测试代码；新增产品导出（如确需，走契约 PR） |

**判定方法**（每个实现 PR 的自检必做）：`git diff origin/main -- apps packages` 只出现 `policy.ts` / `app-policy.ts`；FW 全绿；相关模块既有验收测试全绿。

## 2. 逐项设计

### B-01 披露分支：逐披露备选比较，区分直接授予与再次可选的授予

**现状漏洞**：`perms.ts` 的 `branchPerms` 把可选分支（含其 `of` 与嵌套 `optional`）所有节点的键递归取并集；R3 只查“同名分支里有这个键”。所以把披露分支改成 `any([原 HR 按钮策略, 普通成员])`，或把按钮下沉到分支里的嵌套 optional，都仍被视为“授予了”。

**现状实测**（本设计用只读脚本枚举全部 387 条声明）：33 个可选分支**全部挂在声明根节点**；没有一个挂在 `of[i]` 下，没有嵌套 optional，没有 `kind: 'any'` 的可选分支。所以下面的结构约束对现有声明零改动。

**修法**

1. `perms.ts`：`declaredPerms().optional` 由“名字 → 权限并集”改为“名字 → **该分支自身的析取范式备选**列表（`PermMap[]`），不含分支内的嵌套 optional”。另返回每个可选分支的挂载位置（节点路径）。
2. 新增结构规则（`required.ts`，在 R3 之前执行）：

   | 规则 | 内容 | 失败码 |
   |---|---|---|
   | D1 | 可选分支只能挂在声明根节点（披露对每个准入备选都成立） | `OPTIONAL_POSITION` |
   | D2 | 可选分支内不得再有 optional（“再次可选的授予”不算直接授予，也没有现状用例） | `OPTIONAL_NESTED` |

3. R3 改为**逐披露备选**：披露义务 `disclosure:<名>` 要求同名分支的**每个**备选都含该权限键；有一个备选不含（如 `any` 里混进普通成员）就报 `DISCLOSURE_WEAK`，并指出第几个备选。分支不存在仍报 `DISCLOSURE_MISSING`。
4. 披露义务也允许“或”组：同一披露名下带 `or` 的义务，按“同一备选内 AND、备选之间 OR”，要求分支的每个备选至少满足一组。现有表里没有这种义务，规则写全，不用于现状。
5. R7（表外权限）改为对分支各备选的并集检查，语义不变。

**零行为影响**：只改测试支持代码。

**测试与反例**（新文件 `AC-PRM-FW-02-disclosure.test.ts`）

- 真实声明零发现（33 个位置）。
- 审查原文两例：
  - 经理入口 `canViewReporting` 改为 `any([HR 按钮, member])`，报 `DISCLOSURE_WEAK`；
  - HR 按钮下沉进嵌套 optional，报 `OPTIONAL_NESTED` 和 `DISCLOSURE_MISSING`。
- 新增结构弱化，加进 `weakenings.ts`。它们按声明结构和表的披露义务生成，不经比较器筛选：

  | 弱化 | 期望 |
  |---|---|
  | `disclosure→any-member`：每个披露分支换成 `any([原分支, member])` | `DISCLOSURE_WEAK` |
  | `disclosure→nested`：把原分支整体挪进一个只含普通成员的新分支的嵌套 optional | `OPTIONAL_NESTED` |
  | `disclosure→moved`：根上的可选分支挪到某个 `of[i]` 节点 | `OPTIONAL_POSITION`；声明没有 `of` 的端点不生成 |

  测试断言三类弱化的实例数分别等于“披露名 × 端点”的数量（现状 33 / 33 / 有 `of` 的端点数），并逐个报出。
- 回归：既有的 `disclosure→none`、`disclosure→admission`、经理入口真实声明、模型图共用 point 范围，结果都不变。

### B-02 证据依赖闭包：决定实参的实现一改就要复核

**现状漏洞**：证据单元只登记调用点、授权实现、常量**本身**的摘要。实现内部再调用的辅助函数没有摘要，例如 360 `routeNeed → levelOf` 决定按钮层级 `@list / @detail`；它被改动时不报 `EVIDENCE_STALE`。

**修法**

1. 每个证据单元 U 求**依赖闭包** D(U)。从 U 的文本出发，逐层解析引用的标识符：
   - 同文件顶层函数 / 常量；
   - 相对 import 指向的 `apps/api/src/**` 导出；
   - `@italent/domain` 导出解析到 `packages/domain/src/**` 的声明。

   深度上限 4。不解析以下几类：
   - 注入依赖：`deps.*`、函数形参；
   - 纯类型；
   - 边界清单内的文件。
2. **边界清单** `EVIDENCE_CLOSURE_BOUNDARY`（新文件 `support/route-policy/evidence-boundary.ts`，只放字面量）：授权引擎与通用基础设施，例如 `errors.ts`、`modules/permission/authorizer.ts`、`commands.ts`、`@italent/db`。
   - 每条写理由，例如“授权引擎本身，由 AC-PRM-* 覆盖；改动不改变调用点实参”。
   - **模块内辅助函数不得进边界**：清单项不得位于 `modules/<模块>/` 下，引擎文件（`modules/permission/*`）除外。测试断言这一点。
3. `required/digests.ts` 新增 `DEPENDENCIES` 段：单元 → { 依赖单元 → 摘要 }，由 `ROUTE_POLICY_UPDATE_DIGESTS=1` 一并生成。属于生成文件，不计行数。校验时重新计算闭包：
   - 依赖摘要变化，或依赖集合增减，报 `EVIDENCE_STALE`；明细写“依赖 X 变化（经 U 引用）”和受影响义务清单。
4. **噪声上限**：PR-B2 先实测，结果写进 PR 描述——闭包单元数、单个依赖牵连的义务数分布。若某个非引擎依赖牵连超过 100 条义务，先在 PR 里列出、由审查裁定，不自行加进边界。

**零行为影响**：只改测试支持代码；`digests.ts` 重新生成。

**测试与反例**（新文件 `AC-PRM-FW-02-evidence.test.ts`）

- 审查原文例：内存读取器把 `levelOf` 改成恒返 `'detail'`，报 `EVIDENCE_STALE`，明细列出引用 `routeNeed` 的 360 义务。
- 依赖集合变化：在 `routeNeed` 里新增一次对同文件函数的调用，报 `EVIDENCE_STALE`（依赖增加）。
- 边界：改 `errors.ts` 的 `AppError` 不触发；在边界清单里加一个 `modules/survey360/` 下的文件，测试失败。
- 回归：调用点 / 实现 / 常量三端各自改动仍报 `EVIDENCE_STALE`；锚点改错仍报 `EVIDENCE_ANCHOR`。
- 保留 PR-A 已有的说明性用例“只改权限键、保留真实锚点和摘要发现不了”；语义核对由 B-08 的授权轨迹补上（B-08 P1）。

### B-03 范围要求绑定到提供权限的节点

**现状漏洞**：比较器按备选判断“有没有 point / 范围”（`scopePoint` 维度在备选内取并集）。同一备选里有多个对象节点时，把主对象的 point 范围挪给子对象节点仍然通过。

**现状实测**：387 条里有 20 条端点的某个准入备选包含 ≥2 个能承载范围的节点（`object` / `admin`），其中 15 条带范围。涉及人员子集详情、调动合同列表、人才表单与模型图写入口、IDP 删除流程 / 模板 / 计划、复制、统一下发，以及 360 的同步 / 冲突 / 自动添加。

**修法**

1. 义务新增 `need?: { scope: 'point' | 'list' | 'see-all' | 'guard' | 'none'; locator?: string; predicate?: string; at: Evidence[] }`。`need.at` 至少一条 `call`，指向强制范围判定的调用点，例如 `employeeInScope`、`requireScopedEmploymentObject`，与义务证据同样走摘要。
2. `perms.ts` 的权限来源已记录节点路径；新增按来源节点取该节点范围：`scope` 字段，或 `byObject[编码 | '*']`。
3. 新增规则：

   | 规则 | 内容 | 失败码 |
   |---|---|---|
   | R1b | 带 `need` 的准入义务：在每个声明备选里，提供该权限的来源节点中至少一个，其范围模式等于 `need.scope`；写了 `locator` / `predicate` 的，名字也要相等 | `REQUIRED_NEED` |
   | R1c | 某个声明备选含 ≥2 个承载节点时，由这些节点提供的每条 `obj:` / `admin:` 准入义务都必须写 `need`（含 `none`）；单承载节点的备选沿用第二道比较的 `scopePoint` | `NEED_UNBOUND` |

4. 表的工作量：上述 20 条端点约 45 条义务补 `need`，逐条对源码审定。审定台账随 PR 评论贴出（格式同 PR-A #issuecomment-6079923618）。

**零行为影响**：只改测试支持代码与表。

**测试与反例**（并入 `AC-PRM-FW-02-disclosure.test.ts`，或单列 `-scope-binding`，由实现方定）

- 审查原文例：
  - 360 自动添加评价者：`Survey360.Relation:create` 的 point 移到 `EmployeeInformation:view` 节点，报 `REQUIRED_NEED`；
  - IDP 删除流程 / 模板 / 计划：主对象 point 移给子对象，报 `REQUIRED_NEED`。
- 新增结构弱化 `scope→sibling`：在含 ≥2 承载节点的备选里，对每一对范围不同的节点交换范围。全部实例都必须报 `REQUIRED_NEED`；实例数断言等于生成数。
- 去掉一条 `need`，报 `NEED_UNBOUND`。

### B-04 R9 去重键加调用点

**修法**：`evidence.ts` 的 identity 改为 `perm | purpose | or | 排序后的 call 单元列表`。只有完全相同才报 `TABLE_CONFLICT`。同权限、同用途、不同调用点的独立义务允许并存。

**测试**：

- 两条义务权限、用途相同，调用点不同：不报。
- 四项全同：报 `TABLE_CONFLICT`。
- IDP 执行人入口“守卫内部 + 披露”的复用仍通过。

### B-05 突变覆盖：按“端点 + 权限 + 备选位置”，含“或”组

**修法**（`required-mutate.ts` 与覆盖断言）

1. 覆盖键改为 `端点 | 权限 | 备选 i | 来源路径`。`required→none` 与 `required→optional` 都核对：每条准入义务在每个“提供它的声明备选”上都有突变。
2. “或”组义务：对声明备选 i 与组 g，先求 i 满足的组内备选集合 S。
   - |S| = 1：对 S 中备选的每个权限生成 `or-member→none`，期望 `REQUIRED_MISSING`。
   - |S| > 1：生成 `or-group→none`，删去每个已满足组内备选各一个权限，期望 `REQUIRED_MISSING`。

   覆盖断言要求每个（端点, 组, 备选 i）至少有一个突变，|S| = 1 时组内每个权限各一个。
3. 测试输出“类 × 用途 × 端点”的实例清单与各类计数，供 PR 描述引用。断言用集合相等，不用“至少一个”。

**测试**：

- 覆盖断言本身。
- 故意少生成一个备选的突变（夹具）：覆盖断言失败。
- 人才候选编辑分支（update + 按钮 + 守卫）：删其中任一项都报出。

### B-06 IDP 嵌套内容逐对象拆成披露分支

**现状**：展示器按对象查看权省略嵌套内容，现状统一登记为投影器 `idp.*`，表里没有逐对象的披露义务。有三处：

- 流程 `processPresenter`：子流程；
- 模板 `templatePresenter`：模块、通用目标；
- 计划 `planProjections`：12 个对象的投影、3 类关键信息的范围、任职记录字段与范围。

**修法**（只改声明登记与表）

1. PR-B3 先静态枚举调用这三个展示器的端点（闭包含 `processPresenter` / `templatePresenter` / `planProjections` / `projectionOf`），清单写进 PR 描述。粗估流程 5 条、模板 5 条、计划约 10 条。
2. 每条端点的声明根上，按嵌套对象各加一个可选分支：
   - 名称 `nested.<对象键>`，如 `nested.subProcess`；
   - 内容 = `object(IDP.<对象>, view, button none, scope …, fields none)`。
   - 嵌套对象范围随主对象的写 `noScope('范围随主对象')`。
   - 关键信息与任职记录现状另解析范围（`resolveModuleScope(…, code, \`${code}.detail\`)`），登记为 `listScope('idp.keyInfoScope(<kind>)')` / `listScope('idp.employmentScope')`。
   - 名称与谓词名在 PR-B3 审定时定稿，写进 PR 描述。
3. 表：每个分支一条 `disclosure:nested.<键>` 义务，证据三端：
   - call：展示器里 `projectionOf(deps, ctx, '<键>')` 那一句；
   - impl：`objectFields`；
   - const：`IDP_OBJECTS><键>`。

   基准里对应的对象 × 操作事实改由这些披露义务承接（R8）。同一权限在本端点另有准入用途的，按 R9（B-04）并存。
4. 投影器 `idp.*` 的登记保留（出口形状），只是嵌套部分不再隐含在里面。

**零行为影响**：声明是登记元数据，运行时不据此鉴权（PR-A 设计 §3.1）。改动只在 `idp/policy.ts` 与表。

**测试**：

- B-01 的三类结构弱化与 `disclosure→none` / `disclosure→admission` 自动覆盖新分支；测试断言 IDP 新增分支数等于枚举数。
- B-08 落地后，Tier 0 / Tier 1 的授权轨迹会对这些分支做语义核对：撤 `object.view` 嵌套对象后响应只少该段（B-08 P2）。

### B-07 动态输入分支与对象 / 操作 / 按钮的逐值对应

**现状漏洞**：比较器只核对选择器的**键集合**等于本路由绑定的域，不核对每个键映射到的值。人才表单六个键的对象全改成指标库，零发现。

**修法**

1. `domains.ts` 在域常量旁新增**分支值表** `branchValues`：域 → [{ 字段: `object | operation | button | relation`, 值: { 分支键 → 值 } }]。取值优先来自源码导出常量（运行时求值）：
   - `job.kind` → `JOB_OBJECT_CODES`；
   - `personnel.subset` → `SUBSETS[k].objectCode`；
   - `talent.object` → `TALENT_OBJECTS[k].code`；
   - `contracts.commandButton` → `contractAction(op, mode)` 加层级；
   - 其余同理。
   - 源码里内联、没有常量的映射：例如合同 `operation` → `create | update`，待办 `action` → 当前审批人 / 发起人，导入 `mode` → 操作。这类按字面量登记，每条带证据（单元 + 锚点），复用 `evidence.ts` 的锚点与摘要校验，单元一改就 `EVIDENCE_STALE`。
2. `compare.ts` 的 `compareSelectors`：键集合绑定到域之后，对 `map` 型选择器（`param` / `body` / `query`）按字段逐键比较值：
   - 值不等，报 `MISMATCH:branchValue`；
   - 该（域, 字段）没有登记分支值表，报 `BRANCH_VALUE_UNBOUND`，强制登记。
   - `mapper` / `record` 选择器没有逐键映射，仍按值域集合相等，现状已做。
3. 新增结构弱化 `selector→value`：把 `map` 的全部值换成同域的第一个值；若全相同，换成另一个合法编码。必须报 `MISMATCH:branchValue`。

**零行为影响**：只改测试支持代码。

**测试**：

- 审查原文例：人才表单六键全改成指标库，报 `MISMATCH:branchValue`。
- job `:kind` 两键对调，同样报出。
- 删一条分支值登记，报 `BRANCH_VALUE_UNBOUND`。
- 改内联映射所在函数，报 `EVIDENCE_STALE`。
- B-08 落地后用授权轨迹动态复核：逐个分支值发请求，记录实际请求的资源，与分支值表比较（B-08 P4）。

### B-08 多维身份探测：可编程授权替身 + 单维撤权（Tier 0）

**设计审第 6 轮 P2-2 的问题**：v6 用真实身份模板（H / A / O / F / B …）对照，换用户时身份、能力、绑定、范围同时变化，推不出单维事实。

**修法：不换用户，只换“授权答案”。** `createApp` 已支持注入 `authorize`（`AppDeps.authorize`），`module-access.ts` 也支持给授权器登记范围 / 字段提供器（`registerScopeProvider`，权限模块与自助模块现在就这样用）。PR-B4 在测试里建一个**授权替身**：

| 组成 | 行为 |
|---|---|
| `authorize(request)` | 默认全部允许；`deny` 匹配器命中时拒绝；每次调用记录（`action`、`resource`、`fields`），**同时记录事务内绑定版本**（`authorizeInTransaction` 经 `provider.authorize`） |
| `provider.scope(query)` | 按配置返回 `all` / 空 / 指定组织；记录查询（`objectCode`、`pageCode`、`viewCode`） |
| `provider.fields(…)` | 按配置返回全部字段 / 去掉某对象的字段；记录查询 |
| 身份 | 一个真实的租户成员（成员中间件照常校验）；关系、本人绑定、成员资格等**数据态**维度不经授权器，由 Tier 1 样本处理 |

**Tier 0（不需要样本，覆盖全部端点）**：沿用 PR-A 边界探测的请求，即占位路径参数，写请求体 `{}`。

1. **对照**：全允许，得到结果 O₀（状态码 + 错误码 + 响应）与**授权轨迹** T₀。轨迹按集合规范化，不依赖 `Promise.all` 的调用顺序。
2. **单维撤权**：对 T₀ 中每个不同的授权请求 r、每个范围 / 字段查询 q，各重跑一次，只拒绝 r 或只让 q 返回空。记录效果：
   - `deny:<status>/<code>`：结果从 O₀ 变成拒绝；
   - `diff:<消失的响应路径>`：仍是 2xx，但响应变少；
   - `none`：无变化。
3. **非法标识**：有 UUID 路径参数的端点，把第一个换成 `not-a-uuid`，全允许，记录状态码 / 错误码。
4. 冻结到 `baseline/probe/<模块>.json`（生成文件，逐字节比较；`ROUTE_POLICY_UPDATE_BASELINE=1` 重生成）。按模块分文件，便于 CI 分片和评审。

**新校验器 `probe-check.ts`**（第三道，不改前两道）：授权请求与权限键的映射表 `request-perms.ts`：

- `object.<op>` + 资源编码 → `obj:<编码>:<op>`；
- `object.button` + `buttonResource` → `btn:<编码>#<按钮>@<层级>`；
- `admin.<能力>` 与 `tenant.*` 别名 → `admin:<能力>`。别名表从 `@italent/domain` 的 `MODULE_ACTIONS`（授权器 `authorizer.ts` 用同一常量）读取，不手抄。
- 映射不了的动作报 `PROBE_ACTION_UNMAPPED`，必须先登记。审计用的 `action` 字段不经授权器，不受影响。

| 规则 | 内容 | 失败码 |
|---|---|---|
| P1 | 效果为 `deny` 的 r：映射的权限键在本端点必须有义务承接，用途为准入、条件准入、或承载者是准入义务的守卫内部；只有披露用途 → 报错；完全没有义务 → 报错 | `PROBE_PURPOSE_MISMATCH` / `PROBE_ADMISSION_UNCLAIMED` |
| P2 | 效果为 `diff` 的 r：映射的权限键必须有披露（或守卫内部）义务；只有准入用途 → 报错 | `PROBE_PURPOSE_MISMATCH` |
| P3 | 非法标识：观测码与根节点的 `invalidId` 相等；声明没写但观测到 400 / 404 → 报错 | `MISMATCH:invalidId` |
| P4 | 分支值动态复核（B-07）：`domains.ts` 为域登记输入位置（如 `param:kind`、`body:operation`，带证据）；探测器逐个分支值发请求，轨迹里的资源必须等于分支值表；Tier 0 走不到判定点的分支记“未达”，不判 | `MISMATCH:branchValue(probe)` |
| P5 | 拒绝码：r 映射到的声明节点自带 `denied`（按钮策略、关系、本人）时，观测码必须相等 | `MISMATCH:denial` |

- **P1 / P2 把显式表的“用途”从人工审定升级为可执行核对**。PR-A 承认“锚点存在不是语义证明”，这里补上：Transfer.Hr 错登成 Transfer.Manager 时，轨迹里出现的是 `Transfer.Hr` 资源，映射后找不到义务，报 `PROBE_ADMISSION_UNCLAIMED`。
- Tier 0 只能看到“在加载对象之前”的判定。占位标识在加载处 404 之后的判定由 Tier 1 补；P1 / P2 对轨迹之外的义务不判。
- **recorded 收集器**（B-10 的框架）同在 PR-B4 交付。

**零行为影响**：替身只存在于测试；`registerScopeProvider` 只读引用。唯一的产品耦合是 `module-access.ts` 的提供器接口：形状改了，替身编译失败，属于测试支持代码的维护范围。

**CI 时长**：Tier 0 请求数约为 387 ×（1 + 平均撤权数 3～6）+ 非法标识约 250，粗估 2000～3000 次 PGlite 请求。PR-B4 实测，写进 PR 描述。单个测试文件超过 3 分钟就按模块拆文件，让三分片分摊。PR-A 第 4 轮实测最慢分片 13 分钟，上限 25 分钟。

**测试与反例**（新文件 `AC-PRM-FW-08.probe.test.ts`，命名见 Q-B6）：

- 冻结文件新鲜度。
- 真实声明 + 表零发现。
- Transfer.Hr 表项错登成 Transfer.Manager，报 `PROBE_ADMISSION_UNCLAIMED`。
- 经理入口 `canViewReporting` 的义务改成准入，报 `PROBE_PURPOSE_MISMATCH`，按 Tier 0 能否走到成功路径决定是否适用。
- 某端点 `invalidId` 改成 404，报 `MISMATCH:invalidId`。
- 映射表删一条，报 `PROBE_ACTION_UNMAPPED`。
- 替身自检：`deny` 匹配器命中的请求确实被拒；事务内授权（`authorizeInTransaction`）同样被记录、被拒。

### B-09 Tier 1：成功对照样本与 FW-03～08

Tier 0 到不了成功路径的维度：

- 范围外拒绝码；
- 列表过滤先于分页；
- 嵌套字段路径；
- 台账计数；
- 关系 / 本人 / 跨租户；
- 命令重放；
- 过度声明（声明要求、现状不要求）。

这些需要**成功对照样本**：每条端点一个能 2xx 的请求，包括种子数据、合法请求体、`If-Match` / `Idempotency-Key`。

**修法**

1. **样本工厂**：`support/route-policy/samples/<模块组>.ts`，每条端点 `success(ctx)` 返回请求。
   - 种子数据优先直接写库（快、确定）。必须经业务命令才能成立的（审批实例、任职生效链）调用模块 API。
   - 写端点的撤权探针排在对照之前：撤权应当拒绝，所以不写库。若某撤权没有被拒（2xx），说明发生了写入；该次之后重新造样本，结果本身就是发现（过度声明或现状缺陷）。
2. **覆盖台账** `baseline/probe-coverage.json`（生成）：端点 → `tier: 0 | 1`。没有 Tier 1 样本的必须写理由，引用 `docs/` 或 DEC。
   - “删样本 / 改 N/A”使冻结文件变化，新鲜度红，即 v6 的“无依据 N/A”突变。
   - 同组端点缺样本且无理由，报 `PROBE_SAMPLE_MISSING`。
3. **Tier 1 探针**（在 Tier 0 的 P1～P5 基础上，全部在成功路径上做）：

   | 维度 | 做法 | 冻结的事实 | 与声明比较 |
   |---|---|---|---|
   | 准入 / 披露（FW-02 语义） | 成功对照轨迹 T₁；对每个 r 单独拒绝 | `deny` / `diff` / `none` | P1 / P2（成功路径版）；声明的准入义务在 T₁ 里撤掉后**不拒绝**，报 `OVERDECLARED:<perm>`，条件准入的另一输入样本除外 |
   | 范围（FW-03） | 范围提供器对相关对象返回空 / 只含另一组织；列表看条数与 `hasDataPermission`，详情 / 写看状态码 | `scope:<对象>` → 观测码 / 列表结果 | `scope.denied` 与观测相等（`MISMATCH:denial`）；声明 `scope: none` 但观测敏感，报 `WEAKER:scope` |
   | 嵌套字段路径（FW-04） | 字段提供器去掉对象 X 的全部字段，记录消失的 JSON 路径（数组用 `[*]`）；再对每条路径单撤一个代表字段确认 | `fieldPaths:{ X: [路径] }` | 本期只冻结为现状事实（防回退）；声明侧路径登记见 Q-B3 |
   | 命令重放（FW-05） | 对照成功后，在撤掉某准入 r 的情况下同键同体重放 | 观测码 + 台账增量 | 期望拒绝且台账 +0；不符合，报 `REPLAY_*`，按现状登记或开 F |
   | 关系 / 前提（FW-06） | 只换请求人（同一替身授权）为非参与人 / 非当前审批人 / 非发起人；前提用 recorded 收集器（B-10） | 关系拒绝码 | `relation.denied` 相等 |
   | 批量 / 导入 / 台账（FW-07） | 对照成功后计 `command_ledger` 增量与失败日志 | `ledger:<n>` | `write.ledger`：single → 1，perItem → 项数；不等，报 `MISMATCH:ledger` |
   | 身份与租户（FW-08） | 跨租户样本 id；自助解绑 / 改绑；成员停用 | 观测码 | 声明的 `denied` / 本人语义 |

4. **按模块组分 PR**（§4）。每组交付：样本工厂、该组的探针事实冻结文件、该组的 FW-03～08 断言。断言由事实生成 `it()`，不手写场景表。
5. v6 的真实身份模板（H / A / O / F / B / M / S …）**不再作为单维事实的来源**。保留一个小的“真实授权器冒烟”集：每组各选 3～5 条端点，用真实授权器 + 真实授予的最小权限用户 M，验证替身结论与真实授权器一致，防止替身语义漂移。

**零行为影响**：只改测试。样本工厂只在测试库里造数。

**测试与反例**（每组）：

- 事实冻结新鲜度。
- 真实声明零发现。
- 每组至少各一个：`denied` 改宽（404→200）报 `MISMATCH:denial`；`ledger` perItem→single 报 `MISMATCH:ledger`（合同待办批量所在组）。
- 删除样本，报覆盖台账变化。
- 声明多写一个不必要的按钮，报 `OVERDECLARED`。

### B-10 recorded 事实的双向闭环

**问题**：只检查“证据用例存在且执行”时，同时删掉 recorded 事实和声明里的同一前提，测试仍全绿（设计审第 6 轮 P2-3）。

**修法**

1. PR-B4 交付收集器 `recorded.ts`：证据用例调用 `recordFact(端点, 类别, 值)`。
   - **值必须取自本次 HTTP 观测**：状态码 / 错误码 / `details.reason`、台账增量、审计 / 出站增量的类别，不允许写字面量。lint 或测试断言 `recordFact` 的第三个实参不是字面量。
   - 类别：`precondition:<名>`（命令内前提的触发码）、`outcome`（已提交的非 2xx）、`ledger`、`fixedKeys`。
2. 冻结 `baseline/recorded.json`。证据用例与比较**放在同一个测试文件里**：CI 分三片，跨文件收集不可靠。`afterAll` 双向核对：
   - 收集到但未冻结，报 `RECORDED_UNREGISTERED`；
   - 冻结了但没收集到，报 `RECORDED_STALE`。
3. 比较器用 recorded 的 `precondition:*` 与声明的 `write.preconditions` 双向比较：
   - recorded 有、声明没有，报 `WEAKER:precondition`；
   - 声明有、recorded 与静态原语都没有，报 `OVERDECLARED:precondition`。
4. 首批 recorded 事实随对应模块组交付：
   - 审批八个任务动作的前提与盲审 Outcome 403 已提交；
   - 合同待办批量 perItem；
   - 合同继承正例；
   - 固定键集合。

**零行为影响**：只改测试。

**反例**：

- 同时删 recorded 事实和声明前提：证据用例仍收集到该事实，报 `RECORDED_UNREGISTERED`。
- 把 `recordFact` 的值改成字面量：测试失败。
- 删证据用例：报 `RECORDED_STALE`。

### B-11 可信基线协议：按 DEC-303 重新界定

**事实**：PR-A 设计 §10.6 的协议对象是 `PENDING_B` / allowlist（101 条免声明端点）、有限例外、retired、`OPEN_BATCHES`、初始化批准 DEC 与告警 / 强制两种门禁模式。

- DEC-303 取消了 `PENDING_B`，PR-A 已对全部端点完整声明。缺失声明在任何阶段都是致命项，没有告警期。
- 在途 PR 新增路由的做法是“补声明 + 补表 + 重生成基准”：#146、#144 已按此合入，不需要例外机制。
- 因此第 5 轮 P2-② / P2-③（批准追溯绕过、未批准例外进入可信数据、初始化与缩减冲突）**针对的对象已不存在**。

**仍存在的风险**：同一个 PR 同时削弱四样东西：

- 声明；
- 显式表（删义务或改用途）；
- 冻结文件（基准、探测事实、recorded、覆盖台账）；
- 摘要。

四者都由同一 PR 生成并提交，测试全绿，只能靠评审看 diff。

**修法选项**：见 Q-B4，推荐 ②“削减登记”。

1. 新增只增不减的 `required/retired.ts`。每条记录：端点、被删或被弱化的项（义务键 / 事实键）、理由、PR 号。
2. 测试对比**合并基点**上的表与冻结文件：PR 的合并提交第一父 `HEAD^1`，CI 合并提交场景；本地用 `git merge-base origin/main HEAD`。
   - 被删或被弱化的项必须出现在本 PR 新增的 retired 记录里，否则报 `REDUCTION_UNREGISTERED`。
   - 已有 retired 记录被删，报 `RETIRED_REMOVED`。
   - “弱化”的定义：义务从准入改成披露 / 守卫内部 / 条件；`need` 被删；探测事实从 `deny` 变成 `none`；台账 / 拒绝码改变。
3. 取不到合并基点（浅克隆）报 `HISTORY_UNAVAILABLE`，不降级为通过。CI 需要 `fetch-depth: 2`，用单独的 `ci.yml` PR（AGENTS §3.7；分钟数几乎不变：多取一层提交）。
4. 端点删除（路由消失）同样要登记 retired，与表键完整性检查配合。

**作废登记**：§10.6 的 allowlist / 例外 / `OPEN_BATCHES` / 初始化批准 / 告警–强制模式整体作废，不实现。需要总编排确认（Q-B4），确认前不动 PR-A 设计文档的 §10.6。

**零行为影响**：只改测试与 CI 配置。

### B-12 声明接管运行时授权（T1～T4）：本期不做

- **PR-B 不接管运行时**：包装仍只做注册身份核对与自检；现有授权调用、查询过滤、裁剪全部保留。
- **接管会改变运行时**，至少包括：
  - PR-A 设计 C2 的“最小安全解析 → 鉴权 → 业务校验”顺序，部分坏请求体会从 400 变成 403 / 404；
  - 步骤 0 失败日志多记（§10.7）；
  - 统一出口兜底删除未声明键（Q3）。

  因此**必须由用户决定**（Q-B1），本设计不预设。
- **建议的分阶段方式**（若用户选择推进）：
  1. **前置条件**（逐模块）：该模块 Tier 1 组（B-09）全绿，探测事实冻结；B-01～B-07 全部合并。
  2. **T1 统一执行（直通适配器）**：先单独设计（PR-A 设计 §10.1 + §10.7 第 2 条），按模块逐个替换授权调用。保真测试 = 该模块 Tier 1 事实在接管前后逐字节一致；允许的差异逐路由写进接管 PR 描述，并经用户确认。
  3. T2（QuerySpec）/ T3（足迹守卫与重放）/ T4（统一出口投影，含 Q-B3 的路径登记）按 PR-A 设计 §10.2～10.4，各自先出设计。
- §10.7 三条提醒（现状保证与计划保证分列、T1 过渡适配、步骤 0 日志差异）原样留给 T 系列设计。

## 3. 测试与反例清单（汇总）

| 项 | 新增失败码 | 反例（必须报出） | 正例（必须零发现） | 所在测试文件（暂定，见 Q-B6） |
|---|---|---|---|---|
| B-01 | `DISCLOSURE_WEAK`、`OPTIONAL_POSITION`、`OPTIONAL_NESTED` | `canViewReporting` → any(HR, member)；按钮下沉嵌套 optional；`disclosure→any-member / nested / moved` 全部实例 | 33 个真实披露位置；经理入口；模型图共用 point | `AC-PRM-FW-02-disclosure.test.ts` |
| B-02 | （复用 `EVIDENCE_STALE`）、边界清单校验 | `levelOf` 恒返 detail；依赖集合增加；边界清单加模块内文件 | 改边界内 `AppError` 不触发 | `AC-PRM-FW-02-evidence.test.ts` |
| B-03 | `REQUIRED_NEED`、`NEED_UNBOUND` | 360 自动添加 point 换节点；IDP 删除三例；`scope→sibling` 全部实例；删 `need` | 20 条多承载端点 | 同 B-01 文件 |
| B-04 | — | 四项全同 → `TABLE_CONFLICT` | 同权限同用途不同调用点 | `AC-PRM-FW-02-evidence.test.ts` |
| B-05 | 覆盖断言 | 少生成一个备选的突变 → 覆盖失败 | 全部准入义务 × 备选（含“或”组）有突变 | `AC-PRM-FW-02-required.test.ts` |
| B-06 | （复用 B-01 规则） | 新分支的三类结构弱化、`disclosure→none / admission` | IDP 新分支数 = 枚举数 | `AC-PRM-FW-02-disclosure.test.ts` |
| B-07 | `MISMATCH:branchValue`、`BRANCH_VALUE_UNBOUND` | 人才表单六键全改指标库；job 两键对调；`selector→value` 全部实例；删分支值登记；改内联映射函数 | 全部真实选择器 | `AC-PRM-FW-02-evidence.test.ts` 或 `AC-PRM-FW-02.test.ts` |
| B-08 | `PROBE_ADMISSION_UNCLAIMED`、`PROBE_PURPOSE_MISMATCH`、`MISMATCH:invalidId`、`PROBE_ACTION_UNMAPPED`、`MISMATCH:branchValue(probe)`、`MISMATCH:denial` | Transfer.Hr 表项错登；`invalidId` 改码；删映射；分支值错 | 全部端点 Tier 0 | `AC-PRM-FW-08.probe.test.ts`（按模块拆） |
| B-09 | `OVERDECLARED:<perm>`、`MISMATCH:denial`、`MISMATCH:ledger`、`REPLAY_*`、`PROBE_SAMPLE_MISSING`、`WEAKER:scope` | 每组：`denied` 改宽、perItem→single、删样本、多写按钮 | 每组全部端点 Tier 1 | 每组一个文件 |
| B-10 | `RECORDED_UNREGISTERED`、`RECORDED_STALE`、`WEAKER/OVERDECLARED:precondition` | 同删 recorded 与声明前提；`recordFact` 写字面量；删证据用例 | 审批八动作、合同待办 | 随所在组 |
| B-11 | `REDUCTION_UNREGISTERED`、`RETIRED_REMOVED`、`HISTORY_UNAVAILABLE` | 删义务不登记；准入改披露不登记；删 retired；浅克隆 | 只增义务的 PR | `AC-PRM-FW-01-reduction.test.ts` |

公共要求：

- 先单独提交失败测试，再实现（AGENTS §3.2）。
- 测试内禁止 `skip / todo`。
- 每类弱化 / 突变按结构生成，**不经比较器筛选**；断言“生成数 = 报出数”，并输出实例清单。

## 4. 拆分为实现 PR

行数为不含生成文件的估算：生成文件包括 `digests.ts`、`baseline/**`、`probe/**`、`recorded.json`、`probe-coverage.json`。每个 PR 合并前都要合并最新 main；遇到新路由按 PR-A §六补声明、表与基准。

| PR | 内容 | 估算行数 | 依赖 | 并行 |
|---|---|---|---|---|
| **PR-B1 披露语义 + 范围绑定 + 覆盖 + R9 键** | B-01、B-03、B-04、B-05：`perms.ts`（分支析取范式、挂载位置、来源节点范围）、`required.ts`（D1 / D2、逐备选 R3、R1b / R1c）、`required/types.ts`（`need`）、`evidence.ts`（identity）、`required-mutate.ts`（备选位置、“或”组突变）、`weakenings.ts`（4 类新弱化）、表补 `need`（约 20 端点 / 45 义务）与审定台账、新测试文件 | 约 1000～1200 | 无 | 与 B2、B4 并行 |
| **PR-B2 证据依赖闭包 + 分支值绑定** | B-02、B-07：`evidence.ts` 闭包与 `DEPENDENCIES`、`evidence-boundary.ts`、`domains.ts` 分支值表（含内联映射证据）、`compare.ts` 逐值比较、`selector→value` 弱化、新测试文件；PR 描述附闭包规模实测 | 约 900～1100 | 无（与 B1 同改 `weakenings.ts`：B1 先合并则 B2 合并 main 后追加，冲突只在弱化目录数组） | 与 B1、B4 并行 |
| **PR-B3 IDP 嵌套披露拆分** | B-06：枚举展示器端点；`idp/policy.ts` 加 `nested.*` 分支；`required/idp.ts` 披露义务与证据；基准 / 摘要重生成 | 约 1000～1300 | B1（规则 D1 / D2 / 逐备选 R3） | 与 B2、B4 并行 |
| **PR-B4 授权替身 + Tier 0 + recorded 收集器** | B-08、B-10 框架：`stand-in.ts`、`probe-runner.ts`、`request-perms.ts`、`probe-check.ts`（P1～P5）、`recorded.ts`、Tier 0 冻结文件、`AC-PRM-FW-08.probe.*`；PR 描述附请求数与 CI 时长实测 | 约 1300～1500 | 无（P4 分支值复核依赖 B2 的分支值表：B2 未合并时 P4 只建框架，B2 合并后由 B4 或 B5 的首个 PR 打开） | 与 B1、B2、B3 并行 |
| **PR-B5a～B5h Tier 1（按模块组）** | B-09（及该组的 B-10 首批事实）：样本工厂 + 该组 FW-03～08 + 覆盖台账 + 真实授权器冒烟 | 每个约 1200～1600 | B4；B5a 是试点，合并后按实测重估其余组的拆分 | 组间可并行（各自独立文件；覆盖台账按组分文件） |
| ↳ B5a | 权限 43、租户设置 3、审计 4、头像 5、平台 8、`/healthz` 1（64 条，多为管理员能力，作试点） | | | |
| ↳ B5b | 组织 14、职务 14、编制 16、人员 18（62 条） | | | |
| ↳ B5c | 任职 46、自助 7（53 条） | | | |
| ↳ B5d | 合同 23（含待办批量 perItem、导入、继承正例） | | | |
| ↳ B5e | 审批 34（含八个任务动作前提与盲审 Outcome 的 recorded） | | B5c 或 B5d 的样本工厂（审批实例要靠任职 / 合同流程产生） | |
| ↳ B5f | 人才 40、准备度 5（45 条） | | | |
| ↳ B5g | 360 管理端 40、链接 9（49 条） | | | |
| ↳ B5h | IDP 57 | | B3 | |
| **PR-B6 削减登记**（Q-B4 选 ② 时） | B-11：`required/retired.ts`、基点比较、`AC-PRM-FW-01-reduction.test.ts` | 约 400～600 | B1～B4 合并后（冻结文件种类齐全） | — |
| **PR-B6-ci** | `ci.yml`：两个 job 的 checkout 加 `fetch-depth: 2`；单独 PR，说明分钟影响 | 约 5 | 先于 PR-B6 合并 | — |

- **顺序建议**：B1、B2、B4 同时开 → B3（B1 后）→ B5a 试点（B4 后）→ 按试点实测重排 B5b～B5h → B6-ci → B6。
- **Sonnet 实现要点**（DEC-338①）：
  - 每个 PR 的规则、失败码、反例都已在 §2 / §3 写定，按“先失败测试、再实现”推进。
  - 同类 P2 连续两轮没修好，换 Opus 接手（AGENTS §3.8）。
  - 表的审定（B1 的 `need`、B3 的嵌套披露）必须逐条读源码，台账贴 PR 评论。
- **不拆的理由**：B1 的四项共用 `perms.ts` / `required.ts` 的同一数据结构（来源节点、备选），拆开会让第二个 PR 立刻冲突；B2 的两项都是“源码事实 + 证据摘要”同一机制。

## 5. 口径清单（不确定的写成待定 + 选项；均为复刻系统）

| 编号 | 问题 | 选项（作用对象：复刻系统） | 推荐 | 谁定 |
|---|---|---|---|---|
| **Q-B1** | 声明接管运行时授权（T1～T4）是否在本期推进、何时开始 | ① 本期不做，PR-B 全部合并后再议（推荐）；② PR-B 合并后立即开 T1 设计，以一个模块试点；③ 与 PR-B 并行开 T1 设计 | ① 理由：接管改变运行时（错误码顺序、日志、出口兜底），需要 Tier 1 保真事实作前提；R3 主线优先（DEC-297） | **用户**（改变运行时授权） |
| **Q-B2** | Tier 1（B5a～B5h，约 8 个 PR、合计约 1 万行）是否全部纳入本期 | ① 全部纳入，PR-B 以 8 组全绿收尾；② 本期只做 B5a 试点，其余组作为各模块接管（T1）的前置条件，接管该模块时补（推荐）；③ 本期做试点 + 高风险组（审批 B5e、任职 B5c、IDP B5h），其余随接管 | ② 理由：Tier 0 已覆盖全部端点在加载前的授权语义；Tier 1 主要服务接管保真，接管未定前全量投入回报低 | 总编排（成本 / 排期）；若影响 R3 排期则问用户 |
| **Q-B3** | 嵌套字段路径（FW-04）的声明侧登记 | ① 本期只冻结为探测事实（现状防回退），声明的形状路径登记随 T4 投影接管（推荐）；② 本期就给每个投影器登记路径，比较器做“声明路径 ⊇ 观测路径” | ① 理由：PR-A 的形状只有名字，没有路径；补路径等于提前做 T4 的一半，而声明在接管前不参与运行时 | 总编排 |
| **Q-B4** | 可信基线协议 | ① 作废 §10.6，不另设机制，只靠评审看 diff；② 作废 §10.6，改为“削减登记”（retired 只增，基点比较，需 `fetch-depth: 2` 的 ci PR，推荐）；③ 保留 §10.6 的完整 DEC 批准链，适配到表与冻结文件（每次削减先登记 DEC） | ② 理由：DEC-303 后免声明通道已不存在；剩下的风险是同 PR 同步削弱，② 让削弱必须显式写出并被审查看到，成本低；③ 每次补登都要先走纯文档 DEC PR，在途 PR 节奏过慢 | 总编排（作废 §10.6 需确认；与 DEC-291 Q5 / Q6、流程① 的关系一并登记） |
| **Q-B5** | PR-A 设计 §4.8“查看人 × 接口 × 字段”矩阵（DEC-285⑤）是否仍作为人读产物 | ① 由探测事实生成每模块一张矩阵（markdown，生成文件，随 B5x 提交）；② 不再单独产出，探测事实 JSON 即为依据（推荐）；③ 只给高风险组（审批 / 任职 / IDP）生成 | ② 理由：替身方案不再用 H / A / O 等真实身份模板，矩阵的列失去对应；事实文件可读、可 diff | 总编排 |
| **Q-B6** | FW-03～08 测试文件命名（依赖 #102 多段编号扩展，DEC-297① 搁置中） | ① 每组一个文件 `AC-PRM-FW-03-08.<组>.test.ts`，内部 `describe('AC-PRM-FW-03 …')`；② 每个 FW 编号一个文件、组内用 `describe` 分组（`AC-PRM-FW-03.test.ts` …）；③ `AC-PRM-FW-T1.<组>.test.ts`，AC 编号只在 `describe` | ① 理由：按组分文件利于 CI 分片和并行开发；编号前缀保留 FW-03～08 便于 #102 恢复后采集 | 总编排 |

**本设计已定（审查可否决）**：

- C-B1：PR-B 全体零行为变化（§1.2）。
- C-B2：可选分支只允许挂在根节点、不得嵌套（B-01 D1 / D2）。现状 33 / 33 满足；未来确需挂在分支上，另行设计。
- C-B3：单维探测用授权替身，不用真实身份模板推导单维事实；真实授权器只做冒烟一致性（B-09 第 5 点）。
- C-B4：Tier 0 / Tier 1 事实与 recorded 都是生成后冻结、逐字节比较；更新只能通过重新生成并随 PR 评审。
- C-B5：证据闭包的边界清单只允许授权引擎与通用基础设施，不允许模块内辅助函数。

## 6. 与在途 PR 的关系

- PR-B 各实现 PR 合并后，新规则自动约束在途 PR 的新增路由：
  - 披露分支只能挂根节点；
  - 多承载节点要写 `need`；
  - `map` 选择器要有分支值表；
  - Tier 0 映射表要能识别新动作。

  补登流程在 PR-A §六之后追加这些步骤，由 PR-B1 / B2 / B4 各自更新 PR-A 设计文首的“在途 PR 如何补声明”段。
- 本设计 PR 只有文档，不影响在途 PR。

## 7. 恢复点（设计阶段）

- 本文件 + Draft PR 描述；无代码、无迁移。
- 下一步：
  1. 审查合并窗口发起设计审（GPT-6 Astra Ultra）；
  2. 设计通过后由总编排确认拆分与 Q-B1～Q-B6；
  3. 按 §4 派发 Sonnet 实现。
