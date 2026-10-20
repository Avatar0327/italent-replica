# F-306 申请详情试用期回读实施计划

**目标**：按申请单 ID 回显持久化的试用期三项，按当前字段权限裁剪，并与 revision 保持一致。

**架构**：复用任职详情的 `loadEmploymentBusiness` 和 `trimEmploymentResponse`。存储来源与草稿修改范围待总编排确认，确认前只提交红测，不修改产品代码。

**技术栈**：TypeScript、Hono、Drizzle、PostgreSQL / PGlite、Vitest。

## 已核实的范围差异

基线：`45c6729e985a282343408fdc6653f380260f4541`。

1. `apps/api/src/modules/employment/entry-probation.ts` 的 `saveCreatedProbation` / `saveEntryProbation`
   将三项写入独立的 `employment_probation_versions`，按 `business_id` 关联。
2. `packages/db/src/schema/employment.ts` 的 `employment_payload_versions` 没有三项或试用期版本外键。
   `apps/api/src/modules/employment/record-store.ts` 的 `EmploymentPayloadRow` 也不含三项。
3. `apps/api/src/modules/employment/fields.ts` 的 `patchSchema` 只受理日期、任职字段和自定义字段，
   不受理试用期三项。`write-service.ts` 的草稿修改只追加 payload，不追加试用期版本。
4. 全仓产品代码和接口文档未找到 OpenAPI / Swagger 定义。现有后端业务 DTO 位于
   `apps/api/src/modules/employment/types.ts`；不得把不存在的 OpenAPI 描述为已经同步。

## 待决定的方案

作用对象均为复刻系统，不操作北森测试租户。

- A（建议）：确认来源改为本单的试用期版本链，并允许草稿 PATCH 修改三项。读取时在同一 SQL
  快照中取得业务 revision 和本单最新试用期值；写入复用现有锁、命令台账、审计和版本追加入口，
  同事务推进业务 revision。无需将数据复制进 payload 表。接口契约补后端 DTO 和本任务契约说明。
- B：严格要求三项属于 payload 版本，授权迁移及相关写链路同步改造，并明确批准扩大本片范围。
- C：本片只补创建时三项的回读，草稿编辑能力另立后续任务；相应调整验收③，不能把它声称为已完成。

列表结论待方案确认后固化：当前没有通用 `GET /businesses` 列表；实习生列表按人员聚合，
不是申请详情的同形投影。不能直接把员工当前试用期作为申请三项扩散到列表。

## 实施步骤

1. 新增 `tests/acceptance/AC-IN-F306-business-probation-readback.test.ts`：
   创建回读、无试用期、草稿修改、字段裁剪、409 拒绝后数据不变。
2. 先在旧实现运行 PGlite 和普通角色 PostgreSQL，记录具体失败断言，单独提交测试。
3. 在 Draft PR 记录上述证据与【等决定】，不转 Ready，不发起审查。
4. 总编排确认后更新计划，再修改 `read-model.ts`、`types.ts` 及获准的写契约文件。
5. 跑相关测试、lint、typecheck、build、DEC-613 推送前检查；有 F-039 摘要变化按 DEC-430 重算。
6. 完成 OCR 自检后转 Ready，按派发格式贴“开发完成，待审”；正式审查由 03 发起。
