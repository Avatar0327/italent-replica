# R1-T07 审批中心交付说明

核对日期：2026-10-03。实现依据为 `AGENTS.md`、派发单 §1/§5、路线图 R1-T07 行、`03_需求基线` REQ-APV-001~004、`02_业务建模/14` §1–§10、验收表 AC-APV-*（含 13~20）、AC-TRF-11/12、AC-PRM-29，遵循 DEC-017/018/035/036/053/054/057/058/059/063/064/068/069/070。基线为 `origin/main` 的 `e9b269c`。

## 对象与数据模型

| 表 | 作用 |
|---|---|
| `approval_processes` | 流程稳定对象：编码（租户唯一）、审批类型、对象、状态（可用 / 废弃）、当前生效版本、最新版本号、预置键 |
| `approval_process_versions` | 流程版本：名称、分组、优先级、兜底标记、异常管理员、催办开关、高级表达式；草稿 → 发布，已发布只读（触发器） |
| `approval_process_conditions` | 发起条件条目：白名单字段路径 + 运算符 + 单值 / 值列表 |
| `approval_process_nodes` | 节点：审批人表达式、审批人为空策略、相同 / 历史相同审批人跳过、节点表单字段、可编辑字段与编辑形态、转交 / 加签 / 催办开关、驳回意见必填（DEC-059 出厂关）、驳回后重提方式；时效字段只预留（DEC-035） |
| `approval_node_message_rules` | 消息规则：触发动作 → 渠道 → 模板 → 接收人表达式 |
| `approval_instances` | 实例：绑定发起时版本 ID（触发器禁止改版本与业务归属）、业务类型与业务 ID、异动员工、发起人、流程编码、状态、当前节点、驳回节点、轮次、revision |
| `approval_tasks` | 任务：节点、轮次、审批人、来源（解析 / 自审跳过 / 异常管理员 / 跳过类 / 转交 / 加签 / 管理员转交 / 管理员干预 / 盲审转交）、状态、异常管理员与“管理员转交自审”标记 |
| `approval_instance_logs` | 节点日志 / 审批记录，只追加 |
| `approval_notifications` | 待办与消息通知，按接收人过滤，状态 pending / sent / failed / unknown |
| `approval_outbox` | 领域事件，与命令同事务 |

全部表带 `tenant_id` 并 ENABLE/FORCE RLS；人员引用指向租户成员或任职员工主档。所有写命令带 If-Match（revision，冲突 409）与 Idempotency-Key，业务写入、字段级审计、outbox、命令台账同一事务。列表默认 50、最多 200；单实例任务与日志有上限。

## 规则落地

