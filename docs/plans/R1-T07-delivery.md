# R1-T07 审批中心交付说明

核对日期：2026-10-03（第二轮修改后更新）。实现依据为 `AGENTS.md`、派发单 §1/§5、路线图 R1-T07 行、`03_需求基线` REQ-APV-001~004、`02_业务建模/14` §1–§11、验收表 AC-APV-*（含 13~20）、AC-TRF-11/12、AC-PRM-29，遵循 DEC-017/018/035/036/053/054/057/058/059/063/064/068/069/070 与第二轮决策 DEC-091～102。第二轮按 PR #35 评论“第二轮修改清单（编排会话合并三方审计 + 产品决策）”逐条修改，已合并 `origin/main` 的 `916cbf1`。

## 对象与数据模型

| 表 | 作用 |
|---|---|
| `approval_processes` | 流程稳定对象：编码（租户唯一）、审批类型、对象、状态（可用 / 废弃）、当前生效版本、最新版本号、预置键 |
| `approval_process_versions` | 流程版本：名称、分组、优先级、兜底标记、异常管理员、催办开关、高级表达式；草稿 → 发布，已发布只读（触发器） |
| `approval_process_conditions` | 发起条件条目：白名单字段路径 + 运算符 + 单值 / 值列表 |
| `approval_process_nodes` | 节点：审批人表达式、审批人为空策略（只剩“转异常管理员”，DEC-054）、相同 / 历史相同审批人跳过、节点表单字段（含 `custom:<id>`）、可编辑字段与编辑形态、转交 / 加签 / 抄送 / 审批人撤回开关、催办三态（继承 / 开启 / 关闭）、“意见仅本节点与发起人可见”、驳回意见必填（DEC-059 出厂关）、驳回后重提方式；时效字段只预留（DEC-035） |
| `approval_node_message_rules` | 消息规则：触发动作 → 渠道 → 模板 → 接收人表达式 |
| `approval_instances` | 实例：绑定发起时版本 ID（触发器禁止改版本与业务归属）、业务类型与业务 ID、异动员工、发起人、流程编码、状态、当前节点、驳回节点、轮次、审批人所读载荷的业务版本 `business_version`、发起条件取值 `condition_values`、revision |
| `approval_tasks` | 任务：节点、轮次、审批人、来源（解析 / 自审跳过 / 异常管理员 / 跳过类 / 转交 / 前加签 / 后加签 / 加签返回 / 审批人撤回 / 异常管理员交接 / 管理员转交 / 管理员干预 / 盲审转交）、状态（含“已加签挂起”）、异常管理员与“管理员转交自审”标记 |
| `approval_instance_ccs` | 抄送记录（DEC-097）：节点、发起任务、被抄送人、附言；被抄送人可查看本节点表单 |
| `approval_instance_logs` | 节点日志 / 审批记录，只追加 |
| `approval_notifications` | 待办、抄送与消息通知，按接收人过滤，状态 pending / sent / failed / unknown |
| `approval_outbox` | 领域事件，与命令同事务 |
| `personnel_change_request_versions`（人员模块） | 员工信息变更申请的载荷版本（DEC-099）：首次提交与每次同单修正各追加一版，历史保留 |

全部表带 `tenant_id` 并 ENABLE/FORCE RLS；人员引用指向租户成员或任职员工主档。所有写命令带 If-Match（revision，冲突 409）与 Idempotency-Key，业务写入、字段级审计、outbox、命令台账同一事务。

## 规则落地

