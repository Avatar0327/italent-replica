# F-047 IDP 结束通知模板：路由权限声明

> 依据：规格 `28` §1、F-047，DEC-307、DEC-309④、DEC-318、DEC-321。
> 格式沿用 F-039 的逐路由声明与已合并的 R3-T01、F-038 路由声明。
> 范围：现有流程列表、详情、新建、修改、删除共 5 条路由的子流程配置字段扩展；不新增路由。

## 1. 共用契约

- 应用 `IDP`；PROC = `IDP.IDPProcess`，SUB = `IDP.SubProcess`。
- 新字段 `endNoticeTemplate` 属于 SUB 的可写字段，值为去除首尾空白后的非空模板编码，最长 200 字符，或 `null`。
  字段可省略：新建子流程省略时存 `null`；修改既有子流程省略时保留旧值；显式 `null` 表示清空。
  空字符串、仅空白、超过长度或其他类型返回 `400 VALIDATION_FAILED`。
- 配置对象仍以父流程的所属组织 `orgId`、向下公开 `publicDown`、创建人 `createdBy` 为范围锚点。
  数据范围按用户 × IDP 解析，缺省为空，复用 `idpScope / readableSql / requireReadable / requireEditable`。
  列表在 SQL 分页之前过滤范围；详情中不存在与范围外同为 `404 NOT_FOUND`。
  仅因向下公开可见的流程可查看与选用，写入返回 `403 FORBIDDEN`，reason `IDP_PUBLIC_DOWN_READONLY`。
- 响应复用 `processPresenter / subProcessShown`：顶层按 PROC 字段权限；只有 PROC 的 `subProcesses`
  可见且 SUB 有查看权时输出子流程；子流程各字段再按 SUB 当前字段查看权裁剪。
  `endNoticeTemplate` 没有独立对象、按钮或范围，首次写响应与幂等重放同样走当前投影。
- 写入口要求 PROC 数据操作权与按钮；子流程新建 / 修改 / 删除权限在事务内按实际变化校验。
  修改或清空结束通知模板须有 SUB update 与该字段编辑权；未变化的字段不额外要求编辑权。
  PATCH 中子流程实际变化仍须有 PROC.`subProcesses` 编辑权；嵌套权限随命令结果记录，重放再次复核。
- REV = 缺或非法 `If-Match` 时 `400 REVISION_REQUIRED`；revision 不符时 `409 REVISION_CONFLICT`；
  新建要求 revision = 0。IDEM = 缺 `Idempotency-Key` 时 `400 IDEMPOTENCY_KEY_REQUIRED`；
  同键异内容 `409 IDEMPOTENCY_CONFLICT`。命令指纹含 method / path / revision / 解析后的输入。
- 业务变更、字段级审计与命令台账在同一租户事务中写入。重放不重复写入；返回前先复核实际用到的嵌套权限，
  再按父流程当前行重新校验可编辑范围；删除后没有当前行时按删除时的受控快照归属判定当前可写性，
  最后按当前字段权限裁剪。
- 本任务补齐配置保存、编辑、读取与审计。没有新增通知触发时点、收件人、渠道、模板内容展开或发送规则；
  站内待办与现有通知能力继续按既有契约执行。DEC-307 的目标候选、DEC-318 的审批节点与发起人、
  DEC-321 的所有者干预与已保存目标重放口径保持既有实现。

## 2. 逐路由声明

路径以 `/api/tenant/idp` 开头，批次 A。表中谓词与定位器对应 `apps/api/src/modules/idp/` 现有 helper。

| 方法 | 路径 | 批次 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 写足迹 | 其他 |
|---|---|---|---|---|---|---|---|---|
| GET | `/processes` | A | object | PROC；view；无按钮 | list `idp.readableSql`，所属组织 / 创建人 / 向下公开，分页前过滤 | projector `idp.processPresenter`，顶层 PROC、嵌套 SUB；`subProcesses[].endNoticeTemplate` 按 SUB 字段查看权 | — | page / pageSize / enabled 非法 400 VALIDATION_FAILED；列表信封沿用 `listEnvelope` |
| GET | `/processes/:id` | A | object | PROC；view；无按钮 | point id → 当前父流程 → `idp.requireReadable`；范围外与不存在同为 404 NOT_FOUND | 同列表投影，未配置时字段可见才返回 null | — | UUID 规范为小写；非法标识 400 VALIDATION_FAILED；ETag 为流程 revision |
| POST | `/processes` | A | all[object, object] | PROC；create；create@list；嵌套 SUB create | guard `idp.requireCreatable(process)` + 同租户所属组织存在；返回前按新流程当前行 `requireEditable` | 输入严格结构；PROC 顶层字段与 SUB 新建字段分别检查编辑权，包含显式提交的 endNoticeTemplate；返回按当前 PROC / SUB 查看权投影 | fields body → `idp.createProcess` / `idp.runIdpCommand`；父流程 + 子流程 + 审计同事务；ledger single | REV、IDEM；子流程数量及开启规则沿用现有校验；201；ETag |
| PATCH | `/processes/:id` | A | object（嵌套写按实际变化附加 SUB 操作权） | PROC；update；update@detail；结束通知模板实际变化须 SUB update + 字段编辑权 | point id → 父流程行锁 → `idp.requireEditable` → REV；子流程行锁；返回前按当前父流程复核 | 顶层 PROC；整组子流程实际变化检查 PROC.subProcesses 与 SUB 对应字段；省略保留、显式 null 清空；返回同列表投影 | fields body → `idp.updateProcess / replaceSubProcesses` / `idp.runIdpCommand`；仅变化段写子流程审计；ledger single | UUID 非法 400；REV、IDEM；被模板引用时，既有顺序 / 增删 / 开启方式限制不变；200；ETag |
| DELETE | `/processes/:id` | A | all[object, object] | PROC；delete；delete@detail；嵌套 SUB delete（无子流程也要求） | point id → 父流程行锁 → `idp.requireEditable` → REV；首次返回与重放按删除时的受控快照归属复核当前可编辑范围 | 无字段赋值，不要求模板字段编辑权；删除前 ProcessView 按当前 PROC / SUB 查看权投影，结束通知模板无查看权时省略 | retained snapshot → `idp.deleteProcess` / `idp.runIdpCommand`；父流程与级联子流程删除、删除快照审计同事务；ledger single | UUID 非法 400；REV、IDEM；被模板引用时 409 IDP_PROCESS_REFERENCED；200；无 ETag |

