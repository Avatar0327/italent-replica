# F-039 权限框架强制 PR-B：设计与拆分 v4

> 任务：F-039 PR-B（C 档，设计先行 DEC-249 / 285③；DEC-338①：设计与拆分由 Opus 做，实现拆小交 Sonnet，审查由 Codex 做）
> 分支：`claude/F-039-pr-b-design`（基于 main e2e2979，PR-A #110 已合并为 6bf3b13）｜状态：**只交设计，未写代码**
> 依据：DEC-285①、DEC-291、DEC-297④、DEC-300、DEC-303、DEC-317②、DEC-333、DEC-338、DEC-348②、DEC-351、DEC-356、DEC-359；PR-A 设计 `docs/08_设计/F-039_权限框架强制_设计.md`（下称“PR-A 设计”）
> 输入：
> - PR #110 描述 §七“PR-B 待办”与“第 5 轮止损转入项”6 项；
> - #110 审查原文：设计审第 6 轮（#issuecomment-6051601031）、实现审第 1～4 轮（6074970833、6076506504、6077749331、6080378392）、修法说明复审（6078712761）与确认（6078713272）、两次补登窄审（6080892877、6081336908）；
> - PR-A 设计 §4.4～4.8、§8、§10.6、§10.7。
>
> **v2**：依据 #152 设计审第 1 轮（GPT-6 Astra Ultra，#issuecomment-6082204948）与修订清单（6082206765）修订，8 项 P2 与 6 项 P3 逐条对应见附录 A。
> **v3**：依据第 2 轮设计审（GPT-6.1 Sol xhigh，#issuecomment-6082731657）与修订清单（6082732377）修订 B-08 探测的 2 类 P2 与 2 项 P3；口径按 DEC-356、DEC-359 定稿（§5）。对照见附录 B。
> **v4**：依据第 3 轮设计审（#152 审查原文，head 9b0c443）修订 1 类 P2（守卫内部权限的内部角色）与 1 项 P3（规范化保留固定业务值）。对照见附录 C。
> **DEC-362**：第 4 轮剩余同类 P2 按通过处理，修法写入 §8“实现约束”，作为 B4b 的硬约束。

## 0. 一页摘要

- **PR-B 的定位**：把 PR-A 的“声明门禁”从**结构比对**补到**语义比对**，全程**零行为变化**。
  - 改动只落在 `tests/acceptance/**`，以及各模块 `policy.ts` 的声明登记（IDP 嵌套披露拆分）。
  - 处理函数、授权调用、查询过滤、响应裁剪一律不动。
- **校验链**：运行时行为 ⇄ 显式表 ⇄ 声明。
  - 显式表与声明之间是静态规则（B-01～B-07）。
  - 运行时与显式表之间是授权替身探测（B-08 / B-09）。探测按**显式表的准入备选**建最小成功对照，不读声明；显式表本身是逐条读源码审定的，同样不来自声明。
- **十二项**：
  - **B-01～B-05**：PR-A 转入的门禁漏报。
    - 披露分支按自身析取范式逐备选比较；
    - 证据依赖闭包；
    - 准入与披露义务的范围都绑定到提供权限的节点（`need` 纳入“或”满足关系）；
    - R9 去重键加调用点；
    - 突变覆盖按备选位置。
  - **B-06**：IDP 嵌套内容逐对象拆成披露分支，同权“准入 + 披露”复用由修订后的 R2 支持。
  - **B-07**：动态选择器绑定“端点 + 选择器位置 + 输入来源 + 域 + 映射值”。
  - **B-08**：授权替身。全允许只用来**发现**授权请求；验证一律在“显式表的某个准入备选”的最小授权下做 `only-branch / missing-branch` 和备选内单维撤权。
    - 撤权期望按该权限在所选备选中的**全部用途**决定；同一权限兼作准入时验证拒绝。
    - 守卫内部的权限再按其**内部角色**（必需 / 内部“或”备选 / 内部条件）与样本实际满足的内部分支决定；承载者必需，不推出其内部每个权限都必需。
    - 每项检查先判**适用 / 未达**：验参或加载失败没有触达授权点的，不算验证，记入覆盖台账交 Tier 1。
  - **B-09**：Tier 1 成功对照样本。
    - 每个探针用独立样本；
    - 台账按本次实际新增并提交的命令计；
    - **必测场景集合独立于探测轨迹**（恢复 PR-A 设计 §4.4 / 4.5 的必测反例），执行集合与必测集合双向核对。
  - **B-10**：recorded 事实的双向闭环。
  - **B-11**：作废 PR-A 设计 §10.6，改为“削减登记”（DEC-356④）。规范化内容的削减与内容变更都要登记，不只删除。
  - **B-12**：声明接管运行时授权由“F-039 开发 接管 T1 设计”会话另出设计（DEC-356①），本 PR 只保留路线说明。
- **会改变运行时授权的项：无。** 接管（B-12）与统一范围 helper（DEC-317②，DEC-359 定为 T2 再做）都会改变运行时，不在本设计实现，见 §5 Q-B1 / Q-B7。
- **拆分（§4）**：
  - 静态门禁 3 个：PR-B1 披露语义与范围绑定、PR-B2 证据闭包与选择器绑定、PR-B3 IDP 嵌套披露。
  - 探测框架 2 个：PR-B4a 授权替身与发现探测、PR-B4b 按备选的最小对照。
  - Tier 1 按模块组 8 个：PR-B5a～B5h，B5a 为试点，含 OR、已提交 403、逐项回执三个框架试点。
  - 治理 2 个：PR-B6-ci、PR-B6。
  - 每个约 900～1600 行（不含生成文件）。
- **口径（§5）**：Q-B1～Q-B6 按 DEC-356 定稿，Q-B7 按 DEC-359 定稿。均为**复刻系统**口径，不涉及北森测试租户。§5 列出定稿方案下**本期不交付的验收**。

## 1. 范围与零行为变化边界

### 1.1 来源 → 编号

| 编号 | 来源 | 级别 |
|---|---|---|
| B-01 | 转入项 1：披露分支丢失 OR 与嵌套 optional 语义，33 个披露位置（6080378392 二-1） | P2 |
| B-02 | 转入项 2：证据摘要没覆盖决定授权实参的实现，360 `levelOf`（6080378392 二-2） | P2 |
| B-03 | 转入项 3：范围要求没有绑定到提供对应权限的节点（6080378392 二-3） | P2 |
| B-04 | 转入项 4：R9 去重键没有调用点 | P3 |
| B-05 | 转入项 5：突变覆盖断言不记备选位置、排除“或”组 | P3 |
| B-06 | 转入项 6：IDP 嵌套内容（`projectionOf`）没有按对象拆成披露分支 | P2 |
| B-07 | 实现审第 2 轮能力边界：“输入分支 → 对象 / 操作”对应关系（6076506504） | 限定版能力缺口 |
| B-08 | 设计审第 6 轮 P2-2：多维身份变化被误判成单维事实（6051601031） | P2（转入） |
| B-09 | PR-A 设计 §10.6“基准测不到的突变”、过度声明方向、FW-03～08 | 转入 |
| B-10 | 设计审第 6 轮 P2-3：recorded 事实防同步删减没有闭环 | P2（转入） |
| B-11 | PR-A 设计 §10.6 可信基线 / 例外 / retired / `OPEN_BATCHES` / 初始化批准 / 门禁协议 | 转入 |
| B-12 | PR-A 设计 §10.1～10.5“接管 PR 系列 T1～T4”与 §10.7 提醒；DEC-317②统一范围 helper | 路线 |

### 1.2 零行为变化边界（PR-B 全体）

| 允许改动 | 不允许改动 |
|---|---|
| `tests/acceptance/**`：比较器、显式表、突变、证据、探测器、样本、冻结文件 | 任何处理函数、授权辅助函数、查询过滤、响应裁剪 |
| `apps/api/src/**/policy.ts` 与 `app-policy.ts`：声明登记的增补与改正（B-06；审定中发现的登记错误） | `apps/api/src/route-policy/*` 的运行时行为（包装仍只做注册身份核对与自检） |
| 测试代码以相对路径**只读引用**产品内部导出（先例 `domains.ts` 引用 `approval/adapters.ts`）；B-08 用 `module-access.ts` 的 `registerScopeProvider` 给替身登记提供器 | 产品代码 import 测试代码；新增产品导出（确需时走契约 PR） |

**判定方法**（每个实现 PR 的自检必做）：

- `git diff origin/main -- apps packages` 只出现 `policy.ts` / `app-policy.ts`；
- FW 全绿；
- 相关模块既有验收测试全绿。

### 1.3 现状实测（本设计用只读脚本枚举 387 条声明，脚本不入库）

| 事实 | 数量 | 用处 |
|---|---|---|
| 可选分支 | 33 个，**全部挂在根节点**，无嵌套、无 `kind: 'any'` | B-01 结构约束对现状零改动 |
| 某准入备选含 ≥2 个承载节点（`object` / `admin`）的端点 | 20 条，其中 15 条带范围 | B-03 `need` 工作量 |
| `map` 型动态选择器（`param` / `body` / `query`） | 29 个，分布在 22 条端点 | B-07 输入来源登记工作量 |

## 2. 逐项设计

### B-01 披露分支：逐备选比较，同权不同用途的 R2

**现状漏洞**：`perms.ts` 的 `branchPerms` 把可选分支所有节点的键递归取并集；R3 只查“同名分支里有这个键”。`any([HR 按钮, 普通成员])`、或把按钮下沉进嵌套 optional，都仍被视为“授予了”。

**修法**

