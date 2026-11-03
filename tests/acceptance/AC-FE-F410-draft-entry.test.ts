/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-410：员工入口接续退休草稿不再只信页面缓存（DEC-727）。
 * 多会话场景：A 在别处被撤销、本页把 B 撤回成草稿 → 缓存指向已作废的 A，或根本没有缓存；入口要先问服务端
 * “这位员工现在有没有在途退休单”（GET /retirements/employees/:id/in-flight），有草稿就接续，不去新建被
 * “已有在途离职”挡住。响应形状对照 AC-RT-F410-in-flight（后端实测）：{ item: 退休详情 | null }。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { act, createElement: h } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { InternCommands } = await import(resolve('apps/web/src/intern/commands.tsx'));
const { useRetireDraft } = await import(resolve('apps/web/src/retirement/draft.ts'));

const employee = 'synthetic-f410-employee';
const billA = 'synthetic-f410-bill-a';
const billB = 'synthetic-f410-bill-b';
const roots: ReturnType<typeof createRoot>[] = [];
let serial = 0;
let session: Record<string, string>;
let retirement: ReturnType<typeof useRetireDraft>;
function Drafts() {
  retirement = useRetireDraft(employee);
  return null;
}
async function mount() {
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  await act(async () => root.render(h(SessionProvider, { session, children: h(InternCommands, null, h(Drafts)) })));
  await act(async () => new Promise((done) => setTimeout(done, 10)));
}

const fallbackOpening = { id: employee, revision: 99, values: { fromFallback: true } };
const bill = (id: string, status: string, revision: number) => ({
  id,
  employeeId: employee,
  kind: 'retirement',
  status,
  revision,
  lastWorkDate: '2026-11-30',
  handoverEmployeeId: null,
});
/** 服务端：按路径回单据详情与在途查询；inFlight 为 undefined 表示查询返回错误状态。 */
function server(options: { details: Record<string, object>; inFlight: object | null | number }) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path.endsWith(`/retirements/employees/${employee}/in-flight`)) {
        const { inFlight } = options;
        if (typeof inFlight === 'number')
          return Response.json({ error: { code: 'NOT_FOUND', message: '不存在' } }, { status: inFlight });
        return Response.json({ item: inFlight });
      }
      const id = path.split('/retirements/')[1];
      const detail = options.details[id];
      return detail
        ? Response.json(detail)
        : Response.json({ error: { code: 'NOT_FOUND', message: '任职业务不存在' } }, { status: 404 });
    }),
  );
  return paths;
}
async function open() {
  const fallback = vi.fn(async () => fallbackOpening);
  let opening!: Awaited<ReturnType<typeof retirement.resume>>;
  await act(async () => {
    opening = await retirement.resume(fallback);
  });
  return { opening, fallback };
}
const cached = (id: string, revision = 1) =>
  act(async () =>
    retirement.created({ id, revision, values: { lastWorkDate: '2026-11-30', handoverEmployeeId: null } }),
  );

describe('AC-FE-F410 员工入口接续在途退休草稿', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    session = {
      tenantId: `synthetic-f410-${++serial}`,
      identityKey: 'synthetic-identity',
      tenantName: '合成租户',
      timezone: 'Asia/Shanghai',
      displayName: '合成用户',
      source: 'server',
    };
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('AC-FE-F410-01 没有缓存：先查在途单，是草稿就接续（不新建），并记下引用', async () => {
    server({ details: {}, inFlight: bill(billB, 'draft', 7) });
    await mount();
    const { opening, fallback } = await open();
    expect(opening).toMatchObject({ id: employee, revision: 7, values: { lastWorkDate: '2026-11-30' } });
    expect(fallback).not.toHaveBeenCalled();
    expect(retirement.draft).toMatchObject({ id: billB, revision: 7 });
  });

  it('AC-FE-F410-02 多会话：缓存指向已作废的 A，服务端在途是撤回成草稿的 B → 改接续 B', async () => {
    server({ details: { [billA]: bill(billA, 'voided', 4) }, inFlight: bill(billB, 'draft', 9) });
    await mount();
    await cached(billA, 2);
    const { opening, fallback } = await open();
    expect(opening).toMatchObject({ id: employee, revision: 9 });
    expect(fallback).not.toHaveBeenCalled();
    expect(retirement.draft).toMatchObject({ id: billB, revision: 9 });
  });

  it('AC-FE-F410-03 没有在途单：清掉作废引用，走新建', async () => {
    server({ details: { [billA]: bill(billA, 'voided', 4) }, inFlight: null });
    await mount();
    await cached(billA, 2);
    const { opening, fallback } = await open();
    expect(opening).toEqual(fallbackOpening);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(retirement.draft).toBeUndefined();
  });

  it('AC-FE-F410-04 在途单已在审批中（不可接续）：不接续，走新建由服务端门禁拦截', async () => {
    server({ details: {}, inFlight: bill(billB, 'in_review', 3) });
    await mount();
    const { opening, fallback } = await open();
    expect(opening).toEqual(fallbackOpening);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(retirement.draft).toBeUndefined();
  });

  it.each([403, 404])('AC-FE-F410-05 在途查询 %s（无权 / 范围外）按没有在途单处理，走新建', async (status) => {
    server({ details: {}, inFlight: status });
    await mount();
    const { opening, fallback } = await open();
    expect(opening).toEqual(fallbackOpening);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('AC-FE-F410-06 在途查询失败（500）不猜：打开读报错可重试，不新建', async () => {
    server({ details: {}, inFlight: 500 });
    await mount();
    const fallback = vi.fn(async () => fallbackOpening);
    await act(async () => {
      await expect(retirement.resume(fallback)).rejects.toBeInstanceOf(Error);
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('AC-FE-F410-07 缓存的草稿仍有效：照旧读它，不多发在途查询', async () => {
    const paths = server({ details: { [billA]: bill(billA, 'draft', 5) }, inFlight: bill(billB, 'draft', 9) });
    await mount();
    await cached(billA, 2);
    const { opening } = await open();
    expect(opening).toMatchObject({ revision: 5 });
    expect(retirement.draft).toMatchObject({ id: billA, revision: 5 });
    expect(paths.some((path) => path.endsWith('/in-flight'))).toBe(false);
  });

  it('AC-FE-F410-08 撤回后回读带状态：回到草稿走主分支，引用与 revision 取回读值', async () => {
    server({ details: {}, inFlight: null });
    await mount();
    await cached(billB, 3);
    await act(async () => retirement.settled(billB, 'withdraw', { status: 'draft', revision: 6 }));
    expect(retirement.draft).toMatchObject({ id: billB, revision: 6 });
  });

  it('AC-FE-F410-09 回读到审批中：清掉本单引用；缓存里是别的单则不动', async () => {
    server({ details: {}, inFlight: null });
    await mount();
    await cached(billB, 3);
    await act(async () => retirement.settled(billA, 'submit', { status: 'in_review', revision: 4 }));
    expect(retirement.draft?.id).toBe(billB);
    await act(async () => retirement.settled(billB, 'submit', { status: 'in_review', revision: 4 }));
    expect(retirement.draft).toBeUndefined();
  });
});
