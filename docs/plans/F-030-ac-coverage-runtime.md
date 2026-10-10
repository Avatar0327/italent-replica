# F-030 AC 覆盖统计改为运行时采集：实现方案（DEC-254）

> 状态：已实现（2026-10-07，F-030 开发会话）。方案稿写于 #91 合并前；#91 合并（cb823b6）后按本方案实现，
> 实现中与方案稿不同之处见第 9 节。第 7 节的待定事项已由用户按建议默认值确定（DEC-271），见第 7 节末尾。
> 第 4 轮起按 DEC-282 补充“收窄支持面、不支持即报错”，支持的写法清单见第 10 节。

## 1. 要解决的问题

PR #91 的 `scripts/ac-coverage.mjs` 从源码静态推测注册了哪些用例。第 4、5 轮审查共报出约 70 种写法变体导致的静默误算，归为 8 组：参数表被修改、对象属性覆盖、`undefined` 遮蔽、标题格式化、用例函数别名与分类、空表、未执行回调、skip / todo 选项。DEC-245 的白名单方案也没能堵住。

根因是：只要从源码推测，就要重新实现一遍 JavaScript 和 Vitest 的语义。本任务**不读源码**，用例由 Vitest 自己执行注册代码得出：

- 真实注册了哪些用例；
- 格式化后的最终标题；
- 每个用例的 run / skip / todo / only 状态。

## 2. 采集方式：Vitest Node API 运行时收集（三选一的选择与理由）

做法：调用 `createVitest('test', …)` 后执行 `vitest.collect(filters, { staticParse: false })`。这是 `vitest list` 背后的同一套收集流程，但改用运行时模式。收集时，Vitest 在 worker 中真实加载测试文件，执行模块顶层代码和各级 `describe` 回调，并对 `.each` / `.for` 的标题做格式化；`it` 回调本身和各类钩子不执行。

收集完成后，逐个读取 `TestCase` 的以下属性：

| 属性 | 用途 |
|---|---|
| `name` | 用例自身标题 |
| `parent` 链 | 逐级 describe 标题，**按数组保存**，不用 ` > ` 拼接后再拆 |
| `options.mode` | run / skip / todo / only |
| `options.each`、`options.concurrent` | 只用于报告展示 |
| `module.relativeModuleId`、`location` | 文件与位置 |

| 方案 | 结论 | 理由 |
|---|---|---|
| `vitest list --json` 命令行 | 不直接用 | ① Vitest 5.0.3 的 `list` **默认就是静态解析**（`--static-parse` 默认 true），正是要避免的做法。在当前 main 上实测，默认静态解析收集到 1492 个验收用例，运行时收集到 **1790 个**，差值是 each 表和动态生成的用例。② 即使加 `--static-parse=false`，JSON 也只有 `name` / `file` / `location`，没有 skip / todo 状态。③ `name` 用 ` > ` 拼接，标题里本身含 ` > ` 时无法可靠拆开。 |
| 自定义 reporter（随完整测试运行） | 暂不采用 | 必须完整跑一遍测试才有结果：本地 PGlite 全量需要几十分钟，CI 要两个作业各跑一次。要拿到结果还得改 `ci.yml`，按 AGENTS §3.7 须单独开 PR。它能多拿到的只有运行期结果（通过 / 失败、`ctx.skip()`）；失败已由“CI 必须全绿”兜住，而 `ctx.skip()` / `.only` / `.fails` 在全仓 grep 为 0 处。 |
| 读取 CI 测试结果 JSON | 不采用 | 依赖 CI 产物，本地无法复现；同样要改 CI；另外 PR 合并前、文档改动不触发 CI 时都拿不到结果。 |
| **Node API 运行时收集（采用）** | 采用 | 用例是否注册、最终标题、skip / todo / only 状态，全部由 Vitest 执行注册代码决定，不做任何源码推测。收集只用 Vitest 的公开 API，不执行用例与钩子，所以不连数据库：当前 main 的 `tests/acceptance` 292 个文件，单次收集约 2.5 分钟（本容器）。本地和 CI 结果一致。 |