1. `perms.ts`：`declaredPerms().optional` 改为“名字 → 该分支**自身**析取范式的备选列表”，不含分支内的嵌套 optional；同时返回挂载位置与每个权限的来源节点。
2. 结构规则（`required.ts`，在 R3 之前执行）：

   | 规则 | 内容 | 失败码 |
   |---|---|---|
   | D1 | 可选分支只能挂在声明根节点 | `OPTIONAL_POSITION` |
   | D2 | 可选分支内不得再有 optional | `OPTIONAL_NESTED` |
   | D3 | 可选分支名只用 `^[A-Za-z][A-Za-z0-9]*$`。现有节点路径按点号切分（`required-mutate.ts` `locate`），名字里带点会找错分支；B-06 的嵌套分支因此命名为 `nestedSubProcess` 这类驼峰形式 | `OPTIONAL_NAME` |

   B1 同时把 `locate` 的分支名匹配改为按 D3 的字符集解析，并加一个“名字含点 → 报错而不是错位”的夹具。
3. **R3 逐备选**：披露义务 `disclosure:<名>` 要求同名分支的**每个**备选都含该权限。
   - 有一个备选不含，报 `DISCLOSURE_WEAK`，并指出第几个备选；
   - 分支不存在仍报 `DISCLOSURE_MISSING`。
   - 披露义务的“或”组语义同准入：同一备选内 AND，备选之间 OR。现表没有这种义务，规则写全。
4. **R2 修订：同权不同用途**（审查 P2-1）。现规则是“准入权限出现在任何 optional 就报错”，会拒绝 IDP 复制入口的真实复用：同一模板模块查看权既是准入，又决定模块是否披露。改为：
   - 准入义务的权限 p 出现在可选分支 X 里：只有当表里**同时**有 `disclosure:X` 且权限同为 p 的义务时才允许；否则报 `REQUIRED_IN_OPTIONAL`。
   - 这一放宽不削弱准入：R1 仍要求 p 出现在**每个准入备选**里。“删掉准入、只剩 optional”一定报 `REQUIRED_MISSING`。
5. R7（表外权限）对分支各备选的并集检查，语义不变。

**零行为影响**：只改测试支持代码。

**测试与反例**（新文件 `AC-PRM-FW-02-disclosure.test.ts`）

- 真实声明零发现（33 个位置）。
- 审查原文两例：
  - `canViewReporting` → `any([HR 按钮, member])`，报 `DISCLOSURE_WEAK`；
  - 按钮下沉嵌套 optional，报 `OPTIONAL_NESTED` 与 `DISCLOSURE_MISSING`。
- 新结构弱化（`weakenings.ts`，按声明结构与表的披露义务生成，不经比较器筛选；断言“生成数 = 报出数”）：

  | 弱化 | 期望 |
  |---|---|
  | `disclosure→any-member` | `DISCLOSURE_WEAK` |
  | `disclosure→nested` | `OPTIONAL_NESTED` |
  | `disclosure→moved`（挂到 `of[i]`，无 `of` 的端点不生成） | `OPTIONAL_POSITION` |

- R2 修订的正反例：
  - IDP 复制入口（B-06 加 `nestedTemplateModule` 后）零发现；
  - 同一端点删掉准入里的模板模块查看、只留在 optional，报 `REQUIRED_MISSING`；
  - 夹具中把某准入权限放进**没有**对应披露义务的分支，报 `REQUIRED_IN_OPTIONAL`；
  - PR-A 的 `required→optional` 突变（挪进 `moved0`）全部仍报出。
- 回归：`disclosure→none`、`disclosure→admission`、经理入口、模型图共用 point，结果不变。

### B-02 证据依赖闭包

**现状漏洞**：证据单元只登记调用点、实现、常量**本身**的摘要；实现内部再调用、决定实参的函数（360 `routeNeed → levelOf`）改动时不报。

**修法**

1. 每个证据单元 U 求依赖闭包 D(U)。从 U 的文本出发逐层解析标识符：
   - 同文件顶层函数 / 常量；
   - 相对 import 指向的 `apps/api/src/**` 导出；
   - `@italent/domain` 导出解析到 `packages/domain/src/**` 的声明。

   不解析的：注入依赖（`deps.*`、形参）、纯类型、边界清单内的文件。
2. **不设固定深度，算到不动点**（审查 P3）：带环检测，安全上限 12 层。
   - 触到上限、或遇到解析不了的标识符（动态属性访问、计算 import），都写进闭包报告的 `unresolved`；
   - `unresolved` 中只要有一项位于 `apps/api/src/modules/**` 而且不在边界清单里，就报 `EVIDENCE_CLOSURE_UNRESOLVED`。
   - 测试输出每个单元的闭包大小、最大深度、`unresolved` 数，供 PR 描述引用。
3. **边界清单** `evidence-boundary.ts`：只放授权引擎与通用基础设施（如 `errors.ts`、`modules/permission/authorizer.ts`、`commands.ts`、`@italent/db`），每条写理由。模块内辅助函数不得进入：测试断言除 `modules/permission/*` 以外，不允许出现 `modules/<模块>/` 下的文件。
4. `required/digests.ts` 新增 `DEPENDENCIES` 段（单元 → { 依赖单元 → 摘要 }），由 `ROUTE_POLICY_UPDATE_DIGESTS=1` 一并生成（生成文件）。依赖摘要变化或依赖集合增减，报 `EVIDENCE_STALE`，明细写依赖链与受影响义务。
5. **噪声上限**：PR-B2 实测单个依赖牵连的义务数分布，写进 PR 描述。超过 100 条的非引擎依赖列出由审查裁定，不自行加进边界。

**测试与反例**（新文件 `AC-PRM-FW-02-evidence.test.ts`）

- `levelOf` 恒返 `'detail'`，报 `EVIDENCE_STALE`。
- `routeNeed` 新增调用同文件函数（依赖增加），报 `EVIDENCE_STALE`。
- 构造一个 `modules/` 下的计算属性访问，报 `EVIDENCE_CLOSURE_UNRESOLVED`。
- 改边界内的 `AppError`，不触发；边界清单加模块内文件，测试失败。
- 回归：三端改动仍报 `EVIDENCE_STALE`，锚点改错仍报 `EVIDENCE_ANCHOR`。

### B-03 准入与披露义务的范围绑定（`need`）

**现状漏洞**：比较器按备选判断“有没有 point”，同一备选里主对象的 point 挪给子对象仍通过；披露分支的独立范围删掉也不报（审查 P2-3，`GET /idp/plans/:id` 带教信息逐行范围）。

**修法**

1. 义务新增 `need?: { scope: 'point' | 'list' | 'see-all' | 'guard' | 'none'; locator?: string; predicate?: string }`。
   - 证据：`need.scope ≠ 'none'` 的义务必须在 `at` 里有一条 `role: 'scope'` 的证据，指向强制范围判定处，例如 `employeeInScope`、`resolveModuleScope(…)` 加逐行过滤。
   - `scope` 是 `EvidenceRole` 的新取值。`evidence.ts` 对角色不做分支，B1 不必改它（`evidence.ts` 只归 B2 改，见 §4）。
   - 缺这条证据，报 `NEED_EVIDENCE_MISSING`。
2. **满足判定把权限与 `need` 合在一起**（审查 P2-2）：义务 o 在某个声明备选（或可选分支备选）里“成立”，当且仅当存在提供 `o.perm` 的来源节点，其范围满足 `o.need`。范围取该节点的 `scope` 字段，或 `byObject[编码 | '*']`；写了 `locator` / `predicate` 的，名字也要相等。
   - R1：无组准入义务在**每个**准入备选都成立；“或”组要求每个准入备选里**至少一个组内备选的全部义务**成立。`need` 只随所属组内备选参与，不会让另一支变成必需项。
   - 例：`GET /idp/approval-processes` 是 `view AND (create OR update)`。备选 `{view, create}` 只需满足组内备选 create（含其 `need`），备选 `{view, update}` 同理，互不要求。
   - R3（B-01）：披露义务在同名分支的**每个**备选都成立（权限 + `need`），否则报 `DISCLOSURE_WEAK`，明细写“范围不符”。
3. **必须写 `need` 的义务**：
   - R1c：某个声明备选含 ≥2 个承载节点时，由这些节点提供的每条 `obj:` / `admin:` 准入义务都要写 `need`（含 `none`），“或”组成员同样；缺了报 `NEED_UNBOUND`。现状 20 条端点、约 45 条义务。
   - R3c：**所有披露义务**都要写 `need`；缺了报 `DISCLOSURE_NEED_UNBOUND`。现有 33 个分支加上 B-06 新增的分支。
   - 单承载节点的准入备选沿用第二道比较的 `scopePoint`。
4. 表补 `need` 的审定台账随 PR 评论贴出，格式同 PR-A #issuecomment-6079923618。

**测试与反例**（`AC-PRM-FW-02-disclosure.test.ts` 内单列 describe）

- 审查原文例：
  - 360 自动添加评价者的 point 换节点，报 `REQUIRED_MISSING`（明细写“范围不符”）；
  - IDP 删除流程 / 模板 / 计划同样报 `REQUIRED_MISSING`。
- `GET /idp/approval-processes` 零发现。
- 结构弱化（生成数 = 报出数）：

  | 弱化 | 期望 |
  |---|---|
  | `scope→sibling`：含 ≥2 承载节点的备选里，交换每一对范围不同的节点 | `REQUIRED_MISSING`（范围不符） |
  | `disclosure-scope→none`：每个范围不是 `none` 的披露分支改成 `none` | `DISCLOSURE_WEAK`（范围不符） |
  | `disclosure-scope→wrong-predicate`：谓词 / 定位器换成同模块另一个已登记的名字 | 同上 |

- 删一条 `need`，报 `NEED_UNBOUND` / `DISCLOSURE_NEED_UNBOUND`；删 `role: 'scope'` 证据，报 `NEED_EVIDENCE_MISSING`。
- **局限**：`locator` / `predicate` 名字与源码的语义对应仍靠审定与证据锚点。范围敏感性本身由 B-09 的范围探针按对象核对（撤某对象范围后该段行消失）。

### B-04 R9 去重键加调用点

**修法**（归 PR-B2，`evidence.ts` 唯一责任 PR）：identity 改为 `perm | purpose | or | 排序后的 (call 单元, call 锚点) 列表`。

