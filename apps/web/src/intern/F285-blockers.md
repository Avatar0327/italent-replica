# F-285 开发前契约核对：等决定

核对基线：`origin/main` `05b91a67d4be8166eda6646a7995ba3e8d051e03`。
本文件仅记录阻塞，尚未修改产品代码、开放入口或编写新验收测试。

## 1. 申请入口缺少服务端可用动作

- `apps/api/src/modules/employment/intern-routes.ts` 的 `registerInternViews` /
  `trimInternItems` 未返回 `availableActions`。
- `apps/web/src/intern/model.ts` 的 `entriesFor` 仍按视图、状态和权限快照推导入口。
- F-285 要求申请入口由服务端动作决定，不允许前端自行推断。
- 在途 [PR #483](https://github.com/Avatar0327/italent-replica/pull/483)
  核对 head 为 `9a035d93384f624fd69e1acc8e18651b045dde28`，状态 OPEN。
  其 `intern-actions.ts` 的动作集合只有 `regularize`、`terminate`、`withdraw`、`revoke`；
  `regularize` 明确对应直接转正专用接口，尚无申请入口动作。因此仅等待该 head 合入仍不足以开放申请。

选项（作用对象均为复刻系统）：

1. 推荐：由总编排安排后端契约补充申请专用动作，按通用申请写入口校验权限与资格；契约合入后继续 F-285。
2. 另行明确授权前端使用替代入口判定规则，同时修订本片“只按服务端动作显示”的验收要求。

不将直接转正动作自行解释为申请动作；本片不修改后端。

## 2. 省略是否有试用期的口径与派发不一致

- 派发写“不填是否有试用期 = 无试用期”。
- `apps/api/src/modules/employment/entry-options.ts` 的 `assertInternRegularizationEntry`
  在缺少 `probation` 时明确返回 `400 VALIDATION_FAILED`，`details.reason=PROBATION_REQUIRED`。
- `tests/acceptance/AC-IN-F284-intern-reg-probation.test.ts` 已有相应 HTTP 验收：
  省略时申请与直接转正均拒绝；显式 `probation:false` 才是不带试用期。

选项（作用对象均为复刻系统）：

1. 推荐：确认沿用已合入后端与直接转正表单的必填口径，明确选择“否”提交 `probation:false`。
2. 保留派发中的“不填 = 无试用期”，由总编排明确默认值的责任边界及是否需要后端契约调整。

## 与原站的一致性

已阅读本机 R2f1 `spec.md`：直接转正表单有员工信息、任职信息、试用期信息、汇报关系、合同协议五区；
是否有试用期及有试用期时的月数标为必填，月数为 1～6。
本次尚未进行截图视觉核对，也未验证申请表单的默认值，均标记为未验证。
截图、原站人员数据不进入仓库或 PR。

## 恢复条件

总编排确认上述两项后，重新 fetch 并合入 main，核对最终申请动作与读写契约，
再按“单独提交旧实现下失败测试 → 复用直接转正表单实现 → 本地验证与自检”的顺序继续。
