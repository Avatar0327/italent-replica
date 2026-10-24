# F-320 配置中心入口最小外壳实施计划

目标：头像菜单按服务端权限显示“应用配置”，进入独立配置中心外壳，为 F-315 / F-304 / F-318 提供自注册挂载点。

架构：扩展既有 ModulePages 为 configurations，在 collectPages 单点汇总；配置页只能引用既有应用对象或 adminMenus。配置中心不是新权限应用。流程占位登记在 approval/pages.ts，沿用 approval / TenantBase.ApprovalProcess。所有入口、导航及直达守卫使用同一快照计算的可见配置页 ID 集合。

技术栈：React、React Router、Ant Design、Vitest、Playwright；沿用现有主题。

## 范围

- `/config-center` 进入第一个可见配置页；`/config-center/<section>/<id>/*` 为挂载路径。
- 左侧“组织员工”列出导航地图的九类标准能力及两项特有目录。未挂载的目录显示只读占位，不能提交；流程任务管理下先登记“流程”。不扩展 64 个应用和 14 项全局配置的授权映射。
- 无可见配置页时头像入口隐藏，直达拒绝；未知路由显示不存在；配置页不进入既有业务菜单列表，企业设置保持原入口。
- 各模块在现有 pages.ts 的 configurations 数组登记 ID、目录、标签、权限来源及可选懒加载页面。F-315 给流程登记补页面，F-304 / F-318 新增同类型登记，不修改底座。

## 执行步骤

1. 在 `tests/acceptance/AC-FE-F320-config-center.test.ts` 写快照与单一注册点验收；在 `apps/web/smoke/AC-FE-F320.smoke.spec.ts` 写头像入口、目录、占位、路由刷新、撤权与企业设置兼容测试。
2. 在旧实现运行，确认行为失败；只提交红测，提交说明使用中文。
3. 增加 `foundation/configuration-registry.ts`，扩展 `page-registry.ts` 与 `permission-snapshot.ts`；在 `approval/pages.ts` 登记流程占位。
4. 增加 `config-center/` 页面、导航文案与样式；接入 `HeaderParts.tsx`、`AppPages.tsx`、`Shell.tsx`。守卫仍在会话/加载/错误处理之后，不使用 ungated 绕过。
5. 串行运行相关验收与 Playwright，随后 lint、typecheck、build、适用确定性守卫及 graph diff；不跑全量或访问 GitHub。
6. 按 dev-selfcheck 委托规则逐文件核对，修复问题并验证，提交实现。
7. 在仓库外结果文件记录完整提交、本地验证、行数、拟用 PR 描述、开发完成评论和挂载指南；正式审查由 03 发起。

## 证据与限制

基线为 347ba9742096b2797633ee07c269d3af936b2e7c。本地 docs 快照尚未包含 F-320 / DEC-684 新条目，以本次派发所引全文为新增授权。结构依据导航地图 §1–3；不声称像素复刻或已经确认原站默认展开行为。无新增后端 API，F-039 服务端端点声明集合应保持不变。