- **版本**（REQ-APV-001 R1~R3、R6）：草稿整体替换；已发布不能直接改（409 `APPROVAL_VERSION_PUBLISHED`），只能“编辑最新版本”以当前生效版本为底稿生成下一版草稿；发布只影响新实例；在途实例按冻结版本流转；列表同时给出当前生效版本与最新版本状态；废弃移出可用列表且不参与匹配。
- **发布校验**：发起条件为空且未声明兜底 → 400 `APPROVAL_CONDITION_REQUIRED`（DEC-018）；未配置异常管理员 → 400 `APPROVAL_EXCEPTION_ADMIN_REQUIRED`（DEC-054）；至少一个节点；异常管理员须为有效成员。
- **匹配**（DEC-017）：先按审批类型过滤已发布的当前版本，再按优先级（越小越先）评估发起条件，兜底流程排在同类型条件流程之后，并列按流程编码确定性选择；同类型都不满足 → 409 `APPROVAL_PROCESS_NOT_MATCHED`“没有可用的××流程”，不跨业务兜底。
- **发起条件**：字段路径白名单（任职：流程编码、业务类型、工号、姓名、变动前 / 本条记录的部门 / 职务 / 职位 / 职级、生效日期；员工子集变更：流程编码、工号、姓名、当前部门、变更子集），运算符 eq / ne / in / not_in / is_empty / not_empty / in_org_tree（包含下级，按行政维度祖先链），高级表达式支持 and / or / not / 括号。不做通用表达式引擎（R3-T00），白名单即扩展点。
- **审批人**（REQ-APV-002）：五种表达式——流程所有者（发起人）、最新任职记录部门负责人（调出方）、本条记录部门负责人、本条记录部门 HRBP、上溯一级组织负责人；组织负责人 / HRBP 取业务日期的现行版本，人员经账号绑定落到用户。
- **三种内建机制 + 自审**：审批人为空 → 首节点提交即报错（409 `APPROVAL_FIRST_NODE_EMPTY`，不建实例，申请保持草稿）；中间节点按配置转异常管理员（默认）/ 自动跳过 / 自动同意。自审（发起人或异动本人）→ 跳过且不计同意，转其直线经理；经理为空、仍是本人或已在本单审批链上 → 异常管理员；自审优先于相同审批人跳过（DEC-068）。相同 / 历史相同审批人跳过结果为“同意”。全部写节点日志。
- **节点动作**：同意；驳回（驳回到发起人，实例“退回”，任职申请变为 rejected，可在同一单修改后重提：按驳回节点配置从首节点重走或直接回到驳回节点，DEC-053）；转交 / 加签（节点开关，目标不得为发起人或异动本人）；发起人撤回（AC-TRF-28：实例撤回、任职申请回草稿；员工子集变更申请关闭为“已撤回”）；催办（流程与节点开关，通知当前未审批人）；审批中编辑（独立【编辑】保存后仍停在本节点 / 【编辑并同意】提交即通过，只能改节点开放且本人可查看的字段）。
- **管理员**（DEC-063 / DEC-070）：持有 `ApprovalInstance` 的转交 / 干预按钮且实例员工在其数据范围内，才能转交或干预（改审批人、跳转节点）；不能以他人名义同意 / 驳回（403）；转交给自己须填理由，任务与日志标注“管理员转交自审”，审计动作 `approval.admin.self_transfer`，可经 `/admin-logs?adminSelfTransfer=true` 筛选；每次管理动作单独写审计（操作人、原审批人、新审批人、原因）。
- **最小披露**（DEC-057）：详情只显示查看人所在节点的表单字段，再按其对业务对象的可查看字段裁剪；变更前原值取版本链上一条，受租户开关 `approval.show_original_values`（出厂开）控制；只有参与人或范围内管理员能打开详情；审批不产生任何数据范围。
- **盲审**（DEC-058 / DEC-069）：本单变化字段中有审批人不可见的字段 → 同意、驳回都返回 403 `APPROVAL_BLIND_REVIEW`，在办任务自动转异常管理员并记日志，流程不卡死。
- **仿真**（DEC-036）：单流程仿真（已发布 / 最新版本，虚拟数据 + 真实组织数据，输出条件核算、节点状态 pass / warning / exception、预计审批人、消息接收人、能否发起）；按对象仿真（同对象全部流程的条件核算，同时给出原站“按实体、跨类型按优先级”与复刻“先按类型”的命中流程）。只读，不建实例、不发消息、不生成待办。
- **出厂预置**（DEC-018）：`POST /presets/install` 幂等安装“标准调动流程”：按 `14` §2 的四个节点（调出负责人 → 调入 HRBP → 调入负责人 → 一级组织负责人），带“流程编码 = TransferProcessNew”条件、相同 / 历史审批人跳过与 HRBP 节点的转交 / 加签 / 消息规则；异常管理员需租户指定，故为草稿。

## 接口

`/api/tenant/approval`：`GET /types`；`GET|POST /processes`；`GET /processes/:id`；`PUT /processes/:id/draft`；`POST /processes/:id/{versions,publish,discard,simulate}`；`POST /presets/install`；`POST /simulate`；`GET /todos`；`GET /notifications`；`GET /instances?role=initiated|participated&businessId=`；`GET /instances/:id`；`GET /admin-logs`；`POST /tasks/:id/{approve,reject,transfer,add-sign,edit}`；`POST /instances/:id/{urge,withdraw,resubmit,admin-transfer,admin-intervene}`。

任职申请仍用原入口 `POST /api/tenant/employment/businesses/:id/submit`（可带 `processCode`，缺省按审批类型取标准编码），提交即在同一事务里发起审批；撤回、删除同步结束在途实例。

## 验收

| AC | 测试文件 | 说明 |
|---|---|---|
| AC-APV-01~04、13、15 | `AC-APV-01-04-13-15-routing.test.ts` | 五种表达式、三种内建机制、首节点为空、自审 |
| AC-APV-05~09、18、19、AC-TRF-29、DEC-018 预置 | `AC-APV-05-09-18-19-versions.test.ts` | 版本、废弃、优先级、发布校验、类型隔离 |
| AC-APV-11、12 | `AC-APV-11-12-simulation.test.ts` | 两种仿真且无副作用 |
| AC-APV-14、16、17、20、AC-TRF-28 | `AC-APV-14-16-17-20-actions.test.ts` | 盲审、驳回意见必填与同单重提、转交 / 加签 / 催办 / 撤回、管理员转交与干预、幂等与 409 |
| AC-TRF-05/06（审批侧）、11、12、21 | `AC-APV-TRF-11-12-21.test.ts` | 审批中编辑两种形态、原值开关、审批通过 ≠ 生效 |
| AC-PRM-29 | `AC-APV-PRM-29.test.ts` | 最小披露、无数据范围 |
| 平台约定 | `AC-APV-platform.test.ts` | 租户隔离、审计与 outbox、权限目录、人员自助申请挂接 |