已知局限（写进报告页脚）：用例体内的运行时 `ctx.skip()` 与用例失败，收集阶段看不到。前者全仓 0 处；后者由 CI 两个作业全绿保证。以后如果确实需要，可以复用同一套统计模块，再加一个“读取 reporter 结果”的输入，不改统计口径。

### 2.1 条件执行（真 PG 专属用例）

`describe.runIf(Boolean(process.env.TEST_DATABASE_URL))` 等写法会在收集阶段决定状态。工具收集两档：

| 档 | `TEST_DATABASE_URL` |
|---|---|
| `pglite` | 删除该变量 |
| `pg` | 设为不可连接的占位 URL。收集阶段不执行钩子，不会连库；如果某个测试文件在模块顶层连库，会作为收集错误报出，`--check` 失败 |

用例只要在任一档为 run，就计为覆盖；只在部分档运行时，标“条件执行（仅 pg）”，与 R1 报告“含条件执行”的口径一致。

在当前 main 上实测：`pglite` 档 1726 run / 63 skip / 1 todo，`pg` 档 1789 run / 1 todo；有 2 个编号只出现在真 PG 专属用例里。两档可以并行收集。

## 3. 从标题提取 AC 编号

- 编号格式与追溯表一致：`AC-<模块>-<序号>`。模块取 `[A-Z0-9]+`，以兼容 R3 的 `AC-360-*`（旧脚本的 `[A-Z][A-Z0-9]*` 认不出它）；序号 2～3 位，后面不能再接数字。
- 沿用 R1 用例标题里已有的简写展开：
  - `AC-ORG-01~09`、`AC-ORG-01～09` 展开为区间；
  - `AC-TRF-01/37/45`、`AC-TRF-13 / 14` 展开为同模块的多个编号。

  R1 人工核对也按这个规则计数，不改变口径。
- **逐段提取**：describe 链上的每一级标题、用例自身标题各提取一次，再取并集。不跨段、不跨用例拼接字符串，避免第 5 轮 P2-4 那种跨参数拼出不存在编号的问题。
- 一个用例覆盖的编号 = 各级 describe 标题与自身标题中编号的并集，与 R1 报告“用例标题 = 各级 describe 标题 + 自身标题”的口径一致。
- 标题一律取 Vitest 格式化后的结果，`%s` / `%d` / `$0` / `$a.b` / `%#` / `%$` 都由 Vitest 自己处理。比如 `%d` 把 `'AC-DEMO-01'` 格式化成 `NaN`，工具看到的就是 `NaN`，不会误计。

### 3.1 支持的编号格式（采集契约，DEC-291② 起）

| 写法 | 说明 | 例 |
|---|---|---|
| 单个编号 | `AC-<模块>-<序号>`。模块可多段：首段由大写字母或数字组成（兼容 `AC-360-*`），其后每段以大写字母开头；序号 2～3 位，后面不能紧跟数字 | `AC-TRF-01`、`AC-360-01`、`AC-PRM-FW-01`、`AC-360-FW-01` |
| 区间 | `~` 或 `～`，终点只写序号，终点须大于起点 | `AC-ORG-01~09`、`AC-PRM-FW-01～07` |
| 同模块并列 | `/`，可带空格，只写序号 | `AC-TRF-01/37/45`、`AC-TRF-13 / 14` |
| 模块统称 | `AC-` 后只有模块名，不算编号、不报错 | `AC-TRF 核心真 PG 交错`、`AC-PRM-FW` |

- **报 `title` 问题、不吞掉的写法**（同一标题里能识别的编号照常计入）：
  - 区间逆序或终点等于起点；
  - 序号位数不对，如 `AC-PRM-FW-1`；
  - 空段，如 `AC-PRM--03`；
  - 编号后连写其他段，如 `AC-EMP-16-SUB-05`、`AC-TRF-01-07`、`AC-PRM-01X`；
  - 模块含小写字母，如 `AC-prm-01`；
  - 区间终点写成完整编号，如 `AC-PRM-03～AC-PRM-05`。