- **局限**（审查 P3）：call 单元是函数级。同一函数内两处锚点文本完全相同的判定无法区分；这种情况视为同一判定，按一条义务登记。
- 测试：
  - 同权同用途、不同 call 单元或不同锚点：不报；
  - 全部相同：报 `TABLE_CONFLICT`；
  - IDP 执行人入口“守卫内部 + 披露”的复用仍通过。

### B-05 突变覆盖：按“端点 + 权限 + 备选位置”，含“或”组

**修法**（`required-mutate.ts` 与覆盖断言，归 PR-B1）

1. 覆盖键 = `端点 | 权限 | 备选 i | 来源路径`。`required→none` 与 `required→optional` 都核对每条准入义务在每个提供它的声明备选上都有突变。
2. “或”组：对声明备选 i 与组 g，求 i 中成立的组内备选集合 S（按 B-03 的“权限 + need”判定）。
   - |S| = 1：对该组内备选的每个权限各生成 `or-member→none`，期望 `REQUIRED_MISSING`；
   - |S| > 1：生成 `or-group→none`，期望 `REQUIRED_MISSING`。
   - 覆盖断言要求每个（端点, 组, 备选）至少一个突变；|S| = 1 时组内每个权限都有。
3. **独立的覆盖集合**：期望集合由表的义务与声明备选直接推导，不从生成器输出反推。断言“期望集合 = 实际生成集合”，并输出“类 × 用途 × 端点”计数。

**测试**：

- 覆盖断言本身；
- 夹具中少生成一个备选的突变，覆盖断言失败；
- 人才候选编辑分支（update + 按钮 + 守卫）删任一项都报出。

### B-06 IDP 嵌套内容逐对象拆成披露分支

**修法**（只改声明登记与表；归 PR-B3，依赖 B1 的 D1～D3、R2 修订、R3 逐备选与 `need`）

1. 静态枚举闭包含 `processPresenter` / `templatePresenter` / `planProjections` 的端点，清单写进 PR 描述。粗估流程 5、模板 5、计划约 10 条。
2. 每条端点的声明根上，按嵌套对象各加一个可选分支，名称 `nested<对象键首字母大写>`（如 `nestedSubProcess`、`nestedTemplateModule`、`nestedTutorship`）。
   - 内容 = `object(IDP.<对象>, view, button none, scope …, fields none)`。
   - 范围：
     - 随主对象的写 `noScope('范围随主对象')`，`need.scope: 'none'`；
     - 关键信息（带教 / 职业 / 轮岗）与任职记录现状另解析范围、逐行过滤（`plan-view.ts` `planProjections` 与行过滤），登记为 `listScope('idp.keyInfoScope(<kind>)')` / `listScope('idp.employmentScope')`，`need.scope: 'list'` 加谓词名。
   - 名称与谓词在 PR-B3 审定时定稿。
3. **证据模板分三种**（审查 P3），不得统一要求不存在的字面量：

   | 来源 | call | impl | const |
   |---|---|---|---|
   | 展示器直接调用（流程 / 模板） | `routes.ts#processPresenter` / `#templatePresenter` 中 `projectionOf(deps, ctx, '<键>')` | `access.ts#objectFields` | `IDP_OBJECTS><键>` |
   | 计划投影（`PROJECTED` 数组） | `plan-view.ts#planProjections` 中 `PROJECTED.map(async (key) => [key, await projectionOf(deps, ctx, key)] as const)` | `access.ts#objectFields` | `plan-view.ts#PROJECTED`（锚点 `'<键>'`）+ `IDP_OBJECTS><键>` |
   | 任职记录直接授权、关键信息范围 | `planProjections` 中 `deps.authorize({ ...ctx, action: 'object.view', resource: record, fields: [] })` / `resolveModuleScope(deps, ctx, undefined, code, …)` | — | `MODULE_OBJECTS>employmentRecord` / `KEY_INFO_KINDS` |

   有范围的分支另加 `role: 'scope'` 证据，指向逐行过滤处。
4. 同权复用：例如复制入口的模板模块查看权已是准入，按 R2 修订登记 `disclosure:nestedTemplateModule` 后允许并存。基准里对应的对象 × 操作事实改由新披露义务承接（R8）。
5. 投影器 `idp.*` 的登记保留（出口形状）。

**测试**：

- B-01 的结构弱化、B-03 的 `disclosure-scope→none / wrong-predicate` 自动覆盖新分支；断言 IDP 新增分支数 = 枚举数。
- 审查原文例：`GET /idp/plans/:id` 的 `nestedTutorship` 改为 `none`，报 `DISCLOSURE_WEAK`（范围不符）。
- IDP 复制入口零发现；只留 optional，报 `REQUIRED_MISSING`。

### B-07 动态选择器绑定“端点 + 位置 + 输入来源 + 域 + 映射值”

**现状漏洞**：
- 比较器只核对键集合等于本路由绑定的域，不核对值：人才表单六键全改指标库，零发现。
- 也不核对输入来源（审查 P2-4）：`GET /talent/forms/:object` 的声明改成 `path: 'kind'` 或 `from: 'body'`，仍零发现。

**修法**（归 PR-B2）

1. **分支值表** `branchValues`（`domains.ts`）：域 → [{ 字段: `object | operation | button | relation`, 值: { 分支键 → 值 } }]。
   - 取值优先来自源码导出常量的运行时求值：`JOB_OBJECT_CODES`、`SUBSETS[k].objectCode`、`TALENT_OBJECTS[k].code`、`contractAction(op, mode)` 等。
   - 内联映射按字面量登记，每条带证据（单元 + 锚点 + 摘要，复用 `evidence.ts`）。
2. **输入来源表** `branchInputs`（新文件 `support/route-policy/branch-inputs.ts`，只放字面量）：`端点 → [{ 域, from, path, at: Evidence }]`。证据锚点指向实际取值处，如 `c.req.param('object')`、`body.operation`。同一域在不同端点可以有不同来源（job `:kind` 是路径参数，导入是 `body.kind`），所以按端点登记。现状 29 个 `map` 选择器、22 条端点。
3. `compare.ts` 的 `compareSelectors` 逐个 `map` 选择器（按节点路径 + 字段定位）核对五元组：

   | 不符之处 | 失败码 |
   |---|---|
   | `from` / `path` 与输入来源表不同 | `MISMATCH:branchInput` |
   | 该端点没有输入来源登记 | `BRANCH_INPUT_UNBOUND` |
   | 键集合不等于域 | 现有 `WEAKER:domain` / `MISMATCH:domain` |
   | 逐键值不等于分支值表 | `MISMATCH:branchValue` |
   | 该（域, 字段）没有分支值表 | `BRANCH_VALUE_UNBOUND` |

   `mapper` / `record` 选择器仍按值域集合相等。
4. 输入来源表的真实性由 PR-B4b 的 P4 动态核对：替身在登记的位置逐个放入分支值，轨迹里请求的资源要随之等于分支值表；换一个位置放值，资源要不变。
5. 新结构弱化（生成数 = 报出数）：

   | 弱化 | 期望 |
   |---|---|
   | `selector→value`：值全换成同域另一个合法值 | `MISMATCH:branchValue` |
   | `selector→path`：`path` 改成另一个参数名 | `MISMATCH:branchInput` |
   | `selector→from`：`from` 在 `param` / `body` / `query` 之间换 | `MISMATCH:branchInput` |

**测试**：

- 人才表单六键全改指标库，报 `MISMATCH:branchValue`；`path: 'object' → 'kind'` 与 `from: 'param' → 'body'`，报 `MISMATCH:branchInput`（审查原文例）。
- job 两键对调，报 `MISMATCH:branchValue`。
- 删一条输入来源 / 分支值登记，报 `*_UNBOUND`。
- 改内联映射或取值处所在函数，报 `EVIDENCE_STALE`。

### B-08 授权替身：发现探测与按备选的最小对照

**设计审第 6 轮 P2-2**：真实身份模板换用户时多个维度同时变化，推不出单维事实。

**#152 第 1 轮 P2-5**：v1 的“全允许后逐项撤权”会把合法“或”判成过度声明，例如 `GET /approval/types` 是管理员能力或对象查看，单撤管理员仍 200。全允许还会只走管理员分支，测不到对象分支的字段裁剪。

**授权替身**（PR-B4a，测试内；`createApp` 已支持注入 `authorize`，`module-access.ts` 已支持 `registerScopeProvider`）：

| 组成 | 行为 |
|---|---|
| `authorize(request)` | 按“授权集”回答：集内允许、集外拒绝（全允许模式下全部允许）；每次调用记录 `action`、`resource`、`fields`；事务内绑定版本（`authorizeInTransaction` 经 `provider.authorize`）同样回答、同样记录 |
| `provider.scope(query)` | 按配置返回 `all` / 空 / 指定组织；记录查询 |
| `provider.fields(…)` | 按配置返回全部 / 去掉某对象（或某字段）；记录查询 |
| 身份 | 一个真实租户成员；关系、本人绑定、成员资格等数据态维度不经授权器，由 Tier 1 样本处理 |

**请求 ↔ 权限键映射** `request-perms.ts`：

- `object.<op>` + 资源 → `obj:`；`object.button` + `buttonResource` → `btn:`；
- `admin.<能力>` 与 `tenant.*` 别名 → `admin:`。别名表取 `@italent/domain` 的 `MODULE_ACTIONS`（授权器用同一常量），不手抄。
- 映射不了的动作报 `PROBE_ACTION_UNMAPPED`。审计用的 `action` 字段不经授权器，不受影响。

**步骤一：发现探测**（PR-B4a，Tier 0，全部端点；全允许只用于发现，不下结论）

- 沿用 PR-A 边界探测的请求（占位路径参数，写请求体 `{}`），全允许，得到结果 O\* 与轨迹 T\*（规范化为集合）。
- 规则 P0：T\* 中的每个请求必须能映射到本端点表里某条义务的权限键（任意用途），否则报 `PROBE_ADMISSION_UNCLAIMED`。这条规则抓表漏登，例如 Transfer.Hr 错登成 Transfer.Manager。
- **非法标识**：有 UUID 参数的端点把第一个换成 `not-a-uuid`，全允许，得到观测码。规则 P3：观测码与根节点 `invalidId` 相等；没写但观测到 400 / 404 也报 `MISMATCH:invalidId`。