未覆盖：AC-APV-10（时效，DEC-035 首版不做，只预留字段）；AC-TRF-06 中“到生效日由定时任务转生效”属 R1-T08（本任务保持「审批通过」）；管理委托（DEC-064 首版不做）；节点抄送（`14` §8.2 `isCopySend`）与审批人撤回（`isRetrieve`）不在本轮动作清单内，未实现。

## 需取证

| 编号 | GitHub | 处理 |
|---|---|---|
| Q-M0-38 | [#28](https://github.com/Avatar0327/italent-replica/issues/28) | 原站审批类型字典的完整编码 / 名称与各类型标准流程编码；首版按任职业务类型一一对应，调动、离职取已证实的编码 |
| Q-M0-39 | [#29](https://github.com/Avatar0327/italent-replica/issues/29) | 各审批详情页视图（TransferDetailView 等）的确切字段；预置流程暂取调动表单“任职调整”区块 |
| Q-M0-40 | [#30](https://github.com/Avatar0327/italent-replica/issues/30) | 员工子集变更审批中编辑的字段与落地口径；首版不开放 |
| Q-M0-41 | [#31](https://github.com/Avatar0327/italent-replica/issues/31) | 加签类型（前 / 后 / 并加签）；首版按“同节点全部同意才通过” |
| Q-M0-42 | [#32](https://github.com/Avatar0327/italent-replica/issues/32) | 流程配置与“流程管理员”由哪类管理员身份持有；首版按身份对象权限按钮 |
| Q-M0-43 | [#33](https://github.com/Avatar0327/italent-replica/issues/33) | 相同 / 历史相同审批人跳过的其他“跳过后结果”；首版只实现“同意” |
| Q-M0-44 | [#34](https://github.com/Avatar0327/italent-replica/issues/34) | 审批人解析到无账号 / 账号停用人员时的处理；首版视为审批人为空 |

## 迁移与跨模块文件

新增 `0025_approval.sql`（drizzle-kit 生成；0022~0024 缺 meta 快照，生成器重复列出的人员表语句已删除，本快照补齐完整 schema；同时为人员自助申请增加“已撤回”状态）与 `0026_approval_isolation.sql`（手写：RLS、授权、已发布版本只读、实例冻结、日志只追加、原值开关预置）。

模块外改动（只改挂接点，均列出）：

| 文件 | 改动 |
|---|---|
| `apps/api/src/app.ts` | 共享文件：追加一行 import 与一行路由注册 |
| `packages/db/src/schema/index.ts`、`packages/domain/src/index.ts` | 共享文件：各追加一行 export |
| `apps/api/src/modules/employment/approval-hooks.ts`（新增） | 任职侧审批挂接端口（任职模块不 import 审批模块，未注册时提交 fail-closed） |
| `apps/api/src/modules/employment/routes.ts` | 提交 / 撤回 / 删除在同一命令里调用挂接端口；提交可带 `processCode` |
| `apps/api/src/modules/employment/transitions.ts` | 解决 `TODO(R1-T07)`：驳回后可在同一申请上重提或撤回（DEC-053）；approve 注释改为审批中心调用 |
| `apps/api/src/modules/employment/write-service.ts` | 被驳回的申请可修改后重提（DEC-053） |
| `apps/api/src/modules/employment/context.ts`、`apps/api/src/modules/permission/scope-resolver.ts` | 只改注释：已由审批详情实现的 `TODO(R1-T07)` |
| `apps/api/src/modules/personnel/approval-hooks.ts`（新增） | 人员侧审批挂接端口 |
| `apps/api/src/modules/personnel/request-routes.ts` | 自助申请与审批实例同事务创建 |
| `apps/api/src/modules/personnel/change-requests.ts` | 解决 `TODO(R1-T07)` 注释；新增审批撤回端口 `withdrawChangeInTransaction` |
| `packages/db/src/schema/personnel.ts` | 自助申请状态增加 `withdrawn`（迁移 0025） |
| `tests/acceptance/AC-EMP-state / AC-EMP-platform / AC-EMP-inheritance-boundaries / AC-SUB-03-requests` | 只在夹具中安装每个审批类型的已发布兜底流程（提交现在必须匹配流程，DEC-017）；断言未改 |
| `tests/acceptance/AC-PRM-employment-scope.test.ts` | 只改注释（指向 AC-APV-PRM-29） |

参考 `reference/`：未参考。