- **阶段配置**：
  - 单号与简写同上；
  - `AC-<模块>-*` 按完整模块名精确匹配（`AC-PRM-*` 不含 `AC-PRM-FW-*`）；
  - 认不出、逆序、通配匹配不到定义的写法，都报配置问题。
- **定义与统计**：定义取 Markdown 表格首列为单个编号（含多段）的行；统计、分组与“测试引用但不存在的编号”都按完整编号聚合。

## 4. 定义来源与覆盖状态

**定义来源**由配置给出，内容是若干 Markdown 文件或目录。取表格首列恰为单个 AC 编号（可带括号说明）的行；同一编号以配置顺序中第一次出现为准，重复定义列入报告的“提示”。

建议默认来源：

- `docs/05_验收/01_验收场景与追溯表.md`；
- `docs/02_业务建模/` 全目录。R2 / R3 的 AC 都定义在规格末节（追溯表 K、L 节只写了指向），R1 也有 AC-TRF-24～27 只定义在 `13` §4.1。

当前 main 上按此口径扫出 414 个定义。

**每个范围内编号的状态**：

| 运行时状态（机器判定） | 条件 |
|---|---|
| 已覆盖 | 至少一个用例在某一档为 run（或 only，见下） |
| 仅 skip / todo | 有用例，但在所有档都是 skip / todo |
| 未覆盖 | 没有用例标题含该编号 |
| 未定义 | 范围内的编号在定义来源中找不到 |

此外，**测试引用但追溯表中不存在的编号**单独列出。这一项扫描全部收集到的用例，不受阶段过滤影响。

**人工层**沿用 #91 已被审查认可的做法，配置项含义与 #91 历史中的 `R1.json` 相同：

- `notes`：给出最终状态（部分覆盖 / 未覆盖）、分类（已有 DEC / 待取证 / 待其他任务 / 建议补测）和原因；
- `evidence`：把标题未写编号的用例**按完整标题精确匹配**指认为证据，匹配对象是运行时收集到的标题数组。找不到时报“映射失效”，`--check` 失败。

报告**同时列出运行时状态和人工核对后状态**，两者不同的行一眼可见。

**以下情况一律列为问题（problems），`--check` 失败**（完整清单见第 10 节）：

- 收集错误：文件加载失败、语法错误、`describe` 回调抛错，以及 Vitest 拒绝生效的 `.only`，一律原样报出；
- 出现 `only`：会让同文件其他用例被 Vitest 标成 skip，统计失真；
- 身份无法确认的注册（第 9 节第 3、4 轮）；
- 映射失效；
- 配置里的编号区间写错。

## 5. 命令、输出与阶段过滤

```text
pnpm ac:coverage --stage R1                 # 人读 Markdown 输出到 stdout
pnpm ac:coverage --stage R1 --format json   # 机器可读 JSON
pnpm ac:coverage --stage R1 --out <目录>     # 同时写 <阶段>.json 与 <阶段>.md
pnpm ac:coverage --stage R1 --check         # 有缺口、未定义引用、问题时退出码 1
pnpm ac:coverage --stage all --check        # 各阶段合并
```

- 阶段配置放在 `docs/05_验收/ac-coverage/<阶段>.json`，包含 `groups`（范围，支持 `AC-EMP-01~11` 写法）、`notes`、`evidence`。
  - R1 配置从 #91 历史中的 `R1.json` 恢复（DEC-254 删除前的最后版本 d07fa21^）。其中的人工判断已体现在报告 §3 明细表。
  - R2 / R3 配置的范围口径见第 7 节待定事项。
- `--save-collected <文件>` / `--from-collected <文件>` 显式保存、复用一次收集结果，供同一提交上按阶段多次统计。
- JSON 输出包含：每个编号的运行时状态、人工状态、用例数、条件执行档、测试文件、定义位置；测试引用但未定义的编号；problems；收集统计（每档的 run / skip / todo 数）。
- 新增 npm 脚本：根 `package.json` 增加 `"ac:coverage": "node scripts/ac-coverage.mjs"`（共享文件，PR 描述会列出）。

## 6. 测试设计（先提交失败测试，再提交实现）

