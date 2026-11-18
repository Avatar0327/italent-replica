/// <reference lib="dom" />
// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { PermissionsProvider } = await import(resolve('apps/web/src/foundation/Permissions.tsx'));
const { FormCommands, useCommandForm } = await import(resolve('apps/web/src/foundation/forms/useCommandForm.tsx'));
const { CommandStatus } = await import(resolve('apps/web/src/foundation/forms/CommandStatus.tsx'));
const { RetireForm } = await import(resolve('apps/web/src/retirement/RetireForm.tsx'));
const { retirements, retireSlot, object } = await import(resolve('apps/web/src/retirement/model.ts'));

const employeeId = '30000000-0000-4000-8000-000000000405';
const beforeId = '30000000-0000-4000-8000-000000000406';
const latestId = '30000000-0000-4000-8000-000000000407';
const draftId = '70000000-0000-4000-8000-000000000405';
const people = '/api/tenant/personnel/employees';
const session = {
  tenantId: '10000000-0000-4000-8000-000000000405',
  identityKey: 'synthetic-f405',
  userId: 'synthetic-f405',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
let root: ReturnType<typeof createRoot>;
let unexpected: string[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  root = createRoot(document.body.appendChild(document.createElement('div')));
  unexpected = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});

const cells = (label: string) => {
  const row = Array.from(document.querySelectorAll('tbody tr')).find(
    (node) => node.querySelector('td')?.textContent === label,
  );
  expect(row, `差异表应有字段：${label}`).toBeDefined();
  return Array.from(row!.querySelectorAll('td')).map((cell) => cell.textContent);
};
const render = (content: unknown) =>
  act(async () => root.render(h(SessionProvider, { session }, h(FormCommands, null, content))));

describe('AC-FE-F405 内核差异表字段渲染', () => {
  const labels = { person: '人员', date: '日期', missing: '缺值' };
  type Renderers = Record<string, (value: unknown) => unknown>;
  let command: ReturnType<typeof useCommandForm>;
  function Probe({ renderers }: { renderers?: Renderers }) {
    command = useCommandForm('/synthetic/f405');
    return h(CommandStatus, { submission: command, labels, renderers });
  }
  async function conflict(renderers?: Renderers) {
    await render(h(Probe, { renderers }));
    await act(async () => {
      await command.submit({
        businessId: draftId,
        revision: 1,
        baseline: { person: beforeId, date: '2026-11-01', hidden: beforeId },
        values: { person: null, date: '2026-11-01', hidden: beforeId },
        editableFields: ['person', 'date', 'missing', 'hidden'],
        send: async () => {
          throw { status: 409, code: 'REVISION_CONFLICT' };
        },
      });
      await command.reread(async () => ({
        id: draftId,
        revision: 2,
        values: { person: latestId, date: '2026-11-02', missing: '新增值', hidden: latestId },
      }));
    });
  }

  it('AC-FE-F405-01 按字段渲染原值、最新值和我的输入；未配置字段仍用原显示', async () => {
    const names = new Map([
      [beforeId, '合成人员甲'],
      [latestId, '合成人员乙'],
    ]);
    const hidden = vi.fn(() => '不可见人员');
    await conflict({ person: (value) => h('strong', null, names.get(String(value)) ?? '未选择'), hidden });
    expect(cells('人员')).toEqual(['人员', '合成人员甲', '合成人员乙', '未选择']);
    expect(cells('日期')).toEqual(['日期', '"2026-11-01"', '"2026-11-02"', '"2026-11-01"']);
    expect(cells('缺值')).toEqual(['缺值', '—', '"新增值"', '—']);
    expect(hidden).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('不可见人员');
  });

  it('AC-FE-F405-02 未传渲染器时保留 JSON 与 undefined 的既有显示', async () => {
    await conflict();
    expect(cells('人员')).toEqual(['人员', JSON.stringify(beforeId), JSON.stringify(latestId), 'null']);
    expect(cells('日期')).toEqual(['日期', '"2026-11-01"', '"2026-11-02"', '"2026-11-01"']);
    expect(cells('缺值')).toEqual(['缺值', '—', '"新增值"', '—']);
  });
});

describe('AC-FE-F405 FE-R2c3 退休申请草稿冲突', () => {
  it('AC-FE-F405-03 交接人原值与最新值显示人员姓名而非 UUID，核对后仍按最新 revision 空体重提', async () => {
    const sent: { revision: string | null; body: unknown }[] = [];
    const names = new Map([
      [beforeId, '合成交接人甲'],
      [latestId, '合成交接人乙'],
    ]);
    const nameReads: string[] = [];
    const draft = (revision: number) => ({
      id: draftId,
      employeeId,
      revision,
      kind: 'retirement',
      mode: 'application',
      status: 'draft',
      lastWorkDate: '2026-11-30',
      handoverEmployeeId: revision === 1 ? beforeId : latestId,
    });
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('/permission/me/snapshot'))
        return Response.json({ session, apps: [], scope: [], adminMenus: [] });
      if (url.pathname.endsWith(`/permission/me/objects/${object}`)) {
        const fields = ['kind', 'mode', 'lastWorkDate', 'handoverEmployeeId'];
        return Response.json({
          objectCode: object,
          dataOperations: { read: true, create: true },
          viewableFields: fields,
          editableFields: fields,
          buttons: [],
        });
      }
      if (url.pathname === `${retireSlot}/${employeeId}/in-flight`) return Response.json({ item: draft(1) });
      if (url.pathname === `${retirements}/${draftId}`) return Response.json(draft(2));
      if (url.pathname === `${retirements}/${draftId}/submit`) {
        sent.push({ revision: new Headers(init?.headers).get('if-match'), body: JSON.parse(String(init?.body)) });
        return Response.json(
          { error: { code: sent.length === 1 ? 'REVISION_CONFLICT' : 'FORBIDDEN', message: '合成拒绝' } },
          { status: sent.length === 1 ? 409 : 403 },
        );
      }
      if (url.pathname === people) return Response.json({ items: [...names].map(([id, name]) => ({ id, name })) });
      if (url.pathname.startsWith(`${people}/`)) {
        const id = url.pathname.slice(people.length + 1);
        if (names.has(id)) {
          nameReads.push(id);
          return Response.json({ id, name: names.get(id) });
        }
      }
      unexpected.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return Response.json({ error: { code: 'NOT_FOUND', message: '合成不存在' } }, { status: 404 });
    });
    await render(
      h(
        PermissionsProvider,
        null,
        h(RetireForm, {
          row: { employeeId },
          mode: 'application',
          onClose: vi.fn(),
          onDone: vi.fn(),
          refresh: async () => undefined,
        }),
      ),
    );
    const click = async (label: string) => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (node) => node.textContent?.replace(/\s/g, '') === label,
      );
      expect(button, label).toBeDefined();
      expect(button!.disabled, label).toBe(false);
      await act(async () => button!.click());
    };
    await click('提交');
    expect(cells('工作交接人')).toEqual(['工作交接人', '合成交接人甲', '合成交接人乙', '合成交接人甲']);
    expect(document.querySelector('tbody')?.textContent).not.toContain(beforeId);
    expect(document.querySelector('tbody')?.textContent).not.toContain(latestId);
    expect(new Set(nameReads)).toEqual(new Set([beforeId, latestId]));
    await click('已核对差异，继续编辑');
    await click('提交');
    expect(sent).toEqual([
      { revision: '1', body: {} },
      { revision: '2', body: {} },
    ]);
  });
});
