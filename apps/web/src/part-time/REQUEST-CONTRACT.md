# FE-R2d2b 开工契约核对（待总编排决定）

核对基线：`origin/main d589feec305411074aa524035f10beb50547516a`。
本文件只记录开发依赖，不登记新接口、不定义前端状态机。

## 阻断项 D2B-01：缺少逐单可用动作

派发验收②要求申请详情的修改、提交、撤回、撤销、删除按服务端可用动作显示，前端不自推状态。
派发同时禁止本片修改 `apps/api/`、新增路由或授权。

已核对的当前实现：

- `apps/api/src/modules/employment/part-time/request-read.ts` 的 `PartTimeRequestDto`、`requestDto`、
  `loadPartTimeRequestDetail` 返回申请状态、版本和字段，不返回逐单可用动作。
- `apps/api/src/modules/employment/part-time/request-routes.ts` 的申请 GET 仅拼接裁剪后的申请、主职与员工信息。
- `apps/api/src/modules/employment/context.ts` 的 `trimEmploymentResponse` 只裁剪响应，不计算可用动作。
- `apps/web/src/foundation/permission-model.ts` 的 `ObjectPermission` 是对象级操作、字段、按钮权限，
  不表达当前单据的状态、发起人资格和写范围。
- `apps/api/src/modules/employment/part-time/request-service.ts` 的 `submitRequest` / `withdrawRequest`
  在服务端执行 `assertAction`、`assertInitiator`、`requireRequestScope`；这些约束没有对应的读侧动作投影。
- 兼职列表的 `queries.ts`、记录的 `read.ts` 同样未给逐行可用动作。工具栏可读取对象按钮权，
  但这不能替代申请详情的逐单动作契约。

真实触发场景：两名具有相同对象按钮权的 HR 查看同一张草稿，其中只有原发起人可提交；
前端仅靠对象权限快照无法区分。若按按钮权显示，非发起人也会看到提交；若所有缺动作的记录都隐藏入口，
原发起人也无法提交。改由前端依据状态和身份推导又违反派发验收②。

## 需要产品决策的问题

以下两种方案均只改复刻系统，不操作北森测试租户。

1. **推荐：先补后端契约片。** 由总编排另派，在既有读取入口返回当前用户的逐单可用动作，
   统一核对状态、原发起人、对象操作、按钮及写范围；明确动作元数据的裁剪规则。
   本片待契约合入后 `merge:main`，按真实返回形态写失败测试并继续前端实现。
2. **调整派发约束。** 明确允许前端依据已授权的状态、身份与权限契约推导动作，
   同时补齐缺少的字段和裁剪行为约定。此方案会改变“前端不自推状态”的要求，不由开发窗口自行采用。

待明确动作字段名、枚举与返回入口后，前端才能编写稳定的动作夹具；当前不虚构 `actions` 字段。
本次尚未编写功能失败测试或产品实现，不声称已覆盖 FE-R2d2b 的验收点。

## 后续实现边界

三类申请及其生命周期、F-247 提交与审批同意前确认仍属于本片；提交与恢复接 F-123。
FE-R2d2a 的直接写入、PT-6 调动调整区、PT-7 负责人联动均不在本片。
审批中心按节点 editableFields 渲染业务字段的通用能力由 F-267 后补，本片只登记同意前确认。
原站资料仅在本机只读核对，不复制进仓库或 PR。