`tests/tooling/ac-coverage.test.ts` 以子进程方式运行工具：一个 Vitest worker 里不再嵌套另一个 Vitest 实例，因为嵌套会受 worker 环境与并发影响，子进程更稳定。

夹具放在 `tests/tooling/fixtures/ac-coverage/`：

- 测试文件命名为 `*.fixture.ts`，不会被主测试的 `include` 匹配到，也就不会被当成真实用例；
- 夹具自带定义 Markdown 与配置。

断言分两层：

1. **与 Vitest 实际注册一致**：在同一个夹具上，工具 JSON 里每个用例的“标题数组 + 状态”与 Vitest 收集到的实际结果逐条相等。
2. **具体结果**：对每个变体断言哪个编号已覆盖、哪个未覆盖或仅 skip / todo，证明报告结果不是碰巧相同。

覆盖的变体包括派发单点名的几类，以及第 5 轮审查 8 组中可以落成夹具的代表写法：

| 组 | 变体 |
|---|---|
| 标题格式化 | each 表 `%s` / `%d`（`NaN` 不计）/ `%i` / `%f` / `%j` / `$0` / `$a.b` / `%#` / `%$`；`AC-%s-%s` 拼出编号；长字符串被截断；跨参数行不合成编号 |
| describe 层级 | `describe.each`、`describe.for`、嵌套 describe 编号并集、`describe.todo`、`describe(…, { skip: true })` |
| 用例函数 | `it.concurrent`、`const check = it.concurrent`、`it.concurrent.each`、`test.describe`、`test.suite`、对象属性上的 `it`、动态 `import('vitest')` |
| skip / todo | `it.skip`、`it.todo`、无回调的 `it('…')`、`{ skip: true }` / `{ todo: true }` 选项、`skipIf` / `runIf`（两档收集） |
| 空表与未执行回调 | `it.each([])`、`describe.each([])`、`ignore(() => it(…))`、`[].forEach(() => it(…))` |
| 动态生成 | 循环生成、函数调用生成的表、展开与拼接 |
| 被修改的常量表 | `rows[0].ac = …`、`push` / `splice` / `length = 0`、解构重赋值、`Object.defineProperty`、对象展开覆盖、getter、原型属性、`undefined` 遮蔽 |
| 检查与问题 | `only` 报问题；收集错误报问题；映射失效；测试引用未定义编号；`--check` 退出码；`--stage` 过滤；两档条件执行标注 |

另外加一条回归：把 `tests/acceptance` 的实际收集结果与 R1 配置对照，结果作为第 4 步复核数据。这条只在 `--check` 命令里跑，不作为单元测试，避免单元测试多出 2.5 分钟。

## 7. 待总编排确认的事项（需要决策，确认前不自行定口径）

1. **`--check` 对人工备注缺口的处理**：追溯表要求覆盖、但人工备注为“未覆盖 / 部分覆盖”的条目，比如 R1 中已有 DEC 的 7 条，是否算通过？
   - 建议：有备注、并写明分类与依据（DEC 编号 / issue / 任务编号）的放行；没有任何备注的缺口和“仅 skip / todo”判失败。否则 R1 永远不能通过 `--check`。
2. **R2 / R3 的阶段范围口径**。
   - 建议默认值：R2 = 追溯表 L 节列出的模块（OF / EN / ON / PB / DM / RT / DT / PT / IN / LB / CT / OA / HA）在规格中定义的全部编号；R3 = K 节模块（TC / QL / EV / 360 / TR / SC / TP / IDP，加 K.0 的 EXP）。
   - 阶段任务在其他模块新增的 AC（如 F-022 的 AC-EMP-17～21），由任务 PR 把编号补进对应阶段配置。
   - 也可以改为从路线图“对应验收”逐条维护。
3. **定义来源扩到 `docs/02_业务建模/` 全目录**（建议是，理由见第 4 节）。
4. **当前 main 已发现 2 个测试引用了不存在的编号**：
   - `AC-SMOKE-01`：M0 骨架冒烟用例。建议在配置 `ignore` 中登记为非业务编号。
   - `AC-TRF-161`（`tests/acceptance/AC-TRF-161-activation.test.ts` 的 describe 标题）：从文件注释看指的是 DEC-161，不是 AC 编号。建议把标题改成“DEC-161 …”，再补上实际对应的 AC 编号。该文件不在本任务归属内，改不改、改成哪个 AC，请总编排决定。
