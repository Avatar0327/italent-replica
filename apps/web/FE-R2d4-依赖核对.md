# FE-R2d4：新增实习生依赖核对（等决定）

核对基线：`708feef3a9dd077ea23b77d5eeadcf19b2f80a23`。
需取证与待决登记：[issue #481](https://github.com/Avatar0327/italent-replica/issues/481)。

本片只允许改 apps/web。派发明确要求：发现后端缺口时，不改后端，在 Draft PR 留下【等决定】并结束。
当前仅登记依赖证据，没有实现表单、提交业务命令或修改后端，也没有达到交审条件。

## 阻塞：新增流程没有合同终止日写入契约

对应 B38 / A48、IN-R1、派发验收②③⑤和 R2f1 的合同终止日必填结论。

| 核对位置 | 当前行为 | 对本片的影响 |
| --- | --- | --- |
| `apps/api/src/modules/employment/routes.ts` 的 `registerEmployees` | 建档请求严格只接受 code、name、loginEmail | 人员证件等字段须另走人员信息写入，不存在完整建档表单的一次保存契约 |
| 同文件的 `registerEmployeeBusinessCreate` | 通用入职支持 hire / rehire，fields.employType 支持 intern | 实习雇佣关系本身没有缺口 |
| `apps/api/src/modules/employment/entry-options.ts` 的 `KEYS` | 仅接 pendingEntry、probation、probationMonths、probationEndDate | 请求不能传入 pendingContract |
| `apps/api/src/modules/employment/fields.ts` 的 `businessSchema` / `presetFieldsSchema` | 两层严格白名单均无合同终止日 | 顶层 contract / contractEndDate、fields.contractEndDate 均被拒绝 |
| `apps/api/src/modules/employment/entry-pending-contract.ts` 的 `saveAddedPendingContract` | HTTP 添加待入职时生成 endDate=null 的临时合同 | 不能保存表单必填的终止日期 |
| `apps/api/src/modules/employment/entry-routes.ts` 的 `/pending-entries/:id/complete` | 后续“办理入职”可带 contract，合同与办理入职同事务 | 这是已有待入职的后续动作，不能直接当作“新增实习生”写入契约 |
| `apps/api/src/modules/contracts/input.ts` 的 `commandSchema` | 合同模块有独立创建命令 | 前端自行串接会产生人员、任职、合同的多笔提交；部分成功与恢复口径未获确认 |

不能只在前端校验终止日后丢弃字段，也不能默默改变为“先保存实习，再另建合同”。

## 需一并明确：未来日期的服务端视图归属

`EmploymentBusiness` 回执有 status、employeeStatus、entryStatus、record，但没有目标视图字段。
实习四视图是 interning / converting / converted / left；其中 interning 只查当前生效且人员状态为正式的实习任职。
未来的 pendingEntry 实习记录能从 `/pending-entries?view=all` 读到，四个实习视图均不返回它。

派发要求未来日期按服务端返回的视图归属刷新，不能由前端比较日期推断。需明确由服务端返回
跳转目标，或确认依据服务端状态进入入职管理的映射契约。

## 复用核对与原站一致性

- `apps/web/src/entries/EntriesPage.tsx` 的 Toolbar 及 `entries/messages.ts`：
  “添加待入职”仍是禁用入口，没有可以复用的新增人员表单。
- `apps/web/src/entries/CompleteForm.tsx` / `CompleteFields.tsx`：
  是已有待入职的办理表单，含合同字段；不能将其当成已具备的新增流程。
- `POST /rehire-matches` 已有严格 `{ idType, idNumber }` 契约；entries 未发现同类调用或提示实现。
- 本机已查看 `codex-R2b/screenshots/35-intern-create-form.png`：
  原站分区为员工信息、实习信息、汇报关系、实习协议，证件输入位于员工信息区。
- 本机 `codex-R2f1/spec.md` 的 W-1141 记录新增因合同协议终止日期必填而失败。
  原始截图、人员数据和原站链接不入库、不进入 PR。
- 尚未实现，因此不声称已完成视觉一致性、部门负责人默认值或重聘交互验证。
- 手机 / 邮箱匹配不在本片；退休候选不开放返聘，按派发提示走离职 / 退休再入职。

## 本地接口探针

使用现有 `entryWorld` / `addHire` 测试装配，通过真实 Hono HTTP 路由和全新 PGlite 数据库验证。
测试租户、人员和邮箱均为现有测试辅助生成的合成数据，没有连接北森测试租户。

临时文件运行命令：

```sh
npx --yes pnpm@10.34.6 test apps/web/src/intern/AC-FE-R2d4-contract-probe.test.ts --maxWorkers=1
```

结果：2 个测试通过，8.79 秒。这里断言的是“缺口确实存在”，不是功能验收通过，也不是已提交的前端红测。

1. 同一个未入职合成人员，分别携带 contract、contractEndDate、pendingContract、
   fields.contractEndDate，均得到 HTTP 400 / VALIDATION_FAILED。
   去掉合同项后，相同的 hire + intern 请求得到 201，随后能从 interning 查到该人员。
2. 未来日期的 hire + intern + pendingEntry 请求得到 201；
   pending-entries 的合同终止日为 null，四个实习视图都为空。

临时探针已移至本机 `/tmp/AC-FE-R2d4-contract-probe.test.ts`，日志为
`/tmp/fer2d4-contract-probe.log`，两者不提交。产品代码未变更。

## 需要产品决策的问题

推荐 A。以下选项均作用于**复刻系统**，不修改北森测试租户。

- **A：先补后端契约，再继续本片（推荐）。** 另派后端任务明确新增 / 重聘实习的合同写入、
  必填校验、失败边界、命令回执与恢复方式，并给出未来日期的视图归属。
  后端合入后本片继续“单独红测提交 → 前端实现 → 验证 → Ready”。
- **B：授权前端编排多步保存。** 明确建档、人员信息、入职、合同各步的持久状态、部分成功提示、
  未知结果回查和重开恢复，以及未来日期进入待入职的映射；需要重新评估范围和行数后再开发。
- **C：缩减本片验收。** 暂缓整个新增入口，只另做判定能力；需重新派发，不能按现有 B38 验收交付，
  也不能把必填终止日变成不保存的展示字段。

## 恢复点

已 fetch、安装锁定依赖并快进到上述 main；`pnpm merge:main` 因工作区原有未跟踪日志而拒绝执行，
随后按派发允许的 `git merge --no-edit origin/main` 完成快进，仅增加 main 的一条任务文档记录，
本分支无待重算的生成物差异。原有 `devx_fer2d4.out.log` 保留原位、不提交。

待总编排确定契约或调整派发后继续。本片尚未提交功能红测、未实现新增 / 重聘表单、未跑 Playwright
功能冒烟，未转 Ready，未自行发起审查。
