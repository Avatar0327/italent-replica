/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import {
  reportCatalog,
  reportPage,
  reportPermission,
  movementPage,
  qualityPage,
} from '../../apps/web/smoke/hr-reports-fixtures.js';
const web = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act, Suspense } = web('react');
const { createRoot } = web('react-dom/client');
const { MemoryRouter, useNavigate } = web('react-router');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const session = {
  tenantId: 'synthetic',
  userId: 'synthetic',
  identityKey: 'synthetic',
  today: '2026-10-06',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  tenantName: '合成租户',
  source: 'server',
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let catalog: ReturnType<typeof reportCatalog>;
let data: unknown;
let allowed: boolean;
let status: number;
let urls: string[];
let navigate: (path: string | number) => void;
let pending: (() => Promise<Response>) | undefined;
const entry = () => PAGES.entries.find((r) => r.id === 'hr-reports');
const text = () => host.textContent ?? '';
const button = (label: string) =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.replace(/\s/g, '') === label);
async function settle() {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
}
function Nav() {
  navigate = useNavigate();
  return null;
}
async function render(code = '') {
  expect(entry(), '组织员工下应登记报表入口').toBeDefined();
  const Page = entry()!.page!.Component;
  await act(async () =>
    root.render(
      h(
        SessionProvider,
        { session },
        h(
          PermissionsProvider,
          null,
          h(
            MemoryRouter,
            { initialEntries: [`/hr-reports${code ? `/${code}` : ''}`] },
            h(Nav),
            h(Suspense, { fallback: null }, h(Page)),
          ),
        ),
      ),
    ),
  );
  for (let i = 0; i < 60 && !host.querySelector('h1'); i++) await settle();
  await settle();
}
async function click(label: string) {
  expect(button(label), label).toBeDefined();
  await act(async () => button(label)!.click());
  await settle();
}
async function fill(label: string, value: string) {
  const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  expect(input, label).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  catalog = reportCatalog();
  data = reportPage();
  allowed = true;
  status = 200;
  urls = [];
  pending = undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/permission/me/snapshot')) return Response.json({ session, apps: [], scope: [], adminMenus: [] });
    if (url.includes('/permission/me/objects/')) return Response.json(reportPermission(allowed));
    if (url === '/api/tenant/hr-analysis/reports') return Response.json(catalog);
    if (url.includes('/export'))
      return new Response('\ufeff姓名,工号\r\n合成甲,SYN-001', { headers: { 'content-type': 'text/csv' } });
    if (pending) return pending();
    return Response.json(status === 200 ? data : { error: { code: 'FORBIDDEN', message: '内部权限码' } }, { status });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-FE-F465b / DEC-763/802/803 组织员工报表', () => {
  it('任一报表对象可见入口，目录完整分三组并按接口置灰', async () => {
    catalog.items[3] = { ...catalog.items[3]!, available: false };
    await render();
    for (const code of ['TenantBase.HrRoster', 'TenantBase.HrMovementReport', 'TenantBase.HrStructureReport']) {
      expect(
        menuNodes([entry()!], { apps: [{ app: 'staff', visible: true, entryObjects: [code] }] } as ServerSnapshot),
      ).toEqual([{ key: 'hr-reports', label: '报表', path: '/hr-reports', group: 'people' }]);
    }
    for (const item of catalog.items) expect(text()).toContain(item.name);
    for (const label of ['员工名册分析', '人事报表', '员工花名册']) expect(text()).toContain(label);
    expect(button('合同（协议）台账')?.disabled).toBe(true);
    expect(text()).toContain('报表不可用');
  });
  it('名册按后端列序显示，裁剪列不出现；原文说明不改字，导出权来自接口', async () => {
    await render('1.01');
    expect(text()).toContain('正式在职员工（不含实习生、外部人员）。');
    expect(Array.from(host.querySelectorAll('thead th')).map((n) => n.textContent)).toEqual(['姓名', '工号']);
    expect(text()).toContain('合成甲');
    expect(text()).not.toContain('手机');
    expect(button('导出')).toBeDefined();
    expect(text()).not.toContain('该数据集每3小时更新最近12个月数据');
  });
  it('无导出权不显示按钮；空范围同时显示无数据权限及原站空态', async () => {
    allowed = false;
    data = { ...reportPage(), items: [], total: 0, hasDataPermission: false };
    await render('1.01');
    expect(button('导出')).toBeUndefined();
    expect(text()).toContain('无数据权限');
    expect(text()).toContain('该报表暂无数据');
  });
  it('普通空结果只显示原文空态，不错误提示无数据权限', async () => {
    data = { ...reportPage(), items: [], total: 0 };
    await render('1.04');
    expect(text()).toContain('在职实习生。');
    expect(text()).toContain('该报表暂无数据');
    expect(text()).not.toContain('无数据权限');
  });
  it('直链不按目录 available 拦截，请求报表接口并显示 403 短句', async () => {
    catalog.items[0] = { ...catalog.items[0]!, available: false };
    status = 403;
    await render('1.01');
    expect(urls.some((u) => u.includes('/reports/1.01?'))).toBe(true);
    expect(text()).toContain('无权查看该报表');
    expect(text()).not.toContain('内部权限码');
    expect(button('导出')).toBeUndefined();
  });
  it.each([
    ['1.05', '在职外部人员。'],
    ['1.06', '在职员工签订、续签的合同 / 协议。'],
    ['1.08', '时点，含实习生'],
    ['1.1.01', '在职、离职员工最新一条任职记录，含实习生、外部人员'],
    ['1.1.02', '历史全部任职记录，含兼职'],
  ])('%s 说明与适用日期参数', async (code, description) => {
    data = reportPage(code);
    await render(code);
    expect(text()).toContain(description);
    const query = new URL(
      urls.find((u) => u.includes(`/reports/${code}?`))!,
      'http://synthetic.invalid',
    ).searchParams;
    expect(query.has('asOf')).toBe(!['1.1.01', '1.1.02'].includes(code));
  });
  it('1.07 先按租户日期发必填范围；裁剪 category 列不显示异动类别筛选', async () => {
    await render('1.07');
    expect(text()).toContain('指定时间范围和异动类别（入职、转正、调动、离职）的人员。');
    expect(urls.some((u) => u.includes('from=2026-01-01') && u.includes('to=2026-10-06'))).toBe(true);
    expect(host.querySelector('[aria-label="异动类别"]')).toBeNull();
    await fill('开始日期', '2026-02-01');
    await click('查询');
    expect(urls.at(-1)).toContain('from=2026-02-01');
  });
  it('筛选后页码归一，分页带同一查询；无权字段不参与查询', async () => {
    data = { ...reportPage(), total: 41 };
    await render('1.01');
    const next = host.querySelector('.ant-pagination-next button') as HTMLButtonElement;
    await act(async () => next.click());
    await settle();
    expect(urls.at(-1)).toContain('page=2');
    await fill('姓名', '合成乙');
    await click('查询');
    expect(urls.at(-1)).toContain('page=1');
    expect(urls.at(-1)).toContain('name=');
    expect(host.querySelector('[aria-label="邮箱"]')).toBeNull();
  });
  it.each(['monthly', 'institution', 'quality'])('%s 即使有 export 权也不导出，按真实统计形状显示', async (code) => {
    data = code === 'quality' ? qualityPage() : movementPage(code);
    await render(code);
    expect(button('导出')).toBeUndefined();
    expect(text()).toContain('合计');
    expect(text()).toContain(
      code === 'quality'
        ? '年龄段、司龄段、学历、性别分布。'
        : code === 'monthly'
          ? '按年度统计本年各月期初、期末、入职、离职人数。'
          : '一级机构、指定月份的入离职统计。',
    );
    expect(text().includes('该数据集每3小时更新最近12个月数据')).toBe(code !== 'quality');
    expect(urls.some((u) => u.includes(`/reports/${code}?`))).toBe(true);
  });
  it('花名册调用既有 roster，不误发 reports/roster', async () => {
    await render('roster');
    expect(urls.some((u) => u.includes('/hr-analysis/roster?'))).toBe(true);
    expect(urls.some((u) => u.includes('/reports/roster'))).toBe(false);
  });
  it('导出使用已经查询的日期和筛选，移除分页；查询草稿不改变导出', async () => {
    vi.stubGlobal('URL', URL);
    URL.createObjectURL = vi.fn(() => 'blob:synthetic');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await render('1.01');
    await fill('时点日期', '2026-01-02');
    await click('导出');
    const url = urls.find((u) => u.includes('/export?'))!;
    expect(url).toContain('asOf=2026-10-06');
    expect(url).not.toContain('page=');
    expect(url).not.toContain('pageSize=');
  });
  it('离开再返回、后退再前进时丢弃旧查询回调，重新读取当前报表', async () => {
    await render('1.01');
    let finish: ((response: Response) => void) | undefined;
    pending = () =>
      new Promise((r) => {
        finish = r;
      });
    await click('查询');
    pending = undefined;
    data = reportPage('1.04');
    await act(async () => navigate('/hr-reports/1.04'));
    await settle();
    await act(async () =>
      finish!(Response.json({ ...reportPage(), items: [{ employeeName: '迟到旧记录', code: 'OLD' }] })),
    );
    await settle();
    expect(text()).not.toContain('迟到旧记录');
    expect(text()).toContain('在职实习生。');
    await act(async () => navigate(-1));
    await settle();
    expect(text()).toContain('正式在职员工');
    await act(async () => navigate(1));
    await settle();
    expect(text()).toContain('在职实习生。');
  });
  it('空范围的月度表即便含 12 个零值月份，也显示原文空态', async () => {
    data = { ...movementPage(), hasDataPermission: false };
    await render('monthly');
    expect(text()).toContain('无数据权限');
    expect(text()).toContain('该报表暂无数据');
  });
  it('有 category 列才提供异动类别，筛选值使用后端枚举', async () => {
    data = {
      ...reportPage('1.07'),
      columns: [{ key: 'category', label: '异动类别' }],
      items: [{ category: 'transfer' }],
    };
    await render('1.07');
    expect(host.querySelector('[aria-label="异动类别"]')).not.toBeNull();
    expect(text()).toContain('调动');
    expect(host.querySelector('[aria-label="姓名"]')).toBeNull();
  });
  it('拒绝倒置日期范围，保留输入且不发请求', async () => {
    await render('1.07');
    const count = urls.length;
    await fill('开始日期', '2026-10-07');
    await click('查询');
    expect(text()).toContain('请检查筛选条件和日期范围');
    expect(urls.length).toBe(count);
  });
  it('导出超限 422 使用真实原因码显示短句，不生成文件', async () => {
    await render('1.01');
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).includes('/export')
        ? Promise.resolve(
            Response.json(
              { error: { code: 'VALIDATION_FAILED', details: { reason: 'EXPORT_ROW_LIMIT' } } },
              { status: 422 },
            ),
          )
        : original(input, init),
    );
    await click('导出');
    expect(text()).toContain('导出最多 10000 行，请缩小筛选范围');
    expect(text()).not.toContain('EXPORT_ROW_LIMIT');
  });
  it('离开后返回的下载回调不得创建文件', async () => {
    const create = vi.fn(() => 'blob:synthetic');
    URL.createObjectURL = create;
    await render('1.01');
    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).includes('/export')
        ? new Promise((r) => {
            finish = r;
          })
        : original(input, init),
    );
    await click('导出');
    await act(async () => navigate('/hr-reports'));
    await settle();
    await act(async () => finish!(new Response('合成内容', { headers: { 'content-type': 'text/csv' } })));
    await settle();
    expect(create).not.toHaveBeenCalled();
  });
  it('离职率只格式化服务端比例为百分比，不从行数重算', async () => {
    const body = movementPage();
    body.tables[0]!.columns = [{ key: 'rate', label: '离职率' }];
    data = {
      ...body,
      tables: [
        {
          ...body.tables[0],
          rows: [{ key: 'm', label: '2026-01', cells: { rate: 0.125 } }],
          summary: { cells: { rate: 0.0875 } },
        },
      ],
    };
    await render('monthly');
    expect(text()).toContain('12.5%');
    expect(text()).toContain('8.75%');
  });
  it('导出网络错误显示中文短句，不泄露浏览器异常文字', async () => {
    await render('1.01');
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).includes('/export')
        ? Promise.reject(new Error('Failed to fetch synthetic private detail'))
        : original(input, init),
    );
    await click('导出');
    expect(text()).toContain('导出失败，请重试');
    expect(text()).not.toContain('private detail');
  });
});
