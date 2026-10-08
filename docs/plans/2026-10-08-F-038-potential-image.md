# F-038 潜力模型图片实现计划

> **For Claude:** 按本文逐步实施；本次由 codex 在已授权的开发会话内完成。

**Goal:** 人才标准潜力区域支持单张模型图片上传、替换、删除和受控读取。

**Architecture:** 沿用人事附件的元数据登记、SHA-256 和 registered / uploaded / pending_cleanup 生命周期。
现有附件表强制关联员工，实际文件存取尚未实现，因此在人才标准车道增加附件表，图片内容随数据库一致快照持久保存。
所有操作复用人才标准对象的权限、范围、行锁、revision 与命令台账；没有单独的图片可见性配置。

**Tech Stack:** TypeScript、Hono、React、Drizzle、PostgreSQL / PGlite、Vitest。

## 权威口径与边界

- `23_人才标准与任职资格_规格.md` Q-M0-126、DEC-281⑫、F-038：jpeg / jpg / gif / png / bmp，静态图片，≤5 MiB。
- 一个当前模型图；上传新图替换旧图，不实现坐标轴、分区或数据生成图。
- 图片读取跟随标准详情；登记、上传、替换、删除均是标准编辑（update + update@detail），不是标准删除。
- 新增附件表不借用员工 ID；标准删除时保留元数据和待清理状态。孤儿、未上传及待清理附件均不可读。
- 文件内容不进入审计、命令响应或列表；审计只保留元数据与哈希，登记、上传及删除均与业务同事务。
- 本次不修改 CriterionForm、CriterionPanel 或其他 F-035 表单；通过 TalentPage 的租户 context 装配独立组件。
- F-039 的 declare 尚未合并，沿用已合并 #106 的 Markdown 逐路由登记格式。

## Task 1：失败验收测试

**Files:** `tests/acceptance/AC-TC-model-image*.test.ts` 与专用 support 文件。

1. 编写 HTTP 验收：五种扩展名、大小上下边界、格式伪造、哈希 / 大小不符、孤儿不可读、替换 / 删除 / 标准删除。
2. 编写真授权器用例：范围外与不存在同一 404，编辑权 / 按钮拒绝 403，跨租户拒绝，撤权后重放拒绝，失败前后业务不变。
3. 编写 React 用例：服务端 canEdit、上传链的 revision、失败保留原图、撤权清理预览、未知命令核对与原键重放。
4. 运行新测试，记录失败，再独立提交测试。

## Task 2：后端与迁移

**Files:** `apps/api/src/modules/talent/model-image*.ts`、`packages/db/src/schema/talent.ts`、
`apps/api/src/modules/talent/routes.ts`、`criterion-service.ts`、`apps/api/src/app.ts`、`apps/api/src/audit/visibility.ts`。

1. 元数据登记与上传分开；登记先持久化，上传校验内容 / 实际大小 / 哈希后原子替换当前图。
2. 标准行锁串行全部图片写入；每次成功写入递增标准 revision；上传请求只有精确路径放宽 JSON body 限额。
3. 每次请求重新解析对象权限与范围；命令重放出口读取当前父对象，不能通过旧命令复活图。
4. 读取当前 uploaded 图片时返回 no-store 二进制响应；删除和替换立即使旧 ID 不可读。
5. 注册图片审计查看规则，复用标准范围与创建人锚点；下载再次验权。
6. 基于最新 main 运行 `pnpm db:generate`，通过 custom generate 增加 RLS，编号连续。

## Task 3：前端与声明

**Files:** `apps/web/src/talent/PotentialModelImage*.ts*`、`TalentTenantContext.ts`、`TalentPage.tsx`、
`CriterionDetail.tsx`、`model-image-messages.ts`、`docs/08_设计/F-038_潜力模型图片_路由声明.md`。

1. 潜力区域显示模型图预览、模型图设置、替换和删除；编辑能力从服务端 canEdit 读取。
2. 图片选定后保存依次登记和上传，每步使用服务端最新 revision；完成后重新读取服务端结果。
3. 4xx 显示具体错误；结果未知保留原命令，先刷新核对，再允许显式原键重放；不自动盲重试。
4. 预览 URL 在替换、撤权、失败和卸载时清理；不在页面缓存中保留失去访问权的图片。
5. 按 F-039 格式逐路由登记功能 / 按钮权限、范围、字段形状、写足迹、重放与拒绝码。

## Task 4：验证与交付

1. 运行相关验收，继而 `pnpm lint && pnpm typecheck && pnpm test`、build、diff check。
2. 独立提交实现，汇总一次推送到 `claude/F-038-potential-image`，创建指定标题的 Draft PR。
3. PR 描述列 AC-TC 补充场景、实现边界、查看矩阵、状态操作表、全部提交前自查项与恢复点。
4. 仓库 CI 跳过 Draft；如 Draft 无可运行 checks，按现有工作流转 Ready 触发两项 CI，不修改 CI 工作流。
5. 两项 CI 全绿后评论“开发完成，待审”，不合并、不关闭 PR。

## 已核实的实现限制

- 原站显示尺寸、多张实测、外部引用页面是否显示模型图仍是取证文档的黄色项；本次按派发的上传 / 替换 / 删除实现单个当前图。
- 现有附件没有外部对象存储接线；数据库存储是本次技术实现，附件内容随租户一致备份进入 tables 清单。
- AGENTS.md 当前基线没有 §9.1；审查收敛约定可见派发规则与 DEC-317，本任务不参加自检试点。
