/**
 * 发现探测 P0 实测出的"表漏登"棘轮（F-039 PR-B4a，docs/08_设计/F-039_PR-B_设计.md B-08 P0）。
 * 全允许探测第一次对真实声明 + 显式表运行，就发现 5 类表里没有登记的授权请求（共 134 个"端点 × 请求键"）。
 * 它们归属别的 PR 的文件（IDP 归 B3 / B5h；required/types.ts 的承载者规则归 B1）或需要读源码另做审定（survey360、
 * employment），按"PR-B4a 只改本 PR 文件"的约束不在这里改表，改为**显式登记、逐类钉死数量**：
 *   - 登记项只能减不能增：规则命中的"端点 × 请求键"数必须恰好等于 count（多一个 = 新漏登，少一个 = 表已补，必须删规则）；
 *   - 新端点 / 新请求键的漏登不在规则里，P0 照常报 PROBE_ADMISSION_UNCLAIMED；
 *   - 每类写明归属与原因，修表的 PR 同时删掉对应规则（否则 PROBE_KNOWN_GAP_STALE）。
 * 这不是 DEC-303 取消的 PENDING_B：它不豁免声明缺失，只钉死 P0 已发现、待审定的表漏登，并且由本文件的测试强制收敛。
 */
export interface KnownGap {
  readonly id: string;
  readonly owner: string;
  readonly why: string;
  /** 规则命中的"端点 × 请求键"对数。 */
  readonly count: number;
  matches(route: string, requestKey: string): boolean;
}

const under = (prefix: string) => (route: string) => route.split(' ')[1]?.startsWith(prefix) ?? false;

export const KNOWN_UNCLAIMED: readonly KnownGap[] = [
  {
    id: 'org.personCandidates',
    owner: '表审定（required.ts 承载者规则归 PR-B1；另开 F 任务）',
    why:
      'anyPersonFieldEditable 对负责人 / HRBP / 店长字段逐个问 object.create / object.update；表把它登记成 ' +
      "'exception:' 守卫，而 R5 只认 guard: / rel: 承载者，守卫内部的对象权限无处登记",
    count: 1,
    matches: (route, key) =>
      route === 'GET /api/tenant/org/person-candidates' && key === 'obj:TenantBase.Organization:create',
  },
  {
    id: 'employment.trustedScopeBypass',
    owner: '表审定（读源码后补条件准入；另开 F 任务）',
    why:
      'employment/context.ts readContext：持看全部（data.scope.all）时再要 tenant.employment.read / write' +
      '（= 任职记录查看 / 编辑权，条件准入），表只登记了员工信息查看 / 任职新增，没有这条条件义务',
    count: 2,
    matches: (route, key) =>
      (route === 'GET /api/tenant/employment/employees/:id' && key === 'obj:TenantBase.EmploymentRecord:view') ||
      (route === 'POST /api/tenant/employment/employees/:id/businesses' &&
        key === 'obj:TenantBase.EmploymentRecord:update'),
  },
  {
    id: 'survey360.allActivities',
    owner: '表与声明审定（PR-B5g 360 组本期不交付；另开 F 任务）',
    why:
      'survey360/context.ts loadAdmin → allActivitiesOf：每个管理端路由在事务内追加问 Activity 的 object.view 与 viewAll ' +
      '按钮，只决定能否看全部活动（不拒绝请求）；应登记为披露分支，表与声明都没有',
    count: 77,
    matches: (route, key) =>
      under('/api/tenant/survey360')(route) &&
      ['obj:Survey360.Activity:view', 'btn:Survey360.Activity#viewAll@list'].includes(key),
  },
  {
    id: 'qualification.referencedView',
    owner: '表与声明审定（R3-T02 后续 PR / 另开 F 任务）',
    why:
      'qualification/access.ts writeContext、route-support.ts：写入口先对载荷可能引用的对象 / 岗职务逐个解析 object.view，' +
      '为假再在 store.referenced 抛 403（条件准入：只有载荷真引用该对象才拒绝）；表把它们当 object.* 动作事实挂在数据操作' +
      '义务下，没有逐对象的条件义务，条件守卫承载者也未声明',
    count: 15,
    matches: (route, key) => under('/api/tenant/qualification')(route) && /^obj:[^:]+:view$/.test(key),
  },
  {
    id: 'idp.nestedContent',
    owner: 'PR-B3（B-06 IDP 嵌套内容逐对象拆成披露分支）/ PR-B5h',
    why:
      'projectionOf / 计划详情行过滤对 SubProcess、模板模块、计划下的目标 / 任务 / 带教 / 轮岗等嵌套对象逐个问 object.view' +
      '（含任职记录 / 组织的行过滤与 plan 查看权），表没有 nested* 披露义务；B-06 落地后这些请求被新义务认领',
    count: 39,
    matches: (route, key) =>
      under('/api/tenant/idp')(route) &&
      /^obj:(IDP\.[A-Za-z]+|TenantBase\.EmploymentRecord|TenantBase\.Organization):view$/.test(key),
  },
];
