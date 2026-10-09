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
- 转交目标先由本入口校验范围：目标须是已绑定员工，且该员工在操作人的 IDP 范围内（IDP-R16“受管理单元限制”）。账号不存在、
  未绑定员工的纯账号（待产品确认，先按拒绝）、范围外三种情况同为 `404 NOT_FOUND`，不暴露存在性。`adminAct` 本身不看操作人范围，
  审批中心通用的 `admin-transfer / admin-intervene` 不在本 PR 改动范围（另开 F）。
- 其余目标校验由 `adminAct` 判定，IDP 不另写一套：目标须是有效的租户成员（`400 APPROVAL_USER_INVALID`）；
  目标回避同时受节点 `avoidSelf`（发起人，即所有者）和 `avoidSubjects`（冻结主体集合）两个开关影响，命中 `409 APPROVAL_SELF_REVIEW`
  （预置 IDP 节点两项都未开启）；不能转给同节点其他在办的办理人（`400 APPROVAL_ALREADY_NODE_ASSIGNEE`，会签场景）。
  转给自己必须填写原因（`400 APPROVAL_REASON_REQUIRED`），转给自己时审批侧审计动作是 `approval.admin.self_transfer`。
- REV = 缺 If-Match `400 REVISION_REQUIRED`；计划 revision 不符 `409 REVISION_CONFLICT`。IDEM = 缺命令键
  `400 IDEMPOTENCY_KEY_REQUIRED`；同键异内容 `409 IDEMPOTENCY_CONFLICT`；同键同内容重放不重复转交、不重复审计；重放响应是重新读取并按当前字段权限裁剪的计划详情，不是原响应快照。
- 业务变更（待办转交、计划 revision +1）、审批侧审计 `approval.admin.transfer`（原审批人、新审批人、原因，DEC-063）、
  计划审计（intervention = `transfer`）与命令台账在同一租户事务中写入。

## 2. 逐路由声明

| 方法 | 路径 | 类型 | 对象·操作·按钮 | 范围 | 字段 | 写足迹 | 拒绝码 |
|---|---|---|---|---|---|---|---|
| POST | `/api/tenant/idp/plans/:id/transfer` | object | PLAN；update；transfer@detail | point id → 计划行锁 → HR 范围（范围外 404）→ revision；返回前按当前范围复核 | 请求：`toUserId`（UUID，必填）、`taskId`（可选，缺省取当前阶段唯一待办；多条待办时必填）、`reason`（可选，≤500）；响应为计划详情，按 PLAN 字段查看权裁剪 | 计划行 + 审批任务 / 实例 + 计划审计 + 审批审计 + 命令台账 | 无按钮 `403`；范围外 `404`；转交目标不存在 / 未绑定员工 / 范围外 `404 NOT_FOUND`；无运行阶段 `409 IDP_NO_RUNNING_STAGE`；多条待办未指定 `400 IDP_TRANSFER_TASK_REQUIRED`；待办已关闭 `409 APPROVAL_TASK_CLOSED`；本人回避 `403 APPROVAL_ADMIN_SELF`；目标回避 `409 APPROVAL_SELF_REVIEW` |

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
| 范围内 HR，转交目标不在其 IDP 范围 / 未绑定员工 / 账号不存在 | 404 NOT_FOUND（三者不可区分），计划与待办不变 | 无记录 |
| 计划所有者（发起人） | 可转交（DEC-321①） | 同上 |
| 计划员工本人（冻结 U(S)） | 403 APPROVAL_ADMIN_SELF | 无记录 |