**步骤二：按准入备选的最小对照**（PR-B4b；Tier 0 用占位请求，Tier 1 用成功样本，算法相同，判定前都先过“适用 / 未达”）

1. **表备选与授权集**：
   - 由显式表求准入备选：无组准入义务全选，每个“或”组各选一个组内备选，取笛卡尔积。
   - 表备选 A 的**授权集** G(A) = A 的准入权限 ∪ 表里全部非准入用途（披露 / 守卫内部 / 条件准入）的权限；范围与字段全给，集外请求一律拒绝。
   - **隔离检查**（审查二-1 后半）：对每个“或”组 g 中**不属于** A 的组内备选 B，若 G(A) 已包含 B 的全部权限（因为这些权限另有非准入用途被补入），说明 A 的对照可能经 B 通过。此时追加变体 G⁻(A) = G(A) − (B 的权限 − A 的权限)：
     - G⁻(A) 的结果必须与 G(A) 同为成功（或同为 O\*），否则报 `PROBE_CONTROL_FAILED`，即 A 实际依赖 B 的权限，表登错了备选；
     - 两者输出只允许在 B 的权限所绑定的披露路径上不同，差异冻结为事实。
     - 没有任何 G⁻ 能把 B 排除（B 的权限全部兼作 A 的准入）时，该“或”组记 `PROBE_ALT_NOT_ISOLATED` 进覆盖台账，作为未达项，不算验证通过。
2. **适用 / 未达判定**（审查二-2）：
   - 每次运行，替身记录“被问到的请求”与“替身的回答”。某项检查只在其**前提请求被问到**时适用；否则记为未达，原因分三种：
     - `validation`：在授权前验参失败，轨迹为空或不含该请求；
     - `not-found`：加载失败；
     - `not-asked`：其他未问到。
   - 各检查的适用条件：

     | 检查 | 适用条件（全部满足） |
     |---|---|
     | `only-branch`（第 3 步） | 对照运行的轨迹含 A 的至少一个准入权限请求 |
     | `missing-branch`（第 4 步） | 对照运行的轨迹含组 g 某个组内备选的权限请求 |
     | P1（第 5 步）撤 p 期望拒绝 | 对照运行的轨迹含 p 的请求，且撤权运行中 p 确实被问到并被拒 |
     | P2（第 5 步）撤 p 期望成功并裁剪 | 对照运行结果为 2xx，且轨迹含 p 的请求 |
     | P5（第 7 步）拒绝码 | 来自一次适用的 P1 |
     | P0、P3（步骤一） | P0 只要求轨迹非空；P3 本身就是验参观测，总是适用 |

   - **归因**：撤权后结果变了，但被撤的请求在该次运行中根本没被问到，说明结果不稳定，报 `PROBE_UNSTABLE`，不当作“拒绝”。
   - 未达项写入覆盖台账 `baseline/probe-coverage.json`（端点 × 检查 × 权限 × 原因）。
     - 本期做 Tier 1 的组（B5a / B5c / B5d / B5e / B5h），其必测场景集合**必须包含**这些未达项，由成功样本补测；
     - 其余组的未达项列入 §5 的未交付清单。
     - 未达**不是**验证通过，统计里与“通过”分开计数。
3. **`only-branch`**：只给 G(A)，与 O\* 比较（比较口径见第 8 步）。不相等报 `PROBE_CONTROL_FAILED`，说明表漏登了某个必需授权，明细列出被拒的请求。
4. **`missing-branch`**：对每个“或”组，撤掉该组**全部**组内备选的准入权限，其余照 G(A) 给。结果必须变成拒绝，否则报 `PROBE_OR_NOT_REQUIRED`。被撤权限若另有非准入用途，撤掉的只是对它的回答，期望同样是拒绝。
5. **备选内单维撤权**：在 G(A) 内对每个被问到的权限 p 单独撤掉。期望由 p 在**备选 A 中的全部用途**决定（审查二-1 前半），按以下顺序取第一条匹配：

   | p 在 A 中的用途 | 撤权期望 | 不符时 |
   |---|---|---|
   | 含 A 的准入（含 A 选中的“或”组内备选），或守卫内部、承载者是 A 的准入且内部角色为**必需** | 拒绝；记录拒绝码 | `OVERDECLARED:<p>@<备选>` |
   | 守卫内部、内部角色为**内部“或”备选**，且样本满足的内部分支**含** p | 拒绝 | `OVERDECLARED:<p>@<备选>/<内部分支>` |
   | 守卫内部、内部角色为**内部“或”备选**，且样本满足的内部分支**不含** p | 准入结果不变；输出只允许在 p 的其他用途（如披露）绑定的路径上变化 | `GUARD_INNER_NOT_ALTERNATIVE`（说明 p 实际是必需项，表登错角色） |
   | 守卫内部、内部角色为**内部条件**，按条件成立 / 不成立 | 同下面两行条件准入 | 同下 |
   | 条件准入，且样本是条件成立的输入（Tier 1 登记） | 拒绝 | `OVERDECLARED:<p>@<备选>` |
   | 条件准入，且条件不成立（Tier 0 的 `{}` 或 Tier 1 条件不成立样本） | 结果不变 | `CONDITIONAL_AS_ADMISSION(probe)` |
   | 只有披露用途（纯披露） | 仍 2xx，且输出只在该披露分支绑定的路径上变少 | `PROBE_PURPOSE_MISMATCH` |

   - **同权复用**：如 IDP 模板复制的通用目标 / 模板模块查看权，既是继承内容准入，又决定披露。按第一行期望拒绝，处理函数现状返回 403 `IDP_COPY_HIDDEN_FIELDS`，验证通过，不报用途错误。
   - 这类权限的披露用途在撤权时被准入拒绝遮蔽，观察不到，覆盖台账记为 `disclosure-masked`（同权复用）。披露结构由 B-01 / B-03 的静态规则约束，不算探测未覆盖的缺陷。
   - **守卫内部角色**（第 3 轮审查 P2）：
     - **登记**：显式表新增 `inner` 字段（归 PR-B1 的 `required/types.ts`）。
       - 每条 `purpose: 'guard:<承载者>'` 的义务必须写：`{ role: 'required' }` / `{ role: 'or', group, alt }` / `{ role: 'when', condition }`，缺了报 `GUARD_ROLE_UNBOUND`。现表守卫内部义务 PR-A 台账计 45 条，逐条审定。
       - 内部“或”组还要登记**不经授权器的备选**，如参与人关系，写在 `GUARD_INNER_ALTS`：`承载者 → { group, alts: { 备选名 → 权限键列表 | 'data:<关系名>' } }`，并带证据。
       - 例：`idp.executor` 内部 = `hr: [obj:IDP.Idp:view]` 或 `participant: data:idp.planParticipant`。依据 `plan-access.ts` `requireExecutor`。
     - **样本**：带内部“或”组的端点，Tier 1 样本按内部分支各造一份，并登记 `satisfies: { <承载者>: <内部分支> }`；探针以此决定期望。例：执行人入口造“当前待办员工（参与人）”和“非参与人 HR”两份样本。
     - **内部 `missing-branch`**：只有权限构成的内部备选，撤掉其全部权限，同时让数据态备选不成立（用不满足它的那份样本），结果必须拒绝；否则报 `PROBE_OR_NOT_REQUIRED`。
     - **未达**：Tier 0 不知道请求满足哪个内部分支，内部“或”备选权限的单撤记 `未达(inner-branch-unknown)`。缺某内部分支的样本，记 `未达(inner-branch-unsampled)`，进覆盖台账。
     - **9 条同类端点**（审查列出）：能力候选 GET、目标增 / 改 / 删、任务增 / 改 / 删、review 写入、模块 content 写入。计划查看权的期望如下：

       | 样本 | 撤计划查看权的期望 |
       |---|---|
       | 参与人样本 | 准入不变（如新增目标仍 201），`responseView` 披露路径允许变化 |
       | 非参与人 HR 样本 | 拒绝 |
       | 两支都不满足（非参与人 + 撤查看权） | 拒绝（内部 `missing-branch`） |
6. **P4 输入来源与分支值**（依赖 PR-B2 的两张表；**PR-B4b 是唯一责任 PR**，合并顺序 B2 先于 B4b）：
   - 在 `branchInputs` 登记的位置逐个放入分支值，轨迹资源要等于 `branchValues`；
   - 不符报 `MISMATCH:branchValue(probe)` / `MISMATCH:branchInput(probe)`；
   - 适用条件：该分支值的运行轨迹含该选择器的判定请求，否则记未达。
7. **P5 拒绝码**：适用的 P1 得到的拒绝码，要与声明里提供该权限的节点自带的 `denied`（按钮策略、关系、本人）相等，否则报 `MISMATCH:denial`。
8. **结果比较口径**（审查 P3）：
   - **状态部分**：状态码、`error.code`、`details.reason` 必须相等。
   - **响应体**：只替换**样本间随机生成**的值，其余原样比较（第 3 轮审查 P3）：
     - **样本自造的标识**：工厂登记“角色 → 值”（如 `plan`、`employee:e1`、`org:A`），按角色名替换为 `<plan>`、`<employee:e1>`。不同员工、组织的引用因此仍可区分。
     - **本次请求新生成的标识**（响应里出现、不在样本登记里的 UUID）：按首次出现顺序替换为 `<new:1>`、`<new:2>`……
     - **时间**：探测用固定时钟（`AppDeps.clock`），服务端按时钟写的时间本就稳定。数据库默认值生成的时间戳，只对登记的系统时间字段名（如 `createdAt`、`updatedAt`、`occurredAt`）替换为 `<time>`。
     - **业务日期**（生效日期、截止日期等）与固定引用：保留原值。
     - `revision` / `etag`：保留原值。每个探针用新样本，起始值确定。
     - 数组保持顺序（排序是现状行为的一部分）。
     - 规范化后仍有不稳定值，冻结文件新鲜度会失败，按“不稳定值”在工厂里登记角色，不得扩大替换规则。
   - **备选自身允许的输出差异**：如管理员分支整对象、对象分支按字段权裁剪。只有路径属于 A 的出口策略差异时才允许，差异冻结为事实 `altDiff:<A> → [路径]`，由 Tier 1 的 FW-04 按备选逐路径核对。其他路径的差异报 `PROBE_CONTROL_FAILED`。
