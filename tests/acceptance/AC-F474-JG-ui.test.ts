/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-474-7b-fe 职务职级图谱前端（设计 docs/08_设计/F-474-7a_职务职级图谱_设计.md §5，DEC-896 U1～U8 = A）。
 * 快照 / 待确认记录夹具用后端同一纯函数现算，外形照 apps/api/src/modules/job/graph-routes.ts。
 * 导出下载（F-474-7c，JG-08、JG-09 导出）：下载响应外形照 apps/api/src/modules/job/graph-export.ts
 * （xlsx 内容类型 + filename* UTF-8 文件名；错误 → 统一错误信封）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH,
  GRAPH_CODE,
  allReasonsInput,
  button,
  click,
  errorInput,
  failure,
  graphHarness,
  issueItems,
  settle,
  snapshot,
} from './support/job-graph-ui.js';
import { act, session } from './support/f474-ui.js';

let ui: ReturnType<typeof graphHarness>;
beforeEach(() => {
  ui = graphHarness();
});
afterEach(async () => ui.close());

const text = () => document.body.textContent ?? '';
const posts = () => ui.calls.filter((call) => call.method === 'POST');
const reads = () => ui.calls.filter((call) => call.method === 'GET' && call.url.pathname === GRAPH);
const serveGraph = (current: unknown) => ui.route(`GET ${GRAPH}`, () => Response.json({ snapshot: current }));
/** 点“重新生成”并在气泡里确认。 */
async function rebuild() {
  await click(button('重新生成', ui.host));
  await click(button('确认'));
}
const matrix = () => ui.host.querySelector<HTMLTableElement>('table.job-graph-matrix');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** 与后端同形的下载响应：ASCII 兜底名 + RFC 5987 的 UTF-8 文件名。 */
const xlsxFile = (name: string) =>
  new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
    headers: {
      'content-type': XLSX,
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
/** 拦下浏览器下载：记下保存的文件名与 Blob，不真的导航。 */
function captureDownloads() {
  const saved: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let seq = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: (blob: Blob) => {
        const url = `blob:synthetic-${++seq}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL: () => {},
    }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download) saved.push({ name: this.download, blob: blobs.get(this.getAttribute('href') ?? '')! });
  });
  return { saved, restore: () => click.mockRestore() };
}
const cell = (label: string) =>
  Array.from(matrix()?.querySelectorAll<HTMLTableCellElement>('th, td') ?? []).find(
    (item) => item.textContent === label,
  );

describe('AC-F474-JG-01 图谱页签与同步生成', () => {
  it('图谱对象可读时出现“职务职级图谱”视图；无图谱对象查看权时退回职务列表、视图里也没有它', async () => {
    serveGraph(snapshot(3));
    await ui.render('/job?kind=graph');
    expect(ui.host.querySelector('h1')?.getAttribute('aria-label')).toBe('职务职级图谱');
    await ui.close();
    ui = graphHarness();
    await ui.render('/job?kind=graph', { hidden: [GRAPH_CODE] });
    expect(ui.host.querySelector('h1')?.getAttribute('aria-label')).toBe('职务');
    await click(ui.host.querySelector('button[aria-label="切换视图"]'));
    const views = Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).map((item) => item.textContent);
    expect(views).toContain('职务');
    expect(views).not.toContain('职务职级图谱');
    expect(reads()).toEqual([]);
  });

  it('首次进入只读快照、不发生成请求；最新生成时间按租户时区显示', async () => {
    serveGraph(snapshot(3));
    await ui.render('/job?kind=graph');
    expect(reads()).toHaveLength(1);
    expect(posts()).toEqual([]);
    // 2026-11-12T02:30:05Z 在 Asia/Shanghai 是 10:30:05
    expect(text()).toContain('最新生成时间：2026-11-12 10:30:05');
  });

  it('无快照：空态提示先重新生成，按钮可用', async () => {
    serveGraph(null);
    await ui.render('/job?kind=graph');
    expect(text()).toContain('尚未生成图谱，请点击“重新生成”');
    expect(matrix()).toBeNull();
    expect(button('重新生成', ui.host)?.disabled).toBe(false);
  });

  it('重新生成：气泡确认 → 全屏遮罩 → 用响应重绘并更新时间；请求带当前 revision、命令 ID 与空请求体', async () => {
    serveGraph(snapshot(3));
    let finish: (response: Response) => void = () => {};
    ui.route(`POST ${GRAPH}/rebuild`, () => new Promise<Response>((done) => (finish = done)));
    await ui.render('/job?kind=graph');
    await click(button('重新生成', ui.host));
    expect(text()).toContain('确定执行此操作？');
    await click(button('取消'));
    expect(posts()).toEqual([]);
    await rebuild();
    expect(document.querySelector('.job-graph-mask')?.textContent).toContain('图谱生成中,请耐心等待');
    const [call] = posts();
    expect(call!.url.pathname).toBe(`${GRAPH}/rebuild`);
    expect(call!.headers.get('if-match')).toBe('3');
    expect(call!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call!.headers.get('x-tenant-id')).toBe(session.tenantId);
    expect(JSON.parse(call!.body!)).toEqual({});
    await act(async () => finish(Response.json(snapshot(4, undefined, '2026-11-12T03:00:00.000Z'))));
    await settle();
    expect(document.querySelector('.job-graph-mask')).toBeNull();
    expect(text()).toContain('最新生成时间：2026-11-12 11:00:00');
    expect(reads()).toHaveLength(1);
    expect(document.querySelector('.ant-modal')).toBeNull();
  });
});

describe('AC-F474-JG-02 矩阵按快照渲染，不在前端重算布局', () => {
  it('职等列从高到低；多级列头与职级纵向合并取快照 merges；同格职务逗号拼接；颜色取 colorKey', async () => {
    serveGraph(snapshot(3));
    await ui.render('/job?kind=graph');
    const table = matrix()!;
    expect(table).not.toBeNull();
    expect(cell('职等')?.rowSpan).toBe(2);
    expect(cell('职级')?.colSpan).toBe(2);
    expect(cell('合成研发')?.colSpan).toBe(1);
    const header = Array.from(table.querySelectorAll('thead tr')).map((row) =>
      Array.from(row.children).map((item) => item.textContent),
    );
    expect(header).toEqual([
      ['职等', '职级', '合成研发'],
      ['合成M类', '合成T类', '合成后端'],
    ]);
    const body = Array.from(table.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.children).map((item) => item.textContent),
    );
    expect(body).toEqual([
      ['合成职等3', '合成M1', '', ''],
      ['合成职等2', '', '合成T1', '合成架构师,合成工程师'],
      ['合成职等1', '', '合成架构师,合成工程师'],
    ]);
    expect(cell('合成T1')?.rowSpan).toBe(2);
    expect(cell('合成M1')?.className).toContain('job-graph-type-0');
    expect(cell('合成T1')?.className).toContain('job-graph-type-1');
    expect(cell('合成T类')?.className).toContain('job-graph-type-1');
    expect(cell('合成架构师,合成工程师')?.className).toContain('job-graph-type-1');
  });
});

describe('AC-F474-JG-03 不规范数据提示', () => {
  it('快照含不规范数据才显示警示图标，悬停文案固定，新标签打开待确认记录页；首次进入不弹框', async () => {
    serveGraph(snapshot(3, errorInput()));
    await ui.render('/job?kind=graph');
    const link = ui.host.querySelector<HTMLAnchorElement>('a[aria-label="点击可查看不规范的职务职级"]');
    expect(link?.getAttribute('href')).toBe('/job?kind=graph-issues');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
    expect(document.querySelector('.ant-modal')).toBeNull();
    await ui.close();
    ui = graphHarness();
    serveGraph(snapshot(3));
    await ui.render('/job?kind=graph');
    expect(ui.host.querySelector('a[aria-label="点击可查看不规范的职务职级"]')).toBeNull();
  });

  it('本次新生成且有不规范数据：弹框“有不规范的职务职级数据，请检查”，我知道了 / 去查看 >>（新标签）', async () => {
    serveGraph(snapshot(3));
    ui.route(`POST ${GRAPH}/rebuild`, () => Response.json(snapshot(4, errorInput())));
    await ui.render('/job?kind=graph');
    await rebuild();
    const modal = document.querySelector('.ant-modal')!;
    expect(modal.textContent).toContain('有不规范的职务职级数据，请检查');
    const view = Array.from(modal.querySelectorAll('a')).find((item) => item.textContent === '去查看 >>');
    expect(view?.getAttribute('href')).toBe('/job?kind=graph-issues');
    expect(view?.target).toBe('_blank');
    await click(button('我知道了', modal));
    expect(document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')).toBeNull();
    expect(ui.host.querySelector('a[aria-label="点击可查看不规范的职务职级"]')).not.toBeNull();
  });
});

describe('AC-F474-JG-04 空图谱', () => {
  it('没有合规职务：显示原站两条件，不画矩阵', async () => {
    serveGraph(snapshot(3, { ...errorInput(), posts: [] }));
    await ui.render('/job?kind=graph');
    expect(matrix()).toBeNull();
    expect(text()).toContain('①启用职务须维护【职务序列】和【最高职级】（或【最低职级】）');
    expect(text()).toContain('②序列和职级必须启用');
    expect(text()).toContain('最新生成时间');
  });
});

describe('AC-F474-JG-05 并发与结果未知', () => {
  it('409 REVISION_CONFLICT：提示“图谱已被他人更新”并重读最新快照，下次生成带新 revision、新命令 ID', async () => {
    let current = snapshot(3);
    ui.route(`GET ${GRAPH}`, () => Response.json({ snapshot: current }));
    const replies = [
      () => failure(409, 'REVISION_CONFLICT', '图谱已被他人更新，请刷新后重提'),
      () => Response.json(snapshot(6)),
    ];
    ui.route(`POST ${GRAPH}/rebuild`, () => replies.shift()!());
    await ui.render('/job?kind=graph');
    current = snapshot(5, undefined, '2026-11-12T04:00:00.000Z');
    await rebuild();
    expect(text()).toContain('图谱已被他人更新');
    expect(reads().length).toBeGreaterThanOrEqual(2);
    expect(text()).toContain('最新生成时间：2026-11-12 12:00:00');
    expect(button('重新生成', ui.host)?.disabled).toBe(false);
    await rebuild();
    const [first, second] = posts();
    expect(second!.headers.get('if-match')).toBe('5');
    expect(second!.headers.get('idempotency-key')).not.toBe(first!.headers.get('idempotency-key'));
  });

  it('409 GRAPH_GENERATING：提示“图谱正在生成，请稍后刷新”并刷新；下次生成用刷新后的 revision', async () => {
    let current = snapshot(3);
    ui.route(`GET ${GRAPH}`, () => Response.json({ snapshot: current }));
    const replies = [
      () => failure(409, 'CONFLICT', '图谱正在生成，请稍后刷新', { reason: 'GRAPH_GENERATING' }),
      () => Response.json(snapshot(8)),
    ];
    ui.route(`POST ${GRAPH}/rebuild`, () => replies.shift()!());
    await ui.render('/job?kind=graph');
    current = snapshot(7);
    await rebuild();
    expect(text()).toContain('图谱正在生成，请稍后刷新');
    expect(reads()).toHaveLength(2);
    await rebuild();
    expect(posts()[1]!.headers.get('if-match')).toBe('7');
  });

  it('结果未知（网络中断）：锁定“结果待确认”，不能新建命令；“重试原请求”沿用原命令 ID 与 revision', async () => {
    serveGraph(snapshot(3));
    const replies: (() => Response)[] = [
      () => {
        throw new TypeError('network down');
      },
      () => Response.json(snapshot(4, undefined, '2026-11-12T03:00:00.000Z')),
    ];
    ui.route(`POST ${GRAPH}/rebuild`, () => replies.shift()!());
    await ui.render('/job?kind=graph');
    await rebuild();
    expect(text()).toContain('处理中 / 结果待确认');
    expect(document.querySelector('.job-graph-mask')).toBeNull();
    expect(button('重新生成', ui.host)?.disabled).toBe(true);
    await click(button('重试原请求', ui.host));
    const [first, second] = posts();
    expect(second!.headers.get('idempotency-key')).toBe(first!.headers.get('idempotency-key'));
    expect(second!.headers.get('if-match')).toBe('3');
    expect(text()).not.toContain('处理中 / 结果待确认');
    expect(text()).toContain('最新生成时间：2026-11-12 11:00:00');
    expect(button('重新生成', ui.host)?.disabled).toBe(false);
  });

  it('明确拒绝按机器码给文案，旧图谱保留；未映射的错误用原站兜底文案', async () => {
    serveGraph(snapshot(3));
    const replies = [
      () => failure(400, 'VALIDATION_FAILED', '职务职级数据超出图谱生成上限', { reason: 'GRAPH_LIMIT_COLUMNS' }),
      () => failure(400, 'REVISION_REQUIRED', 'If-Match required'),
    ];
    ui.route(`POST ${GRAPH}/rebuild`, () => replies.shift()!());
    await ui.render('/job?kind=graph');
    await rebuild();
    expect(text()).toContain('职务职级数据超出图谱生成上限');
    expect(cell('合成T1')).toBeTruthy();
    await rebuild();
    expect(text()).toContain('Oops~好像出问题了，重新刷新一下试试');
    expect(text()).not.toContain('If-Match required');
    expect(posts()[1]!.headers.get('if-match')).toBe('3');
  });
});

describe('AC-F474-JG-06 权限 fail-closed（前端部分）', () => {
  it('没有 rebuild 按钮权不出“重新生成”；没有 export 按钮权不出“导出”', async () => {
    serveGraph(snapshot(3));
    await ui.render('/job?kind=graph', { graphButtons: [] });
    expect(button('重新生成', ui.host)).toBeUndefined();
    expect(button('导出', ui.host)).toBeUndefined();
    expect(cell('合成T1')).toBeTruthy();
  });

  it('读快照被后端拒绝（缺源对象范围或字段）：整页无权限，不画任何矩阵', async () => {
    ui.route(`GET ${GRAPH}`, () => failure(403, 'FORBIDDEN', '无权访问职务职级图谱'));
    await ui.render('/job?kind=graph');
    expect(text()).toContain('暂无访问权限');
    expect(matrix()).toBeNull();
    expect(button('重新生成', ui.host)).toBeUndefined();
  });
});

describe('AC-F474-JG-08 图谱导出（前端）', () => {
  const EXPORT = `${GRAPH}/export`;
  let downloads: ReturnType<typeof captureDownloads>;
  beforeEach(() => {
    downloads = captureDownloads();
  });
  afterEach(() => downloads.restore());
  const exports = () => ui.calls.filter((call) => call.url.pathname === EXPORT);

  it('点“导出”直接下载：带当前租户头、不发写请求，文件名取服务端 filename*，提示“导出成功”', async () => {
    serveGraph(snapshot(3));
    ui.route(`GET ${EXPORT}`, () => xlsxFile('职务职级图谱_20261112103005.xlsx'));
    await ui.render('/job?kind=graph');
    expect(button('导出', ui.host)?.disabled).toBe(false);
    await click(button('导出', ui.host));
    await settle(60);
    expect(exports()).toHaveLength(1);
    expect(exports()[0]!.headers.get('x-tenant-id')).toBe(session.tenantId);
    expect(posts()).toEqual([]);
    expect(downloads.saved.map((file) => file.name)).toEqual(['职务职级图谱_20261112103005.xlsx']);
    expect(downloads.saved[0]!.blob.size).toBe(4);
    expect(text()).toContain('导出成功');
    expect(text()).not.toContain('导出功能准备中');
  });

  it('导出进行中：导出与重新生成都不可点，提示“正在导出图谱，请导出完成后再进行此操作”；完成后恢复', async () => {
    serveGraph(snapshot(3));
    let finish: () => void = () => {};
    ui.route(
      `GET ${EXPORT}`,
      () =>
        new Promise<Response>((done) => {
          finish = () => done(xlsxFile('职务职级图谱_20261112103005.xlsx'));
        }),
    );
    await ui.render('/job?kind=graph');
    await click(button('导出', ui.host));
    expect(text()).toContain('正在导出图谱，请导出完成后再进行此操作');
    expect(button('导出', ui.host)?.disabled).toBe(true);
    expect(button('重新生成', ui.host)?.disabled).toBe(true);
    await click(button('导出', ui.host));
    expect(exports()).toHaveLength(1);
    await act(async () => finish());
    await settle(60);
    expect(text()).not.toContain('正在导出图谱，请导出完成后再进行此操作');
    expect(button('导出', ui.host)?.disabled).toBe(false);
    expect(button('重新生成', ui.host)?.disabled).toBe(false);
    expect(downloads.saved).toHaveLength(1);
  });

  it('先打开“重新生成”气泡再启动导出：导出期间气泡里的“确认”不能触发重新生成；完成后也不自行弹回', async () => {
    serveGraph(snapshot(3));
    let finish: () => void = () => {};
    ui.route(
      `GET ${EXPORT}`,
      () =>
        new Promise<Response>((done) => {
          finish = () => done(xlsxFile('职务职级图谱_20261112103005.xlsx'));
        }),
    );
    ui.route(`POST ${GRAPH}/rebuild`, () => Response.json(snapshot(4)));
    await ui.render('/job?kind=graph');
    await click(button('重新生成', ui.host));
    expect(text()).toContain('确定执行此操作？');
    // 气泡开着时用键盘启动导出（不经过点外部关闭气泡）
    await click(button('导出', ui.host));
    expect(button('导出', ui.host)?.disabled).toBe(true);
    const confirm = button('确认');
    if (confirm) await click(confirm);
    expect(posts()).toEqual([]);
    await act(async () => finish());
    await settle(60);
    expect(posts()).toEqual([]);
    expect(document.querySelector('.ant-popover:not(.ant-popover-hidden)')).toBeNull();
  });

  it('无快照 409 GRAPH_NOT_GENERATED 提示先重新生成；其余拒绝或非 xlsx 响应一律“导出失败”，不落盘', async () => {
    const cases: [() => Response, string][] = [
      [() => failure(409, 'CONFLICT', '尚未生成图谱', { reason: 'GRAPH_NOT_GENERATED' }), '请先重新生成图谱'],
      [() => failure(403, 'FORBIDDEN', '无权访问职务职级图谱'), '导出失败'],
      [() => failure(400, 'VALIDATION_FAILED', '超限', { reason: 'EXPORT_ROW_LIMIT' }), '导出失败'],
      [() => failure(500, 'INTERNAL', 'boom'), '导出失败'],
      [() => Response.json({ snapshot: null }), '导出失败'],
    ];
    for (const [index, [respond, message]] of cases.entries()) {
      await ui.close();
      ui = graphHarness();
      downloads.restore();
      downloads = captureDownloads();
      serveGraph(snapshot(3));
      ui.route(`GET ${EXPORT}`, respond);
      await ui.render('/job?kind=graph');
      await click(button('导出', ui.host));
      await settle(60);
      expect(text(), `case ${index}`).toContain(message);
      expect(text(), `case ${index}`).not.toContain('导出成功');
      expect(downloads.saved, `case ${index}`).toEqual([]);
      expect(button('导出', ui.host)?.disabled, `case ${index}`).toBe(false);
    }
  });
});

describe('AC-F474-JG-07 租户隔离（前端部分）', () => {
  it('图谱读写都带当前会话的租户头，不跨租户取快照', async () => {
    serveGraph(snapshot(3));
    await ui.render('/job?kind=graph');
    expect(reads()).toHaveLength(1);
    expect(reads().every((call) => call.headers.get('x-tenant-id') === session.tenantId)).toBe(true);
  });
});

describe('AC-F474-JG-09 待确认的职务职级记录页', () => {
  const ISSUES = `${GRAPH}/issues`;
  /** wait 给定时，响应挂起到它兑现为止，用来观察列表请求未返回的加载期。 */
  const serveIssues = (items = issueItems(allReasonsInput()), wait?: Promise<void>) =>
    ui.route(`GET ${ISSUES}`, async (url) => {
      await wait;
      const kind = url.searchParams.get('kind');
      const name = url.searchParams.get('name');
      const hits = items.filter((item) => (!kind || item.kind === kind) && (!name || item.objectName.includes(name)));
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('pageSize') ?? 15);
      // 与 graph-routes.ts issueQuery 同口径：pageSize 1～100，超出整单 400。
      if (size < 1 || size > 100) return failure(400, 'VALIDATION_FAILED', 'pageSize 超出允许范围');
      return Response.json({
        items: hits.slice((page - 1) * size, page * size),
        total: hits.length,
        page,
        pageSize: size,
      });
    });
  const rows = () =>
    Array.from(ui.host.querySelectorAll('tbody tr.ant-table-row')).map((row) =>
      Array.from(row.querySelectorAll('td:not(.ant-table-selection-column)')).map((item) => item.textContent),
    );
  const issueCalls = () => ui.calls.filter((call) => call.url.pathname === ISSUES);

  it('列与原因文案：类型｜名称｜无法生成图谱原因｜操作，多原因以“；”串接，参数替换；15 条/页', async () => {
    serveIssues();
    await ui.render('/job?kind=graph-issues');
    expect(ui.host.querySelector('h1')?.getAttribute('aria-label')).toBe('待确认的职务职级记录');
    // 勾选列（F-474-7c 导出已选）无表头文案，不计入列序比对
    const heads = ui.host.querySelectorAll('thead th:not(.ant-table-selection-column)');
    expect(Array.from(heads).map((item) => item.textContent)).toEqual(['类型', '名称', '无法生成图谱原因', '操作']);
    expect(rows().map((row) => row.slice(0, 3))).toEqual([
      ['职级', '合成T1', '与同一类别的职级【合成T2】重叠'],
      ['职级', '合成T2', '与同一类别的职级【合成T1】重叠'],
      ['职级', '合成空职级', '该职级的职等范围为空；该职级的职级类别【合成停用类】为停用'],
      ['职务', '合成工程师', '最低职级【合成T1】的职等范围与同类别职级【合成T2】重叠'],
      ['职务', '合成架构师', '最高职级【合成T1】的职等范围与同类别职级【合成T2】重叠'],
      [
        '职务',
        '合成父序列职务',
        '所属序列【合成研发】，其下级序列已有职务；最低职级【合成空职级】，其职等范围为空；' +
          '最低职级【合成空职级】，其职级类别【合成停用类】为停用',
      ],
      ['职务', '合成缺项职务', '该职务的职级范围为空；该职务的职务序列为空'],
    ]);
    expect(Object.fromEntries(issueCalls().at(-1)!.url.searchParams)).toEqual({ page: '1', pageSize: '15' });
    expect(text()).toContain('共7条');
  });

  it('同类别多个重叠职级逐个加【】并以“、”分隔', async () => {
    serveIssues([
      {
        kind: 'level',
        objectId: 'x',
        objectName: '合成T9',
        reasons: [{ code: 'LEVEL_GRADE_RANGE_OVERLAP', params: ['合成T1', '合成T2'] }],
      },
    ]);
    await ui.render('/job?kind=graph-issues');
    expect(rows()[0]![2]).toBe('与同一类别的职级【合成T1】、【合成T2】重叠');
  });

  /** 打开 antd 下拉并选中文字为 label 的选项（只在当前展开的下拉里找）。 */
  async function pick(select: Element, label: string) {
    await act(async () => {
      select.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    await click(openOptions().find((item) => item.textContent === label));
  }
  const openOptions = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
      ),
    );
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };
  const drawer = () => document.querySelector<HTMLElement>('.filter-drawer .ant-drawer-content');
  const lastQuery = () => Object.fromEntries(issueCalls().at(-1)!.url.searchParams);
  const manyIssues = () =>
    issueItems(allReasonsInput()).concat(issueItems(allReasonsInput())).concat(issueItems(allReasonsInput()));

  it('高级筛选（设计 §5）：入口打开抽屉，类型、名称组合后确认才应用并回到第 1 页；取消不应用', async () => {
    serveIssues(manyIssues());
    await ui.render('/job?kind=graph-issues');
    expect(ui.host.querySelector('[aria-label="类型"]')).toBeNull();
    await click(Array.from(ui.host.querySelectorAll('.ant-pagination-item')).find((item) => item.textContent === '2'));
    expect(lastQuery().page).toBe('2');
    await click(button('高级筛选', ui.host));
    expect(drawer()?.textContent).toContain('高级筛选');
    const before = issueCalls().length;
    await pick(drawer()!.querySelector('[aria-label="类型"]')!.closest('.ant-select')!, '职务');
    await type(drawer()!.querySelector<HTMLInputElement>('input[aria-label="名称"]')!, '合成父');
    // 抽屉里改条件不发请求，确定才应用。
    expect(issueCalls()).toHaveLength(before);
    await click(button('确定', drawer()!));
    expect(lastQuery()).toEqual({ page: '1', pageSize: '15', kind: 'post', name: '合成父' });
    expect(rows().map((row) => row[1])).toEqual(['合成父序列职务', '合成父序列职务', '合成父序列职务']);
    const applied = issueCalls().length;
    await click(button('高级筛选', ui.host));
    await pick(drawer()!.querySelector('[aria-label="类型"]')!.closest('.ant-select')!, '职级');
    await click(button('取消', drawer()!));
    expect(issueCalls()).toHaveLength(applied);
    expect(lastQuery()).toEqual({ page: '1', pageSize: '15', kind: 'post', name: '合成父' });
  });

  it('每页条数只给接口允许的选项（graph-routes.ts 上限 100），逐个可读；切筛选后仍合法', async () => {
    serveIssues(manyIssues());
    await ui.render('/job?kind=graph-issues');
    const sizer = () => ui.host.querySelector('.ant-pagination-options .ant-select')!;
    await act(async () => {
      sizer()
        .querySelector('.ant-select-selector')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    const labels = openOptions().map((item) => item.textContent ?? '');
    const sizes = labels.map((label) => Number.parseInt(label, 10));
    expect(sizes[0]).toBe(15);
    expect(sizes.every((size) => size >= 1 && size <= 100)).toBe(true);
    await click(openOptions()[0]);
    for (const label of labels) {
      await pick(sizer(), label);
      expect(lastQuery().pageSize).toBe(String(Number.parseInt(label, 10)));
      expect(text()).not.toContain('Oops');
      expect(rows().length).toBeGreaterThan(0);
    }
    await click(button('高级筛选', ui.host));
    await pick(drawer()!.querySelector('[aria-label="类型"]')!.closest('.ant-select')!, '职务');
    await click(button('确定', drawer()!));
    const size = Number(lastQuery().pageSize);
    expect(size >= 1 && size <= 100).toBe(true);
    expect(lastQuery().page).toBe('1');
    expect(rows().length).toBeGreaterThan(0);
  });

  it('列表请求未返回时每页条数也只给 15／20／50／100；此时切换页大小，所发请求与返回后保持的页大小都在集合内', async () => {
    const items = manyIssues();
    let release!: () => void;
    serveIssues(items, new Promise<void>((done) => (release = done)));
    await ui.render('/job?kind=graph-issues');
    // 请求未返回：页面传入 { items: [] }，ListPage 走无总数分页分支。
    expect(ui.host.querySelector('.page-total')).toBeNull();
    const sizer = ui.host.querySelector('[aria-label="每页条数"]')!.closest('.ant-select')!;
    await act(async () => {
      sizer.querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await settle();
    // 与 ISSUE_PAGE_SIZES 同一集合；旧实现在加载期给的是 15／30／50。
    expect(openOptions().map((item) => item.textContent)).toEqual(['15条/页', '20条/页', '50条/页', '100条/页']);
    await click(openOptions().find((item) => item.textContent === '20条/页'));
    expect(lastQuery().pageSize).toBe('20');
    await act(async () => release());
    await settle(60);
    const sizes = issueCalls().map((call) => Number(call.url.searchParams.get('pageSize')));
    expect(sizes.every((size) => [15, 20, 50, 100].includes(size))).toBe(true);
    expect(lastQuery().pageSize).toBe('20');
    expect(text()).not.toContain('Oops');
    expect(ui.host.querySelector('.ant-pagination-options')?.textContent).toContain('20条/页');
    expect(rows()).toHaveLength(Math.min(20, items.length));
  });

  it('“编辑”迟到响应不覆盖当前表单：A→B 点击，B 先返回并填写，A 后返回仍保留 B 与输入', async () => {
    serveIssues();
    const gate = () => {
      let open!: () => void;
      const ready = new Promise<void>((done) => (open = done));
      return { open, ready };
    };
    const gates = { p: gate(), missing: gate() };
    const names = { p: '合成工程师', missing: '合成缺项职务' };
    for (const id of ['p', 'missing'] as const)
      ui.route(`GET /api/tenant/job/posts/${id}`, async () => {
        await gates[id].ready;
        return Response.json({ id, revision: 2, name: names[id], code: `SYN-${id}`, enabled: true });
      });
    await ui.render('/job?kind=graph-issues');
    const rowOf = (name: string) =>
      Array.from(ui.host.querySelectorAll('tbody tr.ant-table-row')).find(
        (row) => row.querySelectorAll('td:not(.ant-table-selection-column)')[1]?.textContent === name,
      )!;
    await click(button('编辑', rowOf('合成工程师')));
    await click(button('编辑', rowOf('合成缺项职务')));
    await act(async () => gates.missing.open());
    await settle(60);
    const nameInput = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>('.ant-modal input')).find((input) =>
        ['合成缺项职务', '合成改名', '合成工程师'].includes(input.value),
      );
    expect(nameInput()?.value).toBe('合成缺项职务');
    await type(nameInput()!, '合成改名');
    await act(async () => gates.p.open());
    await settle(60);
    expect(nameInput()?.value).toBe('合成改名');
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>('.ant-modal input')).map((i) => i.value),
    ).not.toContain('合成工程师');
  });

  it('“编辑”关闭弹窗后，之前未返回的读取不再打开表单', async () => {
    serveIssues();
    let open!: () => void;
    const ready = new Promise<void>((done) => (open = done));
    ui.route('GET /api/tenant/job/posts/p', async () => {
      await ready;
      return Response.json({ id: 'p', revision: 2, name: '合成工程师', code: 'SYN-p', enabled: true });
    });
    ui.route('GET /api/tenant/job/posts/missing', () =>
      Response.json({ id: 'missing', revision: 2, name: '合成缺项职务', code: 'SYN-MISS', enabled: true }),
    );
    await ui.render('/job?kind=graph-issues');
    const rowOf = (name: string) =>
      Array.from(ui.host.querySelectorAll('tbody tr.ant-table-row')).find(
        (row) => row.querySelectorAll('td:not(.ant-table-selection-column)')[1]?.textContent === name,
      )!;
    await click(button('编辑', rowOf('合成工程师')));
    await click(button('编辑', rowOf('合成缺项职务')));
    await settle(60);
    expect(document.querySelector('.ant-modal')).not.toBeNull();
    await click(button('取消', document.querySelector('.ant-modal')!));
    await settle(60);
    expect(document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')).toBeNull();
    await act(async () => open());
    await settle(60);
    expect(document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal')).toBeNull();
  });

  it('“编辑”随源对象编辑权显示；点击读取源对象并打开职务体系的编辑弹窗', async () => {
    serveIssues();
    ui.route('GET /api/tenant/job/posts/missing', () =>
      Response.json({ id: 'missing', revision: 2, name: '合成缺项职务', code: 'SYN-MISS', enabled: true }),
    );
    await ui.render('/job?kind=graph-issues', { readOnly: ['TenantBase.JobLevel'] });
    const actions = rows().map((row) => row[3]?.replace(/\s/g, ''));
    expect(actions).toEqual(['', '', '', '编辑', '编辑', '编辑', '编辑']);
    const last = Array.from(ui.host.querySelectorAll('tbody tr.ant-table-row')).at(-1)!;
    await click(button('编辑', last));
    await settle(60);
    expect(ui.calls.some((call) => call.url.pathname === '/api/tenant/job/posts/missing')).toBe(true);
    const dialog = document.querySelector('.ant-modal');
    expect(dialog?.textContent).toContain('职务');
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.ant-modal input'));
    expect(inputs.some((input) => input.value === '合成缺项职务')).toBe(true);
  });

  describe('导出（F-474-7c）', () => {
    const EXPORT = `${ISSUES}/export`;
    let downloads: ReturnType<typeof captureDownloads>;
    beforeEach(() => {
      downloads = captureDownloads();
    });
    afterEach(() => downloads.restore());
    const exports = () => ui.calls.filter((call) => call.url.pathname === EXPORT);
    const menu = () =>
      Array.from(document.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')).map((item) => ({
        text: item.textContent,
        disabled: item.classList.contains('ant-dropdown-menu-item-disabled'),
        item,
      }));
    // 只取数据行：antd 的量宽行（ant-table-measure-row）里也渲染一份表头勾选框
    const checkboxes = () =>
      Array.from(ui.host.querySelectorAll<HTMLInputElement>('tbody tr.ant-table-row input[type="checkbox"]'));

    it('下拉“导出已选（n 条）/ 导出全部（N 条）”：已选按对象 ID，全部带当前筛选；提示“导出成功”', async () => {
      const items = issueItems(allReasonsInput());
      serveIssues(items);
      ui.route(`GET ${EXPORT}`, () => xlsxFile('待确认的职务职级记录_20261112103005.xlsx'));
      await ui.render('/job?kind=graph-issues');
      expect(button('导出', ui.host)?.disabled).toBe(false);
      await click(button('导出', ui.host));
      expect(menu().map(({ text, disabled }) => [text, disabled])).toEqual([
        ['导出已选（0 条）', true],
        [`导出全部（${items.length} 条）`, false],
      ]);
      await click(checkboxes()[1]);
      await click(checkboxes()[3]);
      await click(button('导出', ui.host));
      expect(menu()[0]!.text).toBe('导出已选（2 条）');
      await click(menu()[0]!.item);
      await settle(60);
      expect(Object.fromEntries(exports()[0]!.url.searchParams)).toEqual({
        ids: [items[1]!.objectId, items[3]!.objectId].join(','),
      });
      expect(exports()[0]!.headers.get('x-tenant-id')).toBe(session.tenantId);
      expect(downloads.saved.map((file) => file.name)).toEqual(['待确认的职务职级记录_20261112103005.xlsx']);
      expect(text()).toContain('导出成功');
      await click(button('导出', ui.host));
      await click(menu()[1]!.item);
      await settle(60);
      expect(Object.fromEntries(exports()[1]!.url.searchParams)).toEqual({ all: 'true' });
      expect(downloads.saved).toHaveLength(2);
    });

    it('导出全部沿用已应用的类型 / 名称筛选；拒绝时提示“导出失败”、不落盘', async () => {
      serveIssues();
      ui.route(`GET ${EXPORT}`, () => failure(403, 'FORBIDDEN', '无权访问职务职级图谱'));
      await ui.render('/job?kind=graph-issues');
      await click(button('高级筛选', ui.host));
      await pick(drawer()!.querySelector('[aria-label="类型"]')!.closest('.ant-select')!, '职务');
      await type(drawer()!.querySelector<HTMLInputElement>('input[aria-label="名称"]')!, '合成父');
      await click(button('确定', drawer()!));
      await click(button('导出', ui.host));
      expect(menu()[1]!.text).toBe('导出全部（1 条）');
      await click(menu()[1]!.item);
      await settle(60);
      expect(Object.fromEntries(exports()[0]!.url.searchParams)).toEqual({ all: 'true', kind: 'post', name: '合成父' });
      expect(text()).toContain('导出失败');
      expect(downloads.saved).toEqual([]);
    });

    it('无导出按钮权：不出“导出”（不再显示禁用占位）', async () => {
      serveIssues();
      await ui.render('/job?kind=graph-issues', { graphButtons: ['rebuild'] });
      expect(ui.host.querySelector('h1')?.getAttribute('aria-label')).toBe('待确认的职务职级记录');
      expect(button('导出', ui.host)).toBeUndefined();
    });
  });
});