5. **是否接入 CI**（先只提供 npm 脚本）。候选方案：
   - A. 在 `check` 作业 `pnpm test` 之后加一步 `pnpm ac:coverage --stage all --check`：每个非 Draft PR 增加约 3 分钟（两档并行收集）。
   - B. 单独开一个作业，只在 push 到 main、每周定时和手动触发时跑：PR 不增加分钟，main 上发现问题后再修。
   - C. 自定义 reporter 挂在现有 `pnpm test` 上，零额外收集；但 PGlite 作业看不到真 PG 专属用例，需要合并两个作业的产物，改动最大。

   建议先 B，R2 验收前转 A。任何一项都要单独开 `ci.yml` PR（AGENTS §3.7）。

**DEC-271 结论（2026-10-07，用户按建议默认值确定）**：

1. 有人工改判（含分类与原因）的未覆盖 / 部分覆盖，`--check` 放行；
2. R2 / R3 先按追溯表模块节统计；
3. 定义来源取 `docs/02_业务建模/` 全目录；
4. `AC-SMOKE-01` 加入 ignore；`AC-TRF-161` 测试改为实际对应的 AC-TRF-31，文件改名为 `AC-TRF-31-DEC-161-activation.test.ts`；
5. AC-TRF-42 改判为已覆盖，并同步更新 R1 报告。

是否接入 CI 仍待另行决定。

## 8. 第 4 步复核（#91 合并后执行）的预期

在当前 main（不含 #91 的端到端用例）上用上述口径预演 R1 配置的 243 项：

| 层 | 结果 |
|---|---|
| 运行时 | 230 已覆盖、13 未覆盖 |
| 叠加人工层后 | 217 已覆盖 + 3 人工映射、13 部分覆盖、8 未覆盖，另有 2 条未覆盖 |

那 2 条是 AC-PRM-27 / 28，只在 #91 的端到端用例里。#91 合并后预期与人工核对的 222 / 13 / 8 / 0 一致。正式复核以合并后的 main 为准；如有不一致，逐条列出差异与原因写进 PR 描述，**不改报告数字**。

## 9. 实现与方案稿的差异

| 项 | 方案稿 | 实现 | 原因 |
|---|---|---|---|
| `.only` 识别 | 读 `options.mode === 'only'` | 已由第 3 轮（DEC-282）取代，见本节末“第 3 轮” | — |
| 收集复用 | `--collect-cache` | `--save-collected` / `--from-collected` 两个显式参数 | 避免隐式缓存在代码改动后被误用 |
| 人工映射匹配 | 完整标题精确匹配 | 同左：用例自身标题或“各级标题 > 连接”的完整标题须完全相等 | 旧脚本按“包含”匹配；R1 配置中 5 处映射标题因此改写为用例完整标题，指向的用例不变 |
| 条件执行 | 只标“仅 pg”等 | 另加 `conditionalTests`：覆盖该编号、但只在部分档运行的用例数，Markdown 显示“含 n 个条件执行用例” | 与 R1 报告“含条件执行”的口径对齐 |
| 退出码 | — | 0 正常；1 `--check` 不通过；2 参数、配置或收集进程失败。不带 `--check` 时只输出报告 | — |

#102 第 1 轮审查后的修正（4 个 P2 与自查发现的同类 1 处）：