9. **`GET /approval/types` 回归**（审查原文 HTTP 实测）：
   - 表备选 {管理员}、{对象查看} 的 `only-branch` 都得 200，且对象分支走字段裁剪（差异进 `altDiff`）；
   - 两支都撤报拒绝；
   - 单撤管理员在备选 {管理员} 内报拒绝，不出现 `OVERDECLARED`。

**冻结**：

- 发现轨迹与各备选的观测冻结到 `baseline/probe/<模块>.json`（生成，逐字节比较，`ROUTE_POLICY_UPDATE_BASELINE=1` 重生成）；按模块分文件，便于分片与评审。
- 探测按显式表的备选走，表变化会让冻结文件变化，再由 B-11 的削减登记拦住同步削弱。

**CI 时长**：PR-B4a / B4b 实测请求数与耗时，写进 PR 描述。单文件超过 3 分钟就按模块拆，三分片分摊；PR-A 第 4 轮最慢分片 13 分钟，上限 25 分钟。

**测试与反例**（`AC-PRM-FW-08.probe.<模块>.test.ts` 等，命名见 Q-B6）：

- 冻结新鲜度；真实声明 + 表零发现。
- 表把 Transfer.Hr 错登成 Transfer.Manager，报 `PROBE_ADMISSION_UNCLAIMED`；表删一条必需准入，报 `PROBE_CONTROL_FAILED`；表多登一条不需要的准入，报 `OVERDECLARED`。
- 把“或”组拆成两条无组准入（误登），报 `OVERDECLARED`；`GET /approval/types` 按上文回归。
- 经理入口 `canViewReporting` 的义务改登准入：单撤后仍 2xx，报 `OVERDECLARED`。
- IDP 模板复制撤通用目标 / 模板模块查看权：期望拒绝，得 403 `IDP_COPY_HIDDEN_FIELDS`，零发现；同一权限若在表里只登成纯披露，报 `PROBE_PURPOSE_MISMATCH`（审查二-1）。
- `POST /api/tenant/idp/plans/<合法UUID>/goals`，请求体 `{}`：400 `VALIDATION_FAILED`，轨迹为空。P1 / P2 / `missing-branch` / P5 全部记“未达（validation）”，零发现，覆盖台账出现对应条目（审查二-2）。
- **当前执行人撤计划查看权仍成功**（第 3 轮审查正例）：参与人样本新增目标，撤 `obj:IDP.Idp:view`，替身确实问到并回答 false，结果仍 201，零发现；非参与人 HR 样本撤同一权限，报拒绝；把该义务的 `inner` 改登为 `required`，报 `OVERDECLARED`；把非参与人 HR 样本的 `satisfies` 误登为 `participant`（期望变成“准入不变”，实际拒绝），报 `GUARD_INNER_NOT_ALTERNATIVE`；删 `inner`，报 `GUARD_ROLE_UNBOUND`。
- 规范化：两份样本引用不同员工，规范化后仍不相等；业务生效日期不同，规范化后仍不相等。
- “或”组隔离：夹具里让 B 的权限兼作披露并补入 G(A)，生成 G⁻(A) 变体；把 A 的表项改成实际依赖 B，报 `PROBE_CONTROL_FAILED`。
- 撤权结果变了但被撤请求未被问到的夹具，报 `PROBE_UNSTABLE`。
- `invalidId` 改码，报 `MISMATCH:invalidId`；删映射，报 `PROBE_ACTION_UNMAPPED`。
- 替身自检：集外请求被拒；事务内授权同样记录、同样被拒。

### B-09 Tier 1：成功对照样本、必测场景集合与 FW-03～08

**样本与隔离**（审查 P2-6）

1. 样本工厂 `samples/<模块组>.ts`：每条端点的 `success(ctx)` 每次调用都**新造**一份独立样本，并返回请求。
   - 种子数据优先直接写库；必须经业务命令才成立的（审批实例、任职生效链）调用模块 API。
   - 工厂声明隔离级别：`object` 在同一租户内新建对象；`tenant` 每次新建租户，用于租户设置、流程配置这类全局状态。
2. **每个探针一份样本**，不复用。不论上一个探针返回什么，都可能已提交副作用，例如盲审返回 403 Outcome 前已转交任务、写审计并提交。探针前后各算一次 PR-A 设计 §4.6 的四组校验和，只用来断言、不用来决定是否复用。
3. **台账计数**：按“本次实际新增并提交的命令”计。
   - 样本登记逐项类别：`committed-2xx`、`committed-non2xx`（已提交的非 2xx Outcome，如盲审 403）、`rolled-back`（命令内抛错回滚，如过期 revision 409）、`precheck`（命令前拒绝）、`replay`（同键重放）。
   - 观测事实 = 台账增量 + 新增台账行的 `response_status` 多重集 + 外层状态码。
   - 期望：
     - single：成功时 +1；
     - perItem：+（`committed-2xx` + `committed-non2xx` 项数）；`rolled-back` / `precheck` / `replay` 不计。
     - 例：合同待办批量 `200 / 403 Outcome / 抛 409` 三项，期望 +2，状态多重集 {200, 403}，外层 200。
   - 不符报 `MISMATCH:ledger`。

**必测场景集合**（审查 P2-7；恢复 PR-A 设计 §4.4 / 4.5 的必测反例）

- **独立推导**：必测集合 `requiredScenarios(端点)` = f(显式表义务 ∪ 声明特征 ∪ 分支域 ∪ 输入来源表)，**不从探测轨迹推导**。
  - 场景清单沿用 PR-A 设计 §4.4 表格，含所有路由的边界场景、`object`、`scope.*`、`fields`、写路由重放、`ledger`、Outcome、`rows`、`failureAudit`、`self`、`own`、`relation`、`any` / `all`、`optional`、CSV、登记域每个值。
  - 授权维度用替身实现；身份、关系、绑定维度用真实数据。
- 每组 FW 文件的 `afterAll` 断言：执行集合 = 必测集合 − 带依据的 N/A。N/A 的依据须引用 `docs/` 或 DEC，并登记在覆盖台账；测试内禁止 `skip / todo`。
- **必须保留的具体反例**：

  | FW | 必须有的样本与断言 |
  |---|---|
  | FW-03 范围 | **分页敏感样本**：范围内、外的行混合，范围外的行按排序必在第一页；替身范围限定为范围内组织（不是全范围 / 空范围），`pageSize = 1` 首条是范围内行；`count` / `total` = 范围内条数；`hasDataPermission` 正确。point / guard：范围外样本得声明的 denied 且库不变。see-all：无看全部得 denied，有看全部为正例。空范围得 `items: []`。own：他人的行缺席 |
  | FW-04 字段 | 逐“对象 × 路径”：撤该对象探针字段后，该路径上字段缺席；未撤时出现，且值等于样本值。多对象形状的同名字段只在绑定对象上裁剪。写路由两类写探针：请求字段探针（非必填 X 不带，写成功，响应与后续读取 X 缺席）；派生 / 继承输出探针（Y 服务端写入，撤后响应缺席、未撤时等于预期值）。按备选分别做：管理员整对象 / 对象身份按字段权 |
  | FW-05 重放 | 成功后分别撤按钮、范围、字段，再同键同体重放，得声明的 denied；另一用户同键得 409 `IDEMPOTENCY_CONFLICT`；业务校验和与首次执行后一致；台账**内容哈希**不变、新增为 0；`result-guard` 撤范围后重放 404 且库不变 |
  | FW-06 关系 / 前提 | 非参与人 / 非当前审批人 / 非发起人得声明的 denied；审批八动作的命令内前提与盲审 Outcome 403 已提交（台账 +1 含 403、原任务 transferred、异常管理员新任务、审计与出站增量）；与回滚拒绝分开断言 |
  | FW-07 批量 / 导入 | 混入一行范围外、一行字段不可编辑：`atomic` 整体 denied 且业务校验和不变；`receipt` 该行回执失败、其余行成功、失败行对象单独读取前后一致；导入失败日志 1 条、逐行归属；台账按上节 |
  | FW-08 身份与租户 | 401、403 成员撤销、跨租户样本 id 得 denied、自助解绑 / 改绑、成员停用后的重放；Tier 0 的边界与非法标识 |

- 探针事实（拒绝码、字段路径、台账、范围结果）冻结到 `baseline/probe/<模块>.json`，与声明的比较规则同 B-08 的 P1～P5，另加：
  - `scope.denied` 与观测不等，报 `MISMATCH:denial`；
  - 声明 `scope: none` 但观测范围敏感，报 `WEAKER:scope`；
  - 台账不符，报 `MISMATCH:ledger`；
  - 缺样本且无依据，报 `PROBE_SAMPLE_MISSING`。
- **覆盖台账** `baseline/probe-coverage.json`（生成）：端点 → tier、N/A 依据、B-08 的未达项与 `disclosure-masked` 项。
  - 删样本或改 N/A 会使冻结文件变化，再由 B-11 登记。
  - 本组端点在 Tier 0 的未达项必须出现在本组的必测场景集合里并执行；仍未达的，报 `PROBE_SAMPLE_MISSING`。
- **真实授权器冒烟**：每组 3～5 条端点，用真实授权器 + 真实授予的最小权限用户，验证替身结论与真实授权器一致，防替身语义漂移。

**测试与反例**（每组）：

- 冻结新鲜度；真实声明零发现；必测集合 = 执行集合。
- 每组至少各一个：`denied` 改宽（404→200）报 `MISMATCH:denial`；删样本报覆盖变化；声明多写按钮报 `OVERDECLARED`。
- 合同组另做 perItem→single，报 `MISMATCH:ledger`；三项待办 `200 / 403 / 409` 期望 +2。
- 范围组另做“先分页后过滤”的内存模型（夹具路由），分页敏感样本报出，全范围 / 空范围样本报不出（证明样本必要）。

