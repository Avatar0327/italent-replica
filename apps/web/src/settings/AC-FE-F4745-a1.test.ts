/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, h, uiHarness } from '../../../../tests/acceptance/support/f474-ui.js';
import { AuditPage } from './AuditPage.js';
import { MousPage } from './MousPage.js';

const auditPath = '/api/tenant/audit/data-changes';
const treePath = '/api/tenant/permission/mous/tree';
const audit = {
  id: '70000000-0000-4000-8000-000000000474',
  occurredAt: '2026-11-10T03:00:00Z',
  operator: { name: '合成操作人' },
  operationLabel: '编辑',
  app: '企业设置',
  objectLabel: '合成对象',
  objectId: 'SYNTH-474',
  content: '合成变更',
  sourceAction: '合成动作',
  sourcePageType: '合成类型',
  sourcePage: '合成页面',
  terminal: '合成终端',
  clientVersion: 'synthetic-version',
  ip: '192.0.2.1',
  traceId: 'synthetic-trace',
};
const node = (id: string, children: unknown[] = []) => ({
  id,
  name: `合成${id}`,
  code: id,
  description: '',
  status: 'active',
  revision: 1,
  parentId: null,
  matched: true,
  children,
});
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const page = () => h(MousPage, { code: 'permission.mous', title: '管理单元', editable: false });

describe('AC-FE-F4745-A1 日志与完整管理单元树', () => {
  it('日志补齐应用、来源和 TraceID 列，保持已有列宽', async () => {
    await ui.render(h(AuditPage), '/', undefined, {
      [auditPath]: { items: [audit], nextCursor: null, apps: ['企业设置'], window: {} },
    });
    expect(ui.headers()).toEqual([
      '数据ID',
      '操作人',
      '操作时间',
      '操作类型',
      '应用',
      '对象',
      '变更内容',
      '来源动作',
      '来源页面类型',
      '来源页面',
      '终端内核',
      '前端版本',
      'IP地址',
      'TraceID',
      '',
    ]);
    expect(ui.widths()).toEqual([128, 118, 146, ...Array(11).fill(128), 24].map((n) => `${n}px`));
    for (const value of ['合成类型', '合成页面', '合成终端', 'synthetic-version', '192.0.2.1', 'synthetic-trace'])
      expect(ui.host.textContent).toContain(value);
  });
  it('脱敏行不渲染可点击数据ID，不从其他字段补回来源', async () => {
    await ui.render(h(AuditPage), '/', undefined, {
      [auditPath]: {
        items: [
          {
            ...audit,
            objectId: null,
            sourceAction: null,
            sourcePageType: null,
            sourcePage: null,
            terminal: null,
            clientVersion: null,
            ip: null,
            traceId: null,
          },
        ],
        nextCursor: null,
        apps: [],
      },
    });
    expect(ui.host.querySelector('tbody .ant-btn-link')).toBeNull();
    expect(ui.headers()).toContain('TraceID');
    expect(ui.host.textContent).not.toContain('synthetic-trace');
  });
  it('管理单元读取完整树，展示服务端祖先和孙节点而不拼平面分页', async () => {
    const requests: URL[] = [];
    await ui.render(page(), '/', undefined, {
      [treePath]: (url: URL) => {
        requests.push(url);
        return { items: [node('root', [node('child', [node('grand')])])], total: 3 };
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get('status')).toBe('active');
    expect(ui.headers().filter(Boolean)).toEqual(['名称', '编码', '说明', '显示顺序']);
    const expand = async () => {
      const button = ui.host.querySelector<HTMLButtonElement>('button[aria-label="展开管理单元"]');
      expect(button).not.toBeNull();
      await act(() => button!.click());
    };
    await expand();
    await expand();
    expect(ui.host.textContent).toContain('合成grand');
    expect(ui.host.textContent).not.toContain('1.00');
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url]) => new URL(String(url), 'http://localhost').pathname === '/api/tenant/permission/mous',
        ),
    ).toBe(false);
  });
  it('空树显示空态而不回退演示数据或平面列表', async () => {
    await ui.render(page(), '/', undefined, { [treePath]: { items: [], total: 0 } });
    expect(ui.host.textContent).toContain('这里什么都没有…');
    expect(ui.headers()).not.toContain('上级管理单元编号');
    expect(ui.host.querySelector('.ant-pagination')).toBeNull();
  });
  it('完整树超过旧页大小仍可见，特殊字符名称按文本显示', async () => {
    const items = Array.from({ length: 36 }, (_, index) => node(`unit-${index}`));
    items[35]!.name = '<合成&单元>';
    await ui.render(page(), '/', undefined, { [treePath]: { items, total: 36 } });
    expect(ui.host.querySelectorAll('tbody tr[data-row-key]')).toHaveLength(36);
    expect(ui.host.textContent).toContain('<合成&单元>');
    expect(ui.host.querySelector('合成')).toBeNull();
    expect(ui.host.querySelector('input[aria-label="名称 / 编码"]')?.getAttribute('maxlength')).toBe('100');
  });
});