- **版本**（REQ-APV-001 R1~R3、R6）：草稿整体替换；已发布不能直接改（409 `APPROVAL_VERSION_PUBLISHED`），只能“编辑最新版本”以当前生效版本为底稿生成下一版草稿；发布只影响新实例；在途实例按冻结版本流转；废弃移出可用列表且不参与匹配。
- **发布校验**：发起条件为空且未声明兜底 → 400 `APPROVAL_CONDITION_REQUIRED`（DEC-018）；未配置异常管理员 → 400 `APPROVAL_EXCEPTION_ADMIN_REQUIRED`（DEC-054）；同类型普通流程优先级相同 → 409（DEC-096，咨询锁防并发）；异常管理员须为有效成员。并发创建同编码 → 409（冲突安全插入，X-21）。
- **匹配**（DEC-017 / DEC-096）：先按审批类型过滤已发布的当前版本，再按优先级评估发起条件，兜底流程始终排在同类型条件流程之后；同类型都不满足 → 409 `APPROVAL_PROCESS_NOT_MATCHED`，不跨业务兜底。候选流程按编码键集分批读取（每批 200），流程数量不设总量上限（DEC-101）。
- **流程编码**（清单 14）：不接受发起人指定；由服务端按业务派生，R1-T09 之前固定为审批类型的默认编码。
- **发起条件**：字段路径白名单 + 运算符 eq / ne / in / not_in / is_empty / not_empty / in_org_tree，高级表达式支持 and / or / not / 括号。驳回后重提时若条件字段取值变化，重新匹配：命中不同流程则旧实例作废（日志 `rematch`）、新开实例，单据与历史保留；命中同一流程则同单重提（DEC-093）。
- **审批人**（REQ-APV-002）：五种表达式；组织负责人 / HRBP 取业务日期的现行版本，人员经账号绑定落到用户；解析到没有账号或账号已停用的人员按“审批人为空”处理（DEC-098）；派单前复核成员身份（C-非5）。同一次推进内路由查询按主体缓存（X-20）。
- **审批人为空与异常管理员**：首节点为空 → 提交报错（409 `APPROVAL_FIRST_NODE_EMPTY`）；中间节点一律转异常管理员（DEC-054，不再接受自动跳过 / 自动同意配置）。异常管理员恰为发起人或异动本人时转其有效直线经理，没有则拒绝提交（DEC-091）；流程上的异常管理员已停用时由租户管理员接管（DEC-098）。异常管理员停用前必须交接（`POST /exception-admins/handover`：引用流程以新异常管理员重新发布、在办异常任务转给替代人；迁移 0028 触发器拦截未交接的停用）。
- **自审与同人跳过**：自审（发起人或异动本人）→ 跳过且不计同意，转其直线经理（DEC-068），被跳过的人不因此成为参与人（C-非3）。相同 / 历史相同审批人跳过结果为“同意”，“历史”只认本轮（TODO 需取证 #39）；自动同意前按候选人当前字段权限做盲审，受阻按 DEC-069 转异常管理员（清单 5）；自动同意同样触发该节点的同意消息规则（X-14）。
- **节点动作**：同意；驳回（实例“退回”）；转交；加签分前加签（本人任务挂起，被加签人先审，同意后回到本人）与后加签（本人同意后由被加签人审），任一加签人驳回即整单驳回（DEC-095，与 `14` §11.4 一致）；抄送（节点开关，被抄送人收到通知、可查看本节点表单，DEC-097）；审批人撤回（节点开关，下一节点尚未人工处理时可撤回本人的同意，任务回到本人，DEC-097，时限待取证 #37）；催办（节点“继承 / 开启 / 关闭”覆盖流程设置，同一实例 30 分钟一次，X-15 / C-非5）；发起人撤回（审批侧与业务单入口都只允许发起人，并复核其当前撤回权限，清单 10 / C-非5）。
- **审批中的单据**（清单 1）：任职申请审批中，业务端 PATCH 返回 409 `APPROVAL_IN_PROGRESS`，只有审批适配器能按节点可编辑字段修改；实例绑定审批人所读载荷的业务版本，载荷被改过时携旧 revision 的同意返回 409。
- **审批中编辑**（清单 2~4）：可编辑字段 = 节点开放 ∩ 审批人当前字段编辑权，并校验对象更新权限；快照覆盖预置字段、自定义字段（`custom:<id>`）、生效日期（一律计为变化）与离职最后工作日（写入业务顶层并重算生效日）。【编辑并同意】刷新快照后按新快照重新做盲审，受阻则整单回滚（编辑不生效、任务仍在本人名下）并返回 403。
- **重提**：任职申请在申请单上修改后提交（详情不公布审批侧“重提”，X-16）；员工信息变更可在同一张单上修正重提，修正内容追加为新版本（DEC-099）。
- **管理员**（DEC-063 / DEC-070 / DEC-092）：持有 `ApprovalInstance` 的转交 / 干预按钮且实例员工在其数据范围内，才能转交或干预；不能以他人名义同意 / 驳回；不能干预本人发起或本人为异动对象的实例；转交给自己须填理由并留痕。
- **流程配置权**（DEC-102）：仅限持有 `admin.process_matrix` 能力的租户级管理员身份；部门级身份即使持有流程对象按钮也不能配置；查看与仿真仍可凭流程对象查看权。与实例干预权分开。
- **最小披露**（DEC-057 / DEC-100）：详情只显示查看人所在节点（被抄送人为抄送节点）的表单字段，再按其字段权限裁剪；标题只含审批类型名称，不含个人数据（清单 8）；用户可见日志按字段权限投影，不暴露不可见的变化字段名（X-13）；审批意见默认公开，节点开启“仅本节点与发起人可见”后其他节点看不到，详情带“勿在意见中填写敏感信息”提示。
- **盲审**（DEC-058 / DEC-069）：先校验 revision 与任务状态，再判断盲审；变化字段中有审批人不可见的 → 403 `APPROVAL_BLIND_REVIEW`，在办任务转异常管理员；异常管理员本人也看不到时不循环给自己建任务，详情不显示其无法执行的同意 / 驳回（C-非4）。
- **审计与 outbox**（清单 12 / 13）：任务的创建（含自动跳过）、取消、盲审转交、交接都按任务 ID 写字段级审计；管理员跳转 / 转交 / 干预、审批中编辑、盲审转交都写 outbox 事件。
- **加锁顺序**（清单 11）：所有入口先锁业务（适配器 `lock`），再锁实例；冲突返回 409，不自动重试。
- **容量**（DEC-101）：去掉单实例任务 / 日志的总量上限；详情默认给出最新 200 条，完整历史经 `/instances/:id/tasks|logs` 分页读取；同一审批单同时在办的任务不超过 50 个（413）；自动跳过链在内存中维护任务，不逐节点重查。
- **仿真**（DEC-036）：只用虚拟数据——审批人关系、直线经理、组织上下级都由输入给出，不读取真实人员、组织负责人或账号绑定（清单 7）；输入按条件字段类型校验，格式错误返回 400（X-18）；按对象仿真对复刻命中流程继续核算能否提交（X-17）。
- **出厂预置**（DEC-018 / DEC-094）：`POST /presets/install` 幂等、并发安全；每个审批类型一条草稿：调动照搬已取证结构；离职带“流程编码 = DimissionProcessNew”条件；其余类型为“部门负责人审批 → HRBP 审核”兜底草稿，节点结构待取证（#38）。异常管理员由租户指定后发布。