### B-10 recorded 事实的双向闭环

**修法**（收集器随 PR-B4a，首批事实随对应模块组）

1. 收集器 `recorded.ts`：`recordFact(端点, 类别, 观测)`，`观测` 只能由 `observe(res, snapshot)` 构造。`observe` 读 HTTP 响应与台账 / 审计快照，返回带品牌标记的类型。
   - 类别：`precondition:<名>`、`outcome`、`ledger`、`fixedKeys`。
   - **局限**（审查 P3）：品牌类型与“实参不是字面量”的检查都只是辅助，挡不住手工构造的伪响应。观测来源的最终保证仍是：证据用例里对同一响应有独立的 `expect` 断言，加上评审。
2. 冻结 `baseline/recorded.json`。证据用例与核对放在**同一个测试文件**（CI 三分片，跨文件收集不可靠），`afterAll` 双向核对：
   - 收集到未冻结，报 `RECORDED_UNREGISTERED`；
   - 冻结了未收集，报 `RECORDED_STALE`。
3. 与声明比较：`precondition:*` 与 `write.preconditions` 双向——前者有、后者无，报 `WEAKER:precondition`；后者有、前者与静态原语都没有，报 `OVERDECLARED:precondition`。
4. 首批事实：审批八动作前提与盲审 Outcome（B5e，试点一例在 B5a）、合同待办批量 perItem（B5d，试点一例在 B5a）、合同继承正例、固定键。

**反例**：

- 同删 recorded 事实与声明前提，报 `RECORDED_UNREGISTERED`；
- 删证据用例，报 `RECORDED_STALE`；
- `recordFact` 传字面量，类型检查失败。

### B-11 可信基线：削减登记（含内容变更；替代 PR-A 设计 §10.6，DEC-356④）

**事实**：§10.6 的协议对象是 `PENDING_B` / allowlist、有限例外、`OPEN_BATCHES`、初始化批准 DEC 与告警 / 强制门禁。

- DEC-303 取消了 `PENDING_B`，PR-A 已对全部端点完整声明，缺失声明始终致命。在途 PR 的做法是补声明 + 补表 + 重生成（#146、#144）。
- 因此第 5 轮 P2-② / P2-③ 针对的对象已不存在。**这不等于按原协议修复了**。旧协议的作废已由 DEC-356④ 确认；PR-A 设计 §10.6 的文首标注由 PR-B6 一并补（只加“已作废，见 DEC-356④ 与本设计 B-11”一行，不改正文）。

**仍存在的风险**：同一 PR 同步改错声明、显式表、冻结文件与摘要。例：360 自动添加评价者，同时交换两节点的范围和表里两条 `need`，所有规则都通过。若只做 B5a 试点，360 也没有 Tier 1 补查。

**修法**（DEC-356④“削减登记”；本设计把内容变更也算作需要登记的削减，不是 DEC 批准链）

1. **规范化内容**：对以下对象生成规范化 JSON（键排序）：
   - 显式表：每条义务的权限、用途、“或”归属、`need` 的范围 / 定位器 / 谓词、披露绑定的分支名、证据单元与锚点；
   - 冻结事实：基准、探测、recorded；
   - 覆盖台账：tier 与 N/A；
   - 分支值表、输入来源表；
   - 证据边界清单。
2. 与**合并基点**对比：CI 用合并提交的第一父 `HEAD^1`，本地用 `git merge-base origin/main HEAD`。
   - 除**纯新增**（新端点、新义务、新事实）外，任何**删除或内容变化**都必须在本 PR 新增的 `required/changes.ts`（只增不减）里登记：项键、前后内容摘要、理由、PR 号。否则报 `CHANGE_UNREGISTERED`。
   - 已有登记被删，报 `CHANGES_REMOVED`。
3. 取不到合并基点（浅克隆），报 `HISTORY_UNAVAILABLE`，不降级。CI 需要 `fetch-depth: 2`，单独开 `ci.yml` PR（AGENTS §3.7；分钟数几乎不变）。
4. 端点删除同样登记，与表键完整性检查配合。
5. **定位**：这是“削减与变更显式登记 + 评审”机制，让同步改动一定出现在 `changes.ts` diff 与审查视野里；它不证明改动正确，也不等价于原 DEC 批准链。

**反例**（`AC-PRM-FW-01-changes.test.ts`）：

- 360 自动添加同步交换声明范围与表 `need` 不登记，报 `CHANGE_UNREGISTERED`（审查原文例）。
- 准入改披露、删义务、`need.predicate` 改名、“或”归属改变、覆盖从 tier 1 改 N/A、探测事实从 deny 变 none，均需登记。
- 删已有登记，报 `CHANGES_REMOVED`；浅克隆报 `HISTORY_UNAVAILABLE`。
- 只增义务的 PR 零发现。

### B-12 声明接管运行时授权（T1～T4）与统一范围 helper：另行设计

- **DEC-356①**（用户选定）：声明接管运行时授权与 PR-B 并行设计，由“F-039 开发 接管 T1 设计”会话单独出。
  - 先选一个模块试点；
  - 凡改变运行时行为处（错误码顺序、日志、出口兜底）单独列出，交用户确认后才实现。
- 本 PR 保持零行为变化，只保留路线说明，以接管 T1 设计文档为准。该设计与本设计的接口：
  - **保真依据**：接管模块在接管前后，其 Tier 1 事实（B-09 冻结文件）与 recorded 事实逐字节一致；允许的差异逐路由写进接管 PR，并经用户确认。
  - **前置**：试点模块属于本期做 Tier 1 的组（B5a / B5c / B5d / B5e / B5h），或接管设计自带该模块的 Tier 1 样本。
  - **T2～T4**：按 PR-A 设计 §10.2～10.4，各自先出设计。T4 含 DEC-356③ 的形状路径登记。§10.7 三条提醒留给 T 系列。
- **DEC-317② 统一范围过滤 helper 与 CI 绕开检查**：抽 helper 要改所有候选 / 列表 / 详情接口的查询代码，属于处理函数改动，超出 PR-B 零行为边界。已定（DEC-359）：放到接管 T2 阶段再做，PR-B 不做；在此之前新接口仍复用 `requestScope` / `scopeSql`，审查照常检查。

## 3. 测试与反例清单（汇总）

| 项 | 新增失败码 | 必须报出的反例 | 必须零发现的正例 | 测试文件（暂定，Q-B6） |
|---|---|---|---|---|
| B-01 | `DISCLOSURE_WEAK`、`OPTIONAL_POSITION / NESTED / NAME`；R2 修订 | any(HR, member)；嵌套下沉；三类结构弱化；删准入只留 optional；无披露义务的分支含准入权限 | 33 个披露位置；IDP 复制入口复用 | `AC-PRM-FW-02-disclosure.test.ts` |
| B-02 | `EVIDENCE_CLOSURE_UNRESOLVED` | `levelOf` 恒返 detail；依赖增加；`modules/` 下的计算属性；边界加模块文件 | 改 `AppError` | `AC-PRM-FW-02-evidence.test.ts` |
| B-03 | `NEED_UNBOUND`、`DISCLOSURE_NEED_UNBOUND`、`NEED_EVIDENCE_MISSING` | 360 / IDP 三例换节点；`scope→sibling`；`disclosure-scope→none / wrong-predicate`；删 `need` / 范围证据 | `GET /idp/approval-processes`；20 条多承载端点 | `AC-PRM-FW-02-disclosure.test.ts` |
| B-04 | — | 全同报 `TABLE_CONFLICT` | 不同 call 单元 / 锚点 | `AC-PRM-FW-02-evidence.test.ts` |
| B-05 | 覆盖断言 | 少生成一个备选 | 期望集合 = 生成集合 | `AC-PRM-FW-02-required.test.ts` |
| B-06 | （复用） | `nestedTutorship` 范围改 `none` | 新分支数 = 枚举数 | `AC-PRM-FW-02-disclosure.test.ts` |
| B-07 | `MISMATCH:branchValue / branchInput`、`BRANCH_VALUE_UNBOUND / INPUT_UNBOUND` | 六键改指标库；`path` 改名；`from` 改；job 对调；删登记 | 29 个 `map` 选择器 | `AC-PRM-FW-02-evidence.test.ts` |
| B-08 | `PROBE_ADMISSION_UNCLAIMED / CONTROL_FAILED / OR_NOT_REQUIRED / PURPOSE_MISMATCH / ACTION_UNMAPPED / UNSTABLE / ALT_NOT_ISOLATED`、`GUARD_ROLE_UNBOUND`、`GUARD_INNER_NOT_ALTERNATIVE`、`OVERDECLARED:<p>@<备选>`、`CONDITIONAL_AS_ADMISSION(probe)`、`MISMATCH:invalidId / denial / branch*(probe)` | 表错登 / 漏登 / 多登；“或”误拆；同权项登成纯披露；隔离变体依赖 B；`invalidId` 改码；未问到却变了 | `GET /approval/types` 两支；IDP 复制同权复用 403；IDP goals `{}` 验参 400 全部记未达；IDP 执行人参与人样本撤计划查看权仍 201 | `AC-PRM-FW-08.probe.<模块>.test.ts` |
| B-09 | `MISMATCH:ledger / denial`、`WEAKER:scope`、`PROBE_SAMPLE_MISSING`、执行集合 ≠ 必测集合 | denied 改宽；perItem→single；删样本；多写按钮；先分页后过滤模型 | 每组全部端点；待办三项 +2 | 每组一个文件 |
| B-10 | `RECORDED_UNREGISTERED / STALE`、`WEAKER / OVERDECLARED:precondition` | 同删事实与前提；删证据用例；字面量 | 审批八动作、合同待办 | 随所在组 |
| B-11 | `CHANGE_UNREGISTERED`、`CHANGES_REMOVED`、`HISTORY_UNAVAILABLE` | 360 同步交换范围与 `need`；各类变更不登记 | 只增 | `AC-PRM-FW-01-changes.test.ts` |