POST / PATCH 仍执行统一的同源与 JSON 请求校验；命令重放仍要求当前的 PROC 操作权、按钮、
实际使用过的 SUB 操作 / 字段编辑权与父流程可编辑范围。DELETE 沿用统一写请求校验与当前 PROC delete / SUB delete 权限，
删除响应和重放均按当前字段查看权裁剪受控快照。

## 3. 查看人 × 接口 × 字段

| 查看人 | 流程列表 / 详情 | 新建 / 修改 / 删除与重放 | 审计 |
|---|---|---|---|
| 有 PROC 查看权，范围内，且 PROC.subProcesses 与 SUB 查看权、SUB.endNoticeTemplate 查看权均满足 | 返回结束通知模板的当前值，未配置为 null | 另按 PROC 操作权、按钮与实际变化的 SUB 操作 / 字段编辑权校验 | 另需日志审计入口权、SUB 查看权、SUB 字段查看权与当前 IDP 范围 |
| 有流程查看权，缺 SUB.endNoticeTemplate 查看权 | 可见子流程里省略该字段 | 写入由编辑权独立判断；首次响应和重放仍省略该字段 | 模板值按 SUB 字段权限裁剪 |
| 缺 PROC.subProcesses 查看权，或缺 SUB 查看权 | 省略整段子流程 | 写入按对应编辑权判定；响应省略整段 | 缺 SUB 查看权不显示该子流程日志 |
| 有修改权，缺结束通知模板字段编辑权 | 按当前查看权读取 | 实际修改或显式清空 403 FORBIDDEN，业务 / revision / 审计不变；撤销该编辑权后原命令重放同样 403 | 不因修改权放宽审计查看 |
| 仅因向下公开可见 | 按查看与字段权限读取 | 403 FORBIDDEN，reason IDP_PUBLIC_DOWN_READONLY | 向下公开不放宽审计范围 |
| 范围外 / 空范围 | 列表过滤；详情 404 NOT_FOUND | 首次和重放按当前可编辑范围拒绝，业务不变 | 当前范围不满足时不显示 |
| 无 PROC 查看权 | 403 FORBIDDEN | 写入口另按操作权与按钮判断；返回不带无查看权的内容 | 按独立日志入口与 SUB 当前权限判断 |
| 其他租户下的流程 | 当前租户列表不带出，详情 404 | 404，业务不变 | 不显示 |

删除流程另须 PROC delete、delete@detail 与 SUB delete；结束通知模板字段的编辑权不替代或限制对象删除权，
但删除响应中的字段仍按当前查看权裁剪。

## 4. 审计登记

- 沿用 `idp.sub-process.create / update / delete`，objectType = `IDP.SubProcess`，objectId = 子流程 ID。
  模板编码作为子流程快照中的 `endNoticeTemplate` 字段，记录创建、实际修改与删除时的值；不存模板内容或发送数据。
- 父流程审计继续剥离嵌套 `subProcesses`，结束通知模板值只在 SUB 的快照中出现，防止经 PROC 字段权限绕过 SUB。
- `audit/visibility.ts` 已通过 `IDP_ORG_OBJECTS` 为 SUB 注册 `orgRule`，归属取日志中的父流程所属组织，
  “使用用户”按保留的 `idp.sub-process.create` 创建元数据判断。查看时重新解析 IDP 范围与 SUB 当前字段权限，
  删除后仍按受控快照和保留归属判断；本字段复用该规则，无新增审计类型。
- `ruleText` 仍为开启规则派生值，审计快照不记录它，读取仍绑定 `RULE_TEXT_SOURCES`（DEC-309④），
  结束通知模板字段不改变这条联动门禁。
