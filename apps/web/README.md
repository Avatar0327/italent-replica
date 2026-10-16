# FE-0 前端底座（DEC-456）

运行 `pnpm demo` 启动本地后端、种子和前端，使用顶栏的既有演示身份选择器。生产认证仍沿用后端现状，不新增登录页。

## 页面片接入

- 公共入口：`src/foundation/index.ts`。组件库固定 Ant Design 5，React Router 使用安装时的稳定大版本 8；React 19 兼容补丁在 `main.tsx` 加载。
- 页面登记（F-125）：各模块在 `src/<模块>/pages.ts` 自带应用页、子路由与菜单下一层适配，`foundation/routes.ts` 自动汇总、`foundation/AppPages.tsx` 只装配；新片只改本模块目录，写法见 `docs/08_设计/F-125_前端片登记说明.md`。
- `<App session={session} />` 接受会话租户、身份缓存标识、租户名称、租户时区和展示名称。Cookie 由浏览器携带，演示身份头由现有 Vite 代理签名。前端不接触签名密钥。
- `useApiClient()` 读取当前会话；`request('/api/tenant/...', { method, command })` 的写命令由 `newCommand(body, revision)` 创建。结果未知时先回查原记录；只有显式重放时才重用同一命令，变更内容须建新命令。客户端不会自动重试。
- `pageQuery({ page, pageSize })` 适配页码接口；第二参数 `'offset'` 适配 `limit/offset`。每页上限 200，页码／偏移量还须遵守目标接口上限。`ListPage` 优先使用服务端 `total`，其次使用显式 `hasMore`；两者都缺失时，按审查确认的兼容规则，仅本页条数达到 `pageSize` 才允许继续，不推算总数。末页恰好满页时可翻到一个空页，空页禁用下一页并保留上一页；调用方应传入本次请求对应的 `page`，加载期间设置 `loading`。
- `usePermissions(objectCode?)` 与 `<Can object="..." button="..." level="list" />` 读取后端有效对象权限。不传对象时使用页面当前对象；默认按钮级别为 `detail`。非首页对象按需读取。字段用 `field(code)` 和 `PermissionField`，不可见时不渲染，不可编辑时显示只读值。
- `ListPage` 用“图标 + 视图名 ▾”作为标题，`view: { value, options, onChange }` 控制视图切换，`icon` 可替换自绘默认图标。提供筛选槽、受控分页、批量选择、动作槽与导出占位；切页清空选择，首页默认 15 条。业务按钮应包在 `Can` 中。
- `DetailPage` 按第 1 批原站参考改为右侧抽屉，新增必传 `open`、`onClose`，摘要、页签和分区都在抽屉内；调用方保留底层列表，关闭后卸载详情。
- `FilterDrawer` 为 500px 右侧高级筛选抽屉，接收 `open`、`onClear`、`onClose`、`onApply` 与筛选内容；页面维护草稿条件，取消不应用，校验和应用成功后由页面关闭。
- `FormOverlay` 支持 drawer/modal。每字段显式传入可见／可编辑权限，只提交可编辑值。`recordKey` 必传：编辑用 `id:revision`，刷新冲突记录后更新 key；新建用本次打开的稳定键。保存成功关闭，400/422 字段错误回填，409 revision 冲突提示刷新。
  可选 `titleExtra` 在标题右侧放工具节点，`footerExtra` 在取消与保存之间放附加节点（禁用状态由调用方控制），`className` 追加到弹窗根节点；两种模式均支持，不传时保持默认外观与提交行为（DEC-545）。
- `OrgTreeSelect` 接收服务端按指定组织维度返回的树；`PersonSelect` 接收 `(query, signal) => Promise<Choice[]>`，由调用方保持加载函数稳定并使用已有候选接口；不在前端拼接范围。
- `TenantDatePicker` 的值始终是 `YYYY-MM-DD`；当前业务日期用 `tenantDate(instant, session.timezone)`，事件时间保持 UTC。
- 注释放 `src/<模块>/annotations.ts`（导出 `notes`，类型 `DecisionAnnotation`），由 `annotations/index.ts` 自动汇总到根 `DecisionNotesProvider`；页面渲染 `<DecisionNote id="..." />`，全局开关默认关闭。
- 现有页面装在 `.legacy-page` 内，仅做租户与布局接入，后续页面片再替换业务 UI。

## L2 缺口

`foundation/permission-snapshot.ts` 通过一次 `GET /api/tenant/permission/me/snapshot` 读取会话、应用菜单、企业设置菜单和逐应用范围摘要，类型直接引用后端返回值，来源标为 `server`。应用对象目录使用 domain 的 `APP_OBJECT_DIRECTORY`。快照入口对象只代表可见性，不授予字段或按钮；需要明细的页面由 `usePermissions(code)` 按对象懒加载并共用当前快照周期的缓存。`usePermissions()` 只消费快照，避免菜单读取触发对象探测；`Can` 可以沿用页面对象上下文。

Session 的租户名称、时区、用户及员工绑定来自快照。开发 Cookie 仅提供首次请求的租户上下文，身份仍由服务端验证。快照网络或 5xx 失败显示可重试错误态，401 显示现有登录提示。范围读取成功为 ready，保留 all / limited / none、组织集合和 truncated；无范围概念的应用不补项，失败为 unavailable，不推断全部组织。

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

默认 21 项 Playwright 使用合成响应测试全部分区、旧路径、只有职位权限的两种入口、拒绝页面、中文分页与注释开关，并检查无面包屑、视图标题、12px 表格、40px 表头与行内操作行、50px 顶栏、200/72px 侧栏及右侧抽屉；live 的 16 项独立用例验证真实身份切换、15 个首页及无权分区正常拒绝，各页独立计时。产物只写到已忽略的 `.demo/fe0-smoke/`。不修改 `.github/`。

主题与尺寸依据本机 `~/Documents/italent-evidence-raw/UI/INDEX.md` 第 1 批实测，正文 12px、按钮 32px、内容背景 #F7F9FA；原始截图、菜单树、样式数据不入库。原规划的独立面包屑已按总编排 10-12 补充修订移除。

Vitest 运行 `tests/acceptance/AC-FE-0-*.test.ts`，再运行受影响的旧页面测试；不跑本地全量。交审前跑根目录 `pnpm build`、`pnpm lint`、`pnpm typecheck`。F-039 只涉及已有后端接口消费，不新增 HTTP 路由。

`AC-FE-0-catalog` 逐应用和逐对象核对后端目录；`AC-FE-0-backend` 使用隔离测试库与真实 HTTP 处理链，覆盖职位单权、无总数分页接入 `ListPage`、原始请求头、幂等重放与冲突、revision 和字段错误。前端数据形状不能只用自造的 `total` 响应验证。