公共要求：

- 先单独提交失败测试再实现（AGENTS §3.2）。
- 禁止 `skip / todo`。
- 弱化 / 突变按结构生成、不经比较器筛选，“生成数 = 报出数”并输出实例清单。
- 每个用例名保留准确 AC 编号（Q-B6）。

## 4. 拆分为实现 PR

不计行数的生成文件：`digests.ts`、`baseline/**`、`probe/**`、`recorded.json`、`probe-coverage.json`。每个 PR 合并前合并最新 main；遇到新路由按 PR-A §六补声明、表与基准，并按本设计的新规则补 `need`、输入来源、披露命名。

**文件归属**（避免并行冲突）：

| 文件 | 唯一负责的 PR |
|---|---|
| `perms.ts`、`required.ts`、`required/types.ts`、`required-mutate.ts` | B1 |
| `evidence.ts`、`evidence-boundary.ts`、`domains.ts`、`branch-inputs.ts`、`compare.ts` | B2 |
| `idp/policy.ts`、`required/idp.ts` | B3 |
| 替身、探测、`request-perms.ts`、`recorded.ts`、`probe-check.ts` | B4a / B4b |

`weakenings.ts` 由 B1、B2 各追加独立条目（冲突只在目录数组，后合并方合并 main 后追加）。

| PR | 内容 | 估算行数 | 依赖 | 并行 |
|---|---|---|---|---|
| **PR-B1 披露语义与范围绑定** | B-01、B-03、B-05：分支析取范式、D1～D3、R2 修订、R3 逐备选、`need` 与“或”满足、R1c / R3c、覆盖断言、`locate` 改造、结构弱化 5 类；表补 `need`（约 45 条准入 + 33 条披露）、守卫内部义务补 `inner`（约 45 条）与 `GUARD_INNER_ALTS`、`GUARD_ROLE_UNBOUND` 规则与审定台账 | 1400～1600 | 无 | 与 B2、B4a 并行 |
| **PR-B2 证据闭包与选择器绑定** | B-02、B-04、B-07：闭包到不动点、`unresolved`、边界清单、`DEPENDENCIES`、R9 键、分支值表、输入来源表（29 个选择器）、`compareSelectors` 五元组、弱化 3 类；PR 描述附闭包实测 | 1200～1500 | 无 | 与 B1、B4a 并行 |
| **PR-B3 IDP 嵌套披露** | B-06：端点枚举、`nested*` 分支、三种证据模板、范围与 `need`、基准 / 摘要重生成 | 1100～1400 | B1 | 与 B2、B4a 并行 |
| **PR-B4a 授权替身与发现探测** | B-08 替身、映射、发现探测、P0 / P3、recorded 收集器（B-10 框架）、Tier 0 冻结；PR 描述附请求数与耗时 | 1100～1300 | 无 | 与 B1～B3 并行 |
| **PR-B4b 按备选的最小对照** | B-08 步骤二：表备选与授权集、隔离变体、适用 / 未达判定与覆盖台账、`only-branch / missing-branch`、按全部用途的单维撤权、P4 / P5（P4 唯一责任 PR）、比较口径、`GET /approval/types` 与 IDP 两例回归 | 1200～1500 | B4a；B1（“或”组与 `need` 语义）；B2（P4 用到的两张表），合并顺序 B1、B2 先于 B4b | — |
| **PR-B5a Tier 1 试点** | 必测场景推导器、执行集合核对、样本隔离与台账计数框架、覆盖台账、真实授权器冒烟；权限 43 + 租户设置 3 + 审计 4 + 头像 5 + 平台 8 + `/healthz` 1 = 64 条；**三个框架试点**：“或”（`GET /approval/types`）、已提交 403（审批同意盲审）、逐项回执（合同待办批量），各自的样本工厂由 B5d / B5e 复用 | 1500～1700（超出则把三个试点拆成 B5a′） | B4b | — |
| **PR-B5b～B5h**（DEC-356②：本期做 B5c / B5d / B5e / B5h；B5b / B5f / B5g 列为待交付） | 每组：样本工厂 + 必测场景 + 探针事实 + recorded 首批；B5b 组织 / 职务 / 编制 / 人员 62；B5c 任职 + 自助 53；B5d 合同 23；B5e 审批 34；B5f 人才 + 准备度 45；B5g 360 49；B5h IDP 57 | 每个 1300～1700；B5a 合并后按实测重估 | B5a；B5e 依赖 B5c / B5d 的工厂；B5h 依赖 B3 | 组间并行 |
| **PR-B6-ci** | 两个 job 的 checkout 加 `fetch-depth: 2` | 约 5 | — | 先于 B6 |
| **PR-B6 削减登记** | B-11：规范化、基点对比、`changes.ts`、`AC-PRM-FW-01-changes.test.ts`；PR-A 设计 §10.6 文首加作废标注一行 | 500～700 | B1～B4b 合并后（冻结文件种类齐全）；B6-ci | — |

- **顺序**：B1 / B2 / B4a 同时开 → B3（B1 后）、B4b（B1、B2、B4a 后）→ B5a → B6-ci → B6，与 B5 其余组并行。
- **Sonnet 实现要点**（DEC-338①）：
  - 规则、失败码、反例已在 §2 / §3 写定，先失败测试再实现。
  - 表的审定（B1 的 `need`、B2 的输入来源、B3 的嵌套披露）逐条读源码，台账贴 PR 评论。
  - 同类 P2 连续两轮没修好，换 Opus（AGENTS §3.8）。

## 5. 口径清单（均为复刻系统；Q-B1～Q-B6 按 DEC-356、Q-B7 按 DEC-359 定稿）

| 编号 | 问题 | 定稿 / 状态 | 依据 |
|---|---|---|---|
| Q-B1 | 声明接管运行时授权 | **与 PR-B 并行另出设计**（“F-039 开发 接管 T1 设计”会话），先选一个模块试点，改变运行时行为处单独交用户确认；本 PR 零行为变化，只保留路线说明（B-12） | DEC-356①（用户选定） |
| Q-B2 | Tier 1 本期范围 | **B5a 试点 + 任职 B5c + 合同 B5d + 审批 B5e + IDP B5h**；其余组随接管补，列明待交付（下表） | DEC-356② |
| Q-B3 | 嵌套字段路径的声明侧登记 | **本期只冻结为探测事实，声明侧路径随 T4**；FW-04 的实际字段行为反例照做 | DEC-356③ |
| Q-B4 | 可信基线协议 | **作废 PR-A 设计 §10.6，改为“削减登记”**（B-11；只增登记、基点比较）；`ci.yml` 的 `fetch-depth: 2` 单独开 PR（PR-B6-ci） | DEC-356④ |
| Q-B5 | §4.8 查看人矩阵 | **只给高风险组（审批 / 任职 / IDP）生成**，至少保留“授权备选 × 接口 × 对象字段”的对应；由 B5c / B5e / B5h 从探测事实生成 | DEC-356⑤ |
| Q-B6 | FW-03～08 测试文件命名 | **每组一个文件 `AC-PRM-FW-03-08.<组>.test.ts`**，每个用例名保留准确的 AC 标识（`AC-PRM-FW-03` …），`03-08` 不是一个验收编号 | DEC-356⑥ |
| Q-B7 | DEC-317② 统一范围 helper 与 CI 绕开检查 | **已定（DEC-359）**：放到接管 T2 阶段再做，PR-B 不做；在那之前新接口仍复用 `requestScope` / `scopeSql`，审查照常检查 | DEC-359 |

**定稿方案下本期不交付的验收**（不能当作遗留已关闭）：

| 口径 | 本期不交付 | 何时交付 |
|---|---|---|
| Q-B2 | B5b（组织 14、职务 14、编制 16、人员 18）、B5f（人才 40、准备度 5）、B5g（360 管理端 40、链接 9）三组的 Tier 1。具体包括：FW-03～07 的成功路径场景、范围外拒绝码、字段路径事实、台账、关系 / 前提、过度声明方向；**FW-08 中依赖真实对象的场景**：跨租户对象 id、成员停用后重放、自助解绑 / 改绑（审查 P3）；以及这些组在 B-08 Tier 0 的全部未达项与 `disclosure-masked` 项。这三组本期只有 Tier 0（加载前授权语义、非法标识、中间件边界）、B-01～B-07 静态门禁与 B-11 削减登记 | 各模块接管前置，或总编排另行排期 |
| Q-B3 | 声明侧的形状路径登记，以及“声明路径 ⊇ 观测路径”比较；v6 突变“删一条嵌套路径 → `WEAKER:fields@p`”在声明侧不可做，由冻结的探测事实防回退 | T4 |
| Q-B5 | 非高风险组的矩阵（数据仍在探测 JSON） | 随需要生成 |
| Q-B1 / Q-B7 | 运行时接管、统一范围 helper、CI 绕开检查 | 接管 T1 设计 / T2 |

**本设计已定（审查可否决）**：

- C-B1：PR-B 全体零行为变化（§1.2）。
- C-B2：可选分支只挂根、不嵌套、名字不含点（D1～D3）。
- C-B3：单维事实只在显式表的准入备选内推导；全允许只用于发现；撤权期望按所选备选中的全部用途决定，守卫内部权限再按内部角色与样本满足的内部分支决定；未触达授权点的检查记未达、不算通过；真实授权器只做冒烟一致性。
- C-B4：探测事实、recorded、覆盖台账都是生成后冻结、逐字节比较，变化走 B-11 登记。
- C-B5：证据闭包边界只允许授权引擎与通用基础设施。
- C-B6：每个探针一份新样本；台账按实际新增并提交的命令计。

## 6. 与在途 PR 的关系

- PR-B 各实现 PR 合并后，新规则约束在途 PR 的新增路由：
  - 披露分支命名与位置；
  - 多承载节点与披露写 `need`；
  - `map` 选择器登记输入来源与分支值；
  - 授权动作可映射；
  - 规范化内容变化登记 `changes.ts`。
