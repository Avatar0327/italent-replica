# FE-0 前端底座（DEC-456）

运行 `pnpm demo` 启动本地后端、种子和前端，使用顶栏的既有演示身份选择器。生产认证仍沿用后端现状，不新增登录页。

## 页面片接入

- 公共入口：`src/foundation/index.ts`。组件库固定 Ant Design 5，React Router 使用安装时的稳定大版本 8；React 19 兼容补丁在 `main.tsx` 加载。
- 应用目录：`foundation/routes.ts`；页面装配：`foundation/AppPages.tsx`。用模块组件替换已有空首页，子路由也在这里显式登记。
- `<App session={session} />` 接受会话租户、身份缓存标识、租户名称、租户时区和展示名称。Cookie 由浏览器携带，演示身份头由现有 Vite 代理签名。前端不接触签名密钥。
- `useApiClient()` 读取当前会话；`request('/api/tenant/...', { method, command })` 的写命令由 `newCommand(body, revision)` 创建。结果未知时先回查原记录；只有显式重放时才重用同一命令，变更内容须建新命令。客户端不会自动重试。
- `pageQuery({ page, pageSize })` 适配页码接口；第二参数 `'offset'` 适配 `limit/offset`。上限 200；列表总数和 `hasMore` 以服务端为准。
- `usePermissions(objectCode?)` 与 `<Can object="..." button="..." level="list" />` 读取后端有效对象权限。不传对象时使用页面当前对象；默认按钮级别为 `detail`。非首页对象按需读取。字段用 `field(code)` 和 `PermissionField`，不可见时不渲染，不可编辑时显示只读值。
- `ListPage` 提供筛选槽、受控分页、批量选择、动作槽与导出占位；切页清空选择。`DetailPage` 提供摘要、页签和分区。业务按钮应包在 `Can` 中。
- `FormOverlay` 支持 drawer/modal。每字段显式传入可见／可编辑权限，只提交可编辑值。`recordKey` 必传：编辑用 `id:revision`，刷新冲突记录后更新 key；新建用本次打开的稳定键。保存成功关闭，400/422 字段错误回填，409 revision 冲突提示刷新。
- `OrgTreeSelect` 接收服务端按指定组织维度返回的树；`PersonSelect` 接收 `(query, signal) => Promise<Choice[]>`，由调用方保持加载函数稳定并使用已有候选接口；不在前端拼接范围。
- `TenantDatePicker` 的值始终是 `YYYY-MM-DD`；当前业务日期用 `tenantDate(instant, session.timezone)`，事件时间保持 UTC。
- 注释放 `annotations/<模块>.ts`，使用 `DecisionAnnotation`，在 `annotations/index.ts` 合并登记到根 `DecisionNotesProvider`；页面渲染 `<DecisionNote id="..." />`，全局开关默认关闭。
- 现有页面装在 `.legacy-page` 内，仅做租户与布局接入，后续页面片再替换业务 UI。

## L2 缺口

`demo-stubs/navigation.ts` 适配缺失的全应用菜单接口：归属目录来自共享对象定义，任何已授权对象都可让应用入口可见；按钮与字段只认后端响应。企业设置菜单直接使用 `admin-menus`。菜单元数据标为演示数据，不能作为服务端授权依据。

缺少通用的本人数据范围摘要接口，当前 `scope.status = unavailable`、组织范围为空，业务查询继续由已有后端接口裁剪。缺少当前会话的租户展示资料接口，本地 `demo-stubs/session.ts` 使用演示种子的合成名称和时区；生产由会话宿主注入。升级时替换适配器，不改变页面组件。

## 验证命令

```sh
pnpm --filter @italent/web test:smoke
# 首次使用：pnpm --filter @italent/web exec playwright install chromium
# 也可使用本机已安装的 Chrome：
FE0_BROWSER_CHANNEL=chrome pnpm --filter @italent/web test:smoke
# 先另起 pnpm demo，再验证真实演示身份和后端（不拦截 API）：
FE0_LIVE=1 FE0_BASE_URL=http://localhost:5173 FE0_BROWSER_CHANNEL=chrome pnpm --filter @italent/web test:smoke
```

`FE0_PORT=4186` 可为并行工作区指定独立冒烟端口（默认 4179），不会复用其他工作区的服务。

默认 17 项 Playwright 使用合成响应测试全部分区、旧路径、拒绝页面、中文分页与注释开关；live 测试验证真实身份切换及无权分区正常拒绝。产物只写到已忽略的 `.demo/fe0-smoke/`。不修改 `.github/`。

Vitest 运行 `tests/acceptance/AC-FE-0-*.test.ts`，再运行受影响的旧页面测试；不跑本地全量。交审前跑根目录 `pnpm build`、`pnpm lint`、`pnpm typecheck`。F-039 只涉及已有后端接口消费，不新增 HTTP 路由。
