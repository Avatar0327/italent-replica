# F-066 IDP 流程干预：转交：路由权限声明

> 依据：规格 `28` IDP-R16 与“补充：流程干预”（Q-M0-115 ⑥）；DEC-063、DEC-321、DEC-329；F-048 设计 §6 #17 / #20。
> 格式沿用 F-039 的逐路由声明与 F-047、F-048 PR-2 路由声明。
> 范围：新增 1 条路由；不改现有路由、不新增迁移。

## 1. 共用契约

- 应用 `IDP`，对象 PLAN = `IDP.Idp`（计划对象）。转交复用审批 `adminAct`（kind = `transfer`），转交当前运行阶段审批实例的当前待办。
- 权限：PLAN update 数据操作权 + 新按钮 `transfer`（level = detail，requires = update，登记在 `packages/domain/src/idp/catalog.ts`）；
  数据范围按用户 × IDP（DEC-043）解析，缺省为空；范围外与不存在同为 `404 NOT_FOUND`（与跳转一致）。
- 本人回避（DEC-321 / F-048 §6 #17、#20）：不查实时账号绑定，由 `adminAct` 按发起 / 重提时冻结的主体集合判定（I′）：
  计划所有者（发起人）可干预；计划员工本人及冻结的 U(S) 回避，`403 APPROVAL_ADMIN_SELF`；冻结之后才首次绑定到该员工的所有者本轮不追溯。
- 转交目标校验全部由 `adminAct` 判定，IDP 不另写一套：目标须是有效的租户成员（`400 APPROVAL_USER_INVALID`）、
  不在节点开启回避时的冻结主体集合内（`409 APPROVAL_SELF_REVIEW`，由节点 `avoidSubjects` 开关决定；预置 IDP 节点未开启）、
  不是同节点其他办理人。转给自己必须填写原因（`400 APPROVAL_REASON_REQUIRED`）。
- REV = 缺 If-Match `400 REVISION_REQUIRED`；计划 revision 不符 `409 REVISION_CONFLICT`。IDEM = 缺命令键
  `400 IDEMPOTENCY_KEY_REQUIRED`；同键异内容 `409 IDEMPOTENCY_CONFLICT`；同键同内容重放返回原结果，不重复转交、不重复审计。
- 业务变更（待办转交、计划 revision +1）、审批侧审计 `approval.admin.transfer`（原审批人、新审批人、原因，DEC-063）、
  计划审计（intervention = `transfer`）与命令台账在同一租户事务中写入。

## 2. 逐路由声明

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 写足迹 | 拒绝码 |
|---|---|---|---|---|---|---|---|
| POST | `/api/tenant/idp/plans/:id/transfer` | object | PLAN；update；transfer@detail | point id → 计划行锁 → HR 范围（范围外 404）→ revision；返回前按当前范围复核 | 请求：`toUserId`（UUID，必填）、`taskId`（可选，缺省取当前阶段唯一待办；多条待办时必填）、`reason`（可选，≤500）；响应为计划详情，按 PLAN 字段查看权裁剪 | 计划行 + 审批任务 / 实例 + 计划审计 + 审批审计 + 命令台账 | 无按钮 `403`；范围外 `404`；无运行阶段 `409 IDP_NO_RUNNING_STAGE`；多条待办未指定 `400 IDP_TRANSFER_TASK_REQUIRED`；待办已关闭 `409 APPROVAL_TASK_CLOSED`；本人回避 `403 APPROVAL_ADMIN_SELF`；目标回避 `409 APPROVAL_SELF_REVIEW` |

## 3. 审计登记

- 计划审计沿用 `idp.plan.update`，前后值只用计划对象已登记的字段：`intervention = transfer`、`reason`、`stageId`；
  新旧审批人账号不进计划审计（避免经计划字段权限绕过审批侧可见性），只在审批实例的 `approval.admin.transfer` 里。
- `intervention` / `reason` / `stageId` 已在 PLAN 的审计展示字段登记，无新增字段，字段可见性登记不变。

## 4. 查看人 × 接口 × 字段

| 查看人 | 转交接口 | 审计 |
|---|---|---|
| 范围内、有 update 权与 transfer 按钮的 HR | 成功，返回按字段权限裁剪的计划详情 | 按既有 PLAN 审计可见性展示 intervention / reason |
| 无 transfer 按钮 | 403 | — |
| 范围外 / 空范围 | 404 | — |
| 计划所有者（发起人） | 可转交（DEC-321①） | 同上 |
| 计划员工本人（冻结 U(S)） | 403 APPROVAL_ADMIN_SELF | 无记录 |