| 项 | 修正 |
|---|---|
| P2-1 多层 skip / todo | 叶子自身为 run、祖先 suite 为 skip / todo 时，Vitest 不改写叶子 mode 也不执行（reporter 报 pending）；收集端沿祖先链判定，记为 skip |
| P2-2 跨档配对 | 收集开启 `includeTaskLocation`，跨档按“文件 + 注册位置（行:列）+ 完整标题层级”配对（第 3 轮已按 DEC-282 改为身份 join，见下） |
| P2-3 逆序区间 | 配置里的逆序区间（如 `AC-DEMO-04~01`）报配置问题；标题里的逆序区间报 `title` 问题，均不展开、不猜测 |
| 同类自查 | 配置里的 `AC-<模块>-*` 匹配不到任何定义（模块写错）时同样报配置问题，避免范围被静默缩小 |
| P2-4 人工映射 | `evidence` 改用 `names`（完整标题层级数组，逐级精确相等）；只写 `title` 时按末级标题匹配。必须恰好命中一个注册用例且该用例运行，否则列为问题；R1 配置 5 处映射已改为 `names` |

### 第 3 轮：DEC-282 用例身份与状态（#102 第 2 轮审查 2 个 P2）

**① 用例身份与跨档 join**
- 身份 = 文件路径 + 完整名称路径 + 注册位置（`includeTaskLocation` 的行:列），全部取自 Vitest 任务对象。
- 各档按身份 join，**不再按注册顺序或序号配对**。认不出同一个用例时，列为 `identity` 问题，`--check` 失败；涉及的每个注册只计入它所在的那一档（第 4 轮起改为不计入覆盖，见下）。
- 认不出的情况有三种：

| 情况 | 判定 | 夹具 |
|---|---|---|
| 同一档内，两个注册（用例或其祖先 suite）的“文件 + 名称路径 + 位置”相同 | 身份冲突；其下所有用例都无法确认 | 03 同点循环、04 文件内 helper、05 `describe.each` 同名行、12 三档、13 常量标题 `test.each`、15 导入 helper 循环、17 同名父套件 + 同一 helper；另加 05 的变体（叶子分两处注册，只有父套件重复） |
| 某个身份只在部分档注册 | 各档对不上 | #102 第 1 轮的 `pairing.fixture.js` |
| 各档身份相同，但祖先 suite 的注册位置不同 | 各档对不上 | 18 |

- 与 DEC-282 字面的差异——**each 的“参数下标”未纳入身份**：
  - Vitest 不提供参数下标。实测 `TaskOptions` 只有 `each: true`，`id` 是注册顺序。下标只能按注册顺序推出，而按下标 join 正好会把 05（行序相反）和 13（两档参数行不同、标题相同）错配。
  - 因此 each 行靠格式化后的标题区分；标题相同的行按身份冲突报错。
  - 真实仓库只有一处：AC-EMP-08 的 `'$entering开启新周期…'`。Vitest 把紧跟的中文也当成变量名，两行都渲染成 `undefined…`。已把标题改为 `'$entering 开启新周期…'`；修正前该文件报身份冲突，`--check` 退出 1。
- 夹具 17 判身份冲突，与 DEC-282 的举例一致。由于身份比较也覆盖祖先位置，夹具 18 判“对不上”。

**② 有效状态与 only 门禁**
- 有效状态：用例自身与全部祖先 suite 在收集完成后的 `mode` 都是 run，且 `result().state` / `state()` 未被 Vitest 标为 skipped / failed，才算运行。
  - 必须连祖先一起读：实测 `describe.skip > describe.skip > it` 与 `describe.todo > describe.skip > it` 收集后叶子仍是 `mode=run`、`state=pending`，与普通可运行用例完全相同；只读叶子会让第 1 轮 P2-1 回归。
  - 这里只做“全部为 run”的合取，不解释 only / skip / todo 的语义。
- only 门禁：独立遍历所有已注册的 suite 与用例。以下两种情况一律报问题，不依赖祖先是否被跳过：
  - `mode` 为 only（挂在 skip / todo 祖先下面、Vitest 不再检查的残留 only）；
  - Vitest 以 `Unexpected .only` 拒绝（allowOnly: false）。第 4 轮起不再按这段报错文本认成 only，而是原样作为收集错误报出，见下。
- ③ 人工改判覆盖的编号若有用例带 only，另报“人工改判不能放行 .only”。收集统计新增 `only` 计数，均为整数。

**测试**：
- 用例体写执行 marker；
- 断言核对父注册位置与实际执行档（夹具 17、18）、每档运行条数与 marker 一致（全部冲突夹具），以及被跳过的 only 用例从未执行；
- 真值统一以 `allowOnly=false` 运行。