## 接口

`/api/tenant/approval`：`GET /types`；`GET|POST /processes`；`GET /processes/:id`；`PUT /processes/:id/draft`；`POST /processes/:id/{versions,publish,discard,simulate}`；`POST /presets/install`；`POST /exception-admins/handover`；`POST /simulate`；`GET /todos`；`GET /notifications`；`GET /instances?role=initiated|participated&businessId=`；`GET /instances/:id`；`GET /instances/:id/{tasks,logs}`（分页）；`GET /admin-logs`；`POST /tasks/:id/{approve,reject,transfer,add-sign,cc,retrieve,edit}`；`POST /instances/:id/{urge,withdraw,resubmit,admin-transfer,admin-intervene}`（干预 `kind` 为 `reassign` 改派或 `jump` 跳转节点）。

任职申请仍用原入口 `POST /api/tenant/employment/businesses/:id/submit`（请求体为空对象，流程编码由服务端派生），提交即在同一事务里发起审批；撤回、删除同步结束在途实例。员工信息变更的同单修正经 `POST /instances/:id/resubmit` 的 `fields` 提交。

## 验收

| AC / 清单 | 测试文件 | 说明 |
|---|---|---|
| AC-APV-01~04、13、15 | `AC-APV-01-04-13-15-routing.test.ts` | 五种表达式、内建机制、首节点为空、自审 |
| 清单 6/15/16/17/19/21，X-14，C-非3/5 | `AC-APV-04-routing-rules.test.ts` | 空节点、异常管理员回避与交接、管理员本人、重新匹配、优先级、无账号 |
| AC-APV-05~09、18、19、AC-TRF-29 | `AC-APV-05-09-18-19-versions.test.ts` | 版本、废弃、优先级、发布校验、类型隔离 |
| AC-APV-11、12，清单 7，X-17/18 | `AC-APV-11-12-simulation.test.ts` | 虚拟数据仿真且无副作用 |
| AC-APV-14、16、17、20、AC-TRF-28 | `AC-APV-14-16-17-20-actions.test.ts` | 盲审、驳回与重提、转交 / 加签 / 催办 / 撤回、管理员动作、幂等与 409 |
| 清单 2~5，C-非4，X-13 | `AC-APV-14-fields.test.ts` | 字段编辑权、完整快照、编辑后与自动跳过前的盲审、日志投影 |
| 清单 1/10/11/14，C-非5 | `AC-APV-TRF-28-concurrency.test.ts` | 审批中单据、撤回入口、加锁顺序、流程编码、催办频率 |
| 清单 9/22 | `AC-APV-SUB-03-personnel.test.ts` | 子集历史版本、同单修正重提 |
| 清单 20/26，X-15/16 | `AC-APV-node-actions.test.ts` | 抄送、审批人撤回、前 / 后加签、催办三态、重提动作 |
| 清单 18/24/25，X-20/21 | `AC-APV-capacity-config.test.ts` | 容量与分页、去 N+1、同编码并发、草稿预置、配置权 |
| AC-TRF-05/06（审批侧）、11、12、21 | `AC-APV-TRF-11-12-21.test.ts` | 审批中编辑两种形态、原值开关、审批通过 ≠ 生效 |
| AC-PRM-29，清单 8/23 | `AC-APV-PRM-29.test.ts` | 最小披露、无数据范围、标题、意见可见范围 |
| 平台约定，清单 12/13 | `AC-APV-platform.test.ts` | 租户隔离、审计与 outbox、权限目录、人员自助申请挂接 |