- B1 / B2 / B4a 各自在 PR-A 设计文首的“在途 PR 如何补声明”段追加对应步骤。
- 本设计 PR 只有文档。

## 7. 恢复点（设计阶段）

- 本文件 v4 + PR 描述；无代码、无迁移。
- 下一步：
  1. 审查合并窗口发起第 4 轮设计审；
  2. 总编排确认拆分；
  3. 按 §4 派发 Sonnet。

## 8. 实现约束（DEC-362：设计按通过处理，以下为 B4b 的硬约束，实现审时核对）

来源：#152 设计第 4 轮审查（GPT-6.1 Sol xhigh，#issuecomment-6083248937）剩余的同类 P2。DEC-362 定本设计按通过处理，不再开设计轮，修法写在这里，PR-B4b（及承接 IDP 的 PR-B5h）必须照做。

**背景**：`idp.executor` 内部是“HR 或 参与人”，但之后还要求当前待办节点（`plan-access.ts` `participation` / `requireExecutor`）。持有该节点的人必然已是参与人，所以“非参与人 HR”在执行入口上**造不出成功对照**。审查实测 9 个端点：

| 操作人 | 允许计划查看权 | 撤计划查看权 |
|---|---|---|
| 当前执行人 | 均成功 | 均成功 |
| 非参与人 HR | 均为 403 `IDP_NODE_BUTTON_DENIED` | 均为 404 `NOT_FOUND` |

**约束**

1. **登记**：`idp.executor` 的 9 个执行入口，其内部 HR 路径登记为**“不能独立成功的内部路径”**，在 `GUARD_INNER_ALTS` 的该备选上标 `standalone: false`，并附证据：节点按钮判定处。9 个入口是：
   - 能力候选 GET；
   - 目标新增 / 修改 / 删除；
   - 任务新增 / 修改 / 删除；
   - review 写入；
   - 模块 content 写入。

   这些入口：
   - 不为 HR 路径造“成功样本”；
   - B-08 步骤二第 5 点“内部‘或’备选且样本满足的内部分支含 p → 期望拒绝”这一行，对标了 `standalone: false` 的备选**不适用**，记 `未达(inner-branch-not-standalone)`，不算验证通过；
   - 当前执行人（参与人）样本的“撤计划查看权仍成功”照常验证。
2. **拒绝码转换单独测**：非参与人 HR 请求这 9 个入口，用专门的用例断言拒绝码转换：允许计划查看权时 403 `IDP_NODE_BUTTON_DENIED`，撤掉后 404 `NOT_FOUND`。
   - 结果冻结为事实 `denialShift:<端点> 403/IDP_NODE_BUTTON_DENIED → 404/NOT_FOUND`。
   - 这条**不计作成功准入的撤权证明**：P1 的适用条件补一条“对照运行结果必须是成功（Tier 1）或等于 O\*（Tier 0）”。对照本身已被拒绝时，P1 一律记未达，不能把“拒绝 → 另一种拒绝”算成撤权导致准入拒绝。
3. **能成功隔离的 HR 分支用计划详情验证**：计划详情 `GET /api/tenant/idp/plans/:id` 的 HR 分支可以独立成功。用非参与人 HR 样本验证：允许计划查看权时 200，撤掉后 404。这是 `idp.executor` 内部 HR 备选“权限必需”的成功准入撤权证明。
4. **推广**：其他守卫的内部备选，若同样被后续判定挡住、无法独立成功，按第 1 条标 `standalone: false`，并在 PR 描述列出；标注须有证据，实现审逐条核对。

**实现审核对项**：

- 9 个入口的 `standalone: false` 登记与证据；
- 403→404 用例与 `denialShift` 事实；
- P1 对照必须成功的适用条件；
- 计划详情 200→404 用例；
- 覆盖台账里 `inner-branch-not-standalone` 的条目数等于 9。

## 附录 A：v1 → v2 对照（#152 设计审第 1 轮，#issuecomment-6082204948）

| 审查项 | v2 修订 | 落点 |
|---|---|---|
| P2-1 IDP 同权准入 + 披露被 R2 拒绝 | R2 修订：准入权限出现在分支 X 时，须表有同权 `disclosure:X`；R1 保证删准入必红；补复制入口正反例 | B-01 第 4 点、B-06 第 4 点 |
| P2-2 R1b 破坏 OR 准入 | `need` 并入义务“成立”判定，随所属组内备选参与“或”满足；`GET /idp/approval-processes` 正例 | B-03 第 2 点 |
| P2-3 披露分支独立范围删除不报 | 所有披露义务写 `need`（R3c），R3 逐备选含范围；`disclosure-scope→none / wrong-predicate` 弱化；`nestedTutorship` 反例 | B-03、B-06 |
| P2-4 动态映射不核对输入来源 | 输入来源表 + 五元组比较；`selector→path / from` 弱化；P4 动态核对来源 | B-07、B-08 P4 |
| P2-5 全允许撤权误判 OR、漏测短路分支 | 全允许只做发现；按显式表准入备选做 `only-branch / missing-branch` 与备选内单维撤权；`GET /approval/types` 回归 | B-08 步骤二 |
| P2-6 写探针隔离与 perItem 计数 | 每探针一份新样本；台账按实际新增并提交的命令，区分 committed-2xx / committed-non2xx / rolled-back / precheck / replay；待办三项 +2 | B-09 样本与隔离 |
| P2-7 FW-03～07 必要反例缩减 | 必测场景集合独立推导（恢复 PR-A §4.4 / 4.5），执行集合核对；分页敏感样本、两类写探针、重放四类、atomic / receipt 混合行 | B-09 必测场景集合 |
| P2-8 削减登记漏 `need` 内容变化 | 改为“变更登记”：规范化内容任何删除或变化都要登记；360 同步交换反例 | B-11 |
| P3 深度 4 截断 | 算到不动点（上限 12），`unresolved` 报告与 `EVIDENCE_CLOSURE_UNRESOLVED` | B-02 第 2 点 |
| P3 `nested.<键>` 与点号路径解析 | D3 命名规则 `nestedSubProcess`、`locate` 改造与夹具 | B-01 D3 |
| P3 B-06 证据模板 | 三种模板（展示器 / `PROJECTED` / 直接授权与范围） | B-06 第 3 点 |
| P3 `evidence.ts` 双改、P4 责任、B5a 试点 | 文件归属表（`evidence.ts` 只归 B2，B-04 移入 B2，`need` 证据用新角色不改 `evidence.ts`）；P4 唯一责任 PR-B4b；B5a 加三个框架试点 | §4 |
| P3 `recordFact` 与 R9 局限 | 品牌类型 + 局限说明；R9 加锚点，同函数同锚点视为同一判定 | B-10、B-04 |
| P3 DEC-317② 去向 | 转 T2，新增 Q-B7 | B-12、§5 |
| 口径建议 | Q-B1 ①、Q-B2 ③ + B5d、Q-B3 ①、Q-B4 ②修正、Q-B5 ③、Q-B6 ①；列出未交付验收 | §5 |

## 附录 B：v2 → v3 对照（#152 设计审第 2 轮，#issuecomment-6082731657；DEC-356）

| 审查项 | v3 修订 | 落点 |
|---|---|---|
| P2-1 探测不支持同权“准入 + 披露”复用 | 撤权期望按 p 在所选备选中的**全部用途**决定（兼作准入 → 期望拒绝；纯披露 → 期望成功并裁剪）；被遮蔽的披露记 `disclosure-masked`；授权集隔离检查与 G⁻(A) 变体，防止补入其他用途的权限打开另一条准入分支；IDP 模板复制回归 | B-08 步骤二第 1、5 点 |
| P2-2 Tier 0 未触达授权点也被要求证明用途 | P1 / P2 / `missing-branch` / P5 / P4 的适用条件表；未达原因分 `validation` / `not-found` / `not-asked`；归因检查 `PROBE_UNSTABLE`；未达项进覆盖台账，本期 Tier 1 组必测，其余列未交付；IDP goals `{}` 回归 | B-08 步骤二第 2 点、B-09 覆盖台账、§5 |
| P3 FW-08 依赖真实对象的未交付场景 | 未交付清单补“跨租户对象、成员停用后重放、自助解绑 / 改绑” | §5 |
| P3 “结果等于 O\*”比较口径 | 状态部分必须相等；响应体规范化（UUID、时间、revision）；备选自身允许的输出差异冻结为 `altDiff`，由 FW-04 逐路径核对 | B-08 步骤二第 8 点 |
| DEC-356 口径 | Q-B1～Q-B6 定稿写入 §5；B-12 改为引用接管 T1 设计；B-11 改称“削减登记（含内容变更）”，§10.6 作废标注由 PR-B6 补；Q-B7 按 DEC-359 定稿 | §0、B-11、B-12、§5 |

## 附录 C：v3 → v4 对照（#152 设计审第 3 轮，head 9b0c443）

| 审查项 | v4 修订 | 落点 |
|---|---|---|
| P2 守卫内部权限一律视为必需，误报“当前执行人撤计划查看权仍 201” | 守卫内部义务登记内部角色 `inner`（必需 / 内部“或”备选 / 内部条件），数据态备选登记在 `GUARD_INNER_ALTS`；样本按内部分支各造一份并登记 `satisfies`；撤权期望按样本实际满足的内部分支决定，新增内部 `missing-branch`、`GUARD_ROLE_UNBOUND`、`GUARD_INNER_NOT_ALTERNATIVE`；Tier 0 记 `inner-branch-unknown`；9 条 IDP 执行人类端点的期望表与正反例 | B-08 步骤二第 5 点、§3、§4 PR-B1 |
| P3 规范化不应无差别替换 UUID 与业务日期 | 只替换样本间随机生成值：样本标识按角色名、本次新生成标识按出现顺序、系统时间戳按字段名；固定时钟；业务日期、固定引用、revision 保留原值；新增两条规范化反例 | B-08 步骤二第 8 点 |