实测（本容器）：两档并行收集 `tests/acceptance` 约 4 分钟；工具自身测试 52 项约 36 秒。

### 第 4 轮：DEC-282 补充，收窄支持面（#102 第 3 轮审查 3 个 P2 + P3）

原则（总编排定，DEC-282 补充）：不支持的写法一律报错，不合并，也不推断；工具要么算对，要么报错，不悄悄给出错误的覆盖结果。

| 项 | 第 3 轮做法的缺口 | 第 4 轮做法 | 夹具 |
|---|---|---|---|
| P2-1 模块收集错误 | 按消息是否含 `.only` 过滤错误，模块顶层抛出 `Error('configuration for .only failed')` 被吞掉，`--check` 退出 0 | 收集错误一律原样报 `collect`，不按消息文本分辨来源；only 门禁只认 `mode` 仍为 only 的注册。生效的 `.only` 被 Vitest 拒绝时 `mode` 已改回 run、挂一条错误，这条错误作为收集错误报出（带用例标题与位置）。两条路径都让 `--check` 失败 | `module-errors`（顶层抛错、describe 回调抛出与 Vitest 拒绝 only 逐字相同的消息）；`only/o10`、`o09`、`problems/only` |
| P2-2 位置未知 | 只检查叶子位置；祖先位置 `[null]` 与 `[null]` 被当成相同 | 叶子或任一祖先 suite 位置未知（null / 缺失），即报 `identity`（位置未知）；顶层用例（祖先为空）照常 | `unknown-location`：19 单层未知祖先、22 两档不同 async 父注册函数、29 用例位置未知、31 已知外层 + 未知中间层；`control` 对照 |
| P2-3 跨 project 同档重复 | 只在单个 module 内查重；join 时取同档第一条，第二条注册被丢掉 | worker 在整档范围（跨 module）统计父套件 / 用例重复；join 层再按“同档注册数 > 1”查重；注册来自不同 project 时另报“跨 project 同名” | `projects`：33 两个具名 project 收集同一文件（含父套件下的用例）；`only-a` 单 project 对照 |
| 身份无法确认的注册如何计 | 各自计入所在档 | **不计入覆盖**：汇总与明细的计数都不含；在 `identity` 问题里逐条列出（文件、名称路径、位置、档、project、祖先位置、状态），JSON 的 `problems[].registrations` 同样给出。收集统计另列“身份无法确认（不计入覆盖）”与“收集错误”数 | 以上全部；原有 identity / pairing 夹具的断言同步改为“列出、不计入” |
| P3 旧缓存 | `--from-collected` 读旧格式时读不到旧的 `pairing` 问题，退出码从 1 变 0 | 采集结果带 `formatVersion`；版本不符（含无版本号的旧缓存）拒绝，退出码 2，提示重新采集 | CLI 测试 |

受影响的原有结论：`variants/pairing` 的 AC-DEMO-117 只在 PG 档注册的那条运行用例不再计入，剩下两档都 skip 的那条，判“仅 skip / todo”（同时报 identity）；AC-DEMO-116 只在 PG 档注册的 skip 不再计入。

## 10. 支持的写法清单（采集契约，DEC-282 补充）

清单内的写法工具算对；清单外的写法一律报错（`--check` 退出 1）。夹具都在 `tests/tooling/fixtures/ac-coverage/`。

**支持的写法**