未覆盖：AC-APV-10（时效，DEC-035 首版不做，只预留字段）；AC-TRF-06 中“到生效日由定时任务转生效”属 R1-T08；管理委托（DEC-064 首版不做）；会签节点的并加签（首版节点为单人审批）。

## 需取证

| 编号 | GitHub | 处理 |
|---|---|---|
| Q-M0-38 | [#28](https://github.com/Avatar0327/italent-replica/issues/28) | 已取证（`14` §11.1）；预置离职用 `DimissionProcessNew`，其余类型编码待按 §11.1 对齐（见“与 main 新取证的差异”） |
| Q-M0-39 | [#29](https://github.com/Avatar0327/italent-replica/issues/29) | 已取证（`14` §11.2） |
| Q-M0-40 | [#30](https://github.com/Avatar0327/italent-replica/issues/30) | 用户已选 D-022①：首版不做子集审批中编辑，与本 PR 一致 |
| Q-M0-42 | [#32](https://github.com/Avatar0327/italent-replica/issues/32) | 已取证，与 DEC-102 一致 |
| Q-M0-43 | [#33](https://github.com/Avatar0327/italent-replica/issues/33) | 用户已选 D-023①（跳过 + 同意），待登记 DEC 后实现“跳过”结果 |
| Q-M0-44 | [#34](https://github.com/Avatar0327/italent-replica/issues/34) | 部分取证；在职无账号 / 账号停用仍按 DEC-098 视为审批人为空 |
| Q-M0-45 | — | 用户已选 D-020②（重提不重新匹配），与本轮按 DEC-093 实现的重新匹配相反，待登记 DEC 后调整 |
| Q-M0-46 | — | 已取证，与 DEC-095 一致 |
| Q-M0-47 | — | 用户已选 D-021②（“本节点看不到审批记录”开关），与本轮按 DEC-100 实现的开关模型不同，待登记 DEC 后调整 |
| 新 | [#37](https://github.com/Avatar0327/italent-replica/issues/37) | 审批人撤回的时限与效果；首版以“其后尚无人工处理”为界 |
| 新 | [#38](https://github.com/Avatar0327/italent-replica/issues/38) | 各业务类型预置流程的节点结构；首版为兜底草稿 |
| 新 | [#39](https://github.com/Avatar0327/italent-replica/issues/39) | “历史相同审批人跳过”是否跨驳回轮次；首版只认本轮 |

## 迁移与跨模块文件

- `0025_approval.sql`（drizzle-kit 生成；0022~0024 缺 meta 快照，生成器重复列出的人员表语句已删除，本快照补齐完整 schema；同时为人员自助申请增加“已撤回”状态）与 `0026_approval_isolation.sql`（手写：RLS、授权、已发布版本只读、实例冻结、日志只追加、原值开关预置）。PR #36 尚未合并，0025 暂未调整。
- 第二轮：`0027_approval_round2.sql`（drizzle-kit 生成：实例业务版本与条件取值、节点新开关与催办三态、任务新状态 / 来源、通知 `cc`、抄送表、员工信息变更载荷版本表）；`0028_approval_round2_guards.sql`（手写：异常管理员未交接不得停用的触发器；两张新表的 RLS 与授权）。

模块外改动（只改挂接点，均列出）：

| 文件 | 改动 |
|---|---|
| `apps/api/src/app.ts` | 共享文件：追加一行 import 与一行路由注册 |
| `packages/db/src/schema/index.ts`、`packages/domain/src/index.ts` | 共享文件：各追加一行 export |
| `apps/api/src/modules/employment/approval-hooks.ts`（新增） | 任职侧审批挂接端口；第二轮去掉提交时的 `processCode` |
| `apps/api/src/modules/employment/routes.ts` | 提交 / 撤回 / 删除在同一命令里调用挂接端口；第二轮提交请求体收紧为空对象（清单 14） |
| `apps/api/src/modules/employment/transitions.ts` | 解决 `TODO(R1-T07)`：驳回后可在同一申请上重提或撤回（DEC-053） |
| `apps/api/src/modules/employment/write-service.ts` | 被驳回的申请可修改后重提；第二轮审批中 PATCH 返回 409，仅审批适配器可写（清单 1） |
| `apps/api/src/modules/employment/context.ts`、`apps/api/src/modules/permission/scope-resolver.ts` | 只改注释 |
| `apps/api/src/modules/permission/authorizer.ts`、`apps/api/src/modules/permission/module-access.ts` | 第二轮：字段权限解析可复用调用方事务（`getModuleViewableFieldsInTransaction`），避免审批事务内另开连接 |
| `apps/api/src/modules/personnel/approval-hooks.ts`（新增） | 人员侧审批挂接端口 |
| `apps/api/src/modules/personnel/request-routes.ts` | 自助申请与审批实例同事务创建 |
| `apps/api/src/modules/personnel/change-requests.ts` | 审批撤回端口；第二轮新增载荷版本、同单修正 `correctChangeInTransaction`、落地取当前版本（DEC-099） |
| `packages/db/src/schema/personnel.ts` | 自助申请状态增加 `withdrawn`（0025）；第二轮新增 `personnel_change_request_versions`（0027） |
| `tests/acceptance/AC-EMP-state / AC-EMP-platform / AC-EMP-inheritance-boundaries / AC-SUB-03-requests` | 只在夹具中安装每个审批类型的已发布兜底流程；断言未改 |
| `tests/acceptance/AC-PRM-employment-scope.test.ts` | 只改注释 |

参考 `reference/`：未参考。
