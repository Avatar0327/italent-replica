# F-306 申请详情试用期回读契约与实施计划

**目标**：按申请单 ID 回显持久化的试用期三项，按当前字段权限裁剪，与业务 revision 在同一 SQL 快照中读取。

**架构**：复用 `loadEmploymentBusiness` 和 `trimEmploymentResponse`，通过 LATERAL 查询本单最新试用期版本；不新增写契约、授权项、路由或迁移。

**技术栈**：TypeScript、Hono、Drizzle、PostgreSQL / PGlite、Vitest。

## 03 已确认范围

依据：[03 在 #488 的答复](https://github.com/Avatar0327/italent-replica/pull/488#issuecomment-6290276530)。

1. 来源为 `employment_probation_versions` 按 `tenant_id + business_id` 定位的独立版本链；
   派发补充中“最新 payload 版本”是前提错误，已作废。业务 revision 与试用期 `version_no` 是不同序列，
   同一 SQL 快照保证本次回读的一致性，不要求两个序号相等。
2. 本片不改草稿 PATCH，试用期三项仍不被其严格 schema 接受，返回 400。
   验收③为：改草稿其他字段使 revision 加一后回读，三项仍与本单试用期版本一致。
3. 无试用期返回 false / null / null；继续沿用任职详情的字段权限裁剪。
4. 全仓没有现成 OpenAPI / Swagger 定义；同步后端 `employment/types.ts` DTO 和本文接口说明。
5. 不新增迁移，草稿编辑试用期是否需要由 03 另报总编排，不在 F-306 范围内。

## 接口说明

`GET /api/tenant/employment/businesses/:id` 在原有响应顶层增加：

| 字段 | 类型（裁剪前） | 来源与空值 |
| --- | --- | --- |
| probation | boolean | 本单最新试用期版本的 has_probation；没有版本时 false |
| probationMonths | number 或 null | 本单最新版本的 months；无试用期时 null |
| probationEndDate | YYYY-MM-DD 或 null | 本单最新版本的 expected_end_date；无试用期或未保存结束日时 null |

字段名与创建申请入参相同。三项与业务头 revision 在同一 SELECT 内读取，不通过员工当前试用期锚点取值，
也不按生效日和月数自行推算结束日。原有详情中 record / activation 等投影逻辑不变。

有字段限制的查看人仅获得 `trimEmploymentResponse` 当前允许的字段，三项逐项裁剪；不把隐藏值补成 false 或 null。
这三个控制字段尚未进入现有任职字段目录，本片不增加授权项，也不扩大默认可见性；沿用现有 fail-closed 行为。
后端内部完整 DTO 的三项为必有字段，HTTP 消费方必须允许权限裁剪后的缺席。

同一个读取函数还用于创建 / 修改 / 流转的业务回执，回执复用相同取数与既有裁剪，不另做分叉实现。

## 同类位置与列表结论（DEC-431①）

- 通用申请详情及业务回执：统一由 `loadEmploymentBusiness` 取数，本片在该入口修复。
- 当前没有通用 `GET /businesses` 列表。
- 实习列表的 converting 行承载申请摘要，但其 probation 既有定义仅用于 converted 行的试用期对象，
  形状为 `{ startDate, months, endDate } | null`。本片不改变列表语义或形状；申请三项从详情取。
- 已转正列表已有 `loadProbationVersions` 按每行单据 ID 批量读取的实现，不借用员工当前锚点。
- 员工试用期详情是另一接口，按当前任职周期锚点读取；不用于申请回显。

## 验收与实施

1. 独立提交旧实现下失败的回读测试；03 修订后单独提交测试调整，保持红测先于实现。
2. 创建带试用期后回读三项及 revision；false 回读 false / null / null。
3. 草稿改期后 revision 加一，三项不变；PATCH 三项仍 400，单据值和 revision 不变。
4. 同员工两张草稿互不串值、不取员工当前试用期；不推算未保存的结束日；本单追加版本后取最新值。
5. 验证全可见、无字段权、部分字段可见及范围外 404；提交后 409 冲突与明确拒绝前后回读不变。
6. 补读取 SQL、DTO；跑 PGlite / 普通角色 PG、lint、typecheck、build、完整 DEC-613 指定检查。
7. 按 DEC-430 重算受影响的 F-039 生成物，运行 explain-graph-diff，完成 OCR 自检后交审。
   正式审查由 03 发起，不自行发起、合并或关闭 PR。