| 写法 | 工具行为 | 夹具 |
|---|---|---|
| 普通 `it` / `test`，任意层 `describe` 嵌套；`test.describe` / `test.suite`、别名、对象属性上的 `it`、动态 `import('vitest')`、回调里注册 | 按 Vitest 实际注册与格式化后的标题计；编号 = 各级标题与自身标题逐段提取的并集 | `variants`：functions、suites、nested、dynamic |
| `it.each` / `test.each` / `describe.each` / `.for` / `concurrent.each`，各行格式化后的标题互不相同（`%s`、`$name`、`$0`、`%#` 等） | 每行一个用例，按格式化后的标题计；`%d` 得 `NaN` 等也按真实标题计 | `variants/format`、`variants/suites`、`identity/stable` |
| 循环、函数返回的表、展开、拼接、模板表、被修改的常量表、getter、原型属性 | 按运行时最终值计 | `variants`：functions、mutated |
| `skip` / `todo` / `skipIf` / `runIf` / `{ skip: true }` / `{ todo: true }` / 无回调用例，任意层祖先 skip / todo | 不计覆盖，判“仅 skip / todo” | `variants`：skip-todo、nested |
| 条件执行：两档都注册、只在一档运行（如 `runIf(TEST_DATABASE_URL)`） | 计覆盖，标出所在档 | `variants/conditional`、`identity/stable` |
| 空 each 表、从未执行的注册回调 | 不注册，判未覆盖 | `variants/empty` |
| 被导入的 helper 在测试文件里**同步**调用注册 | 位置记在调用行，不同调用行可区分 | `identity/stable`（第 2 轮夹具 14） |
| 多个 Vitest project，每个文件只属于一个 project | 照常计，记录所属 project | `projects/only-a` |
| AC 编号：单号、`~` / `～` 区间、`/` 并列、多段编号（`AC-PRM-FW-01`）、数字开头的模块（`AC-360-*`） | 见 §3.1，按完整编号聚合 | `variants/range`、`multiseg` |
| 人工层：`notes` 改判（含分类与原因）、`evidence` 按完整标题层级映射 | 改判放行缺口；映射须恰好命中一个运行用例 | `variants/evidence`、`clean` |

**清单外，一律报错**

| 写法 | 报错 | 夹具 |
|---|---|---|
| 任何 `.only`：挂在 skip / todo 祖先下的，或已被 Vitest 拒绝的 | `only`（`mode` 仍为 only）或 `collect`（Vitest 的拒绝原样报出） | `only/o01～o10`、`problems/only` |
| 模块加载、`describe` 回调抛错（不论消息内容） | `collect` | `module-errors`、`problems/throws` |
| 同一档内“文件 + 名称路径 + 位置”相同的注册：循环 / helper 在同一点注册同名用例、each 各行标题相同、同名父套件、同一文件被多个 project 收集 | `identity`（身份冲突 / 跨 project 同名），逐条列出、不计入覆盖 | `identity` 各夹具、`identity3`、`projects/same-file` |
| 用例或任一祖先 suite 注册位置未知（async 注册：`setTimeout` 等之后才调用 `describe` / `it`） | `identity`（位置未知），同上 | `unknown-location/u19`、`u22`、`u29`、`u31` |
| 只在部分档注册（如 `if (env) it(…)`）、各档祖先 suite 位置不同 | `identity`（各档对不上），同上 | `variants/pairing`、`identity/parent-per-profile` |
| 标题里的非法编号写法：逆序区间、位数不对、空段、连写、小写、区间终点写全称 | `title` | `variants/range`、`multiseg` |
| 配置范围认不出、逆序、通配匹配不到定义 | `config` | `variants/REVERSE`、`multiseg/BAD` |
| 人工映射找不到、命中多个、指向未运行的用例；备注缺分类或不在范围 | `evidence` / `note` | `variants/evidence`、`problems` |
| 测试引用了定义来源里不存在的编号 | 未定义引用 | `variants` |
| `--from-collected` 的收集结果格式版本不符 | 退出码 2 | CLI 测试 |

**已知边界（按公开字段计，不推断；不是静默误算）**

- 用例身份只看公开字段（文件、名称路径、位置）。each 各行只靠 `%#` 等行号区分时，两档参数不同也视为同一用例：覆盖按标题里的编号计，结论不受影响，但不能据此证明两档跑的是同一组参数（第 3 轮报告夹具 08 / 16 / 32）。需要区分时把稳定的行标识写进标题。
- 用例体内的 `ctx.skip()` 与用例失败，收集阶段看不到，由 CI 全绿兜底（全仓 `ctx.skip()` 0 处）。
- 第 3 轮列出的存量问题转 F 任务，本轮不改：空范围配置可零项通过、非数组 `evidence.names` 回退、映射文件只认 basename。
