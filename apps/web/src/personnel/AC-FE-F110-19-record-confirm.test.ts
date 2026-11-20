// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createFormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { SessionProvider } from '../foundation/Session.js';
import { RecordEdit } from './EditCommands.js';

const store = createFormStore();
// 使用页面同款内核，由测试持有存储以读取未确认的命令 ID。
vi.mock('./commands.js', () => ({
  PersonnelCommands: ({ children }: { children: ReactNode }) => h(FormCommands, { store, children }),
}));

async function click(label: string) {
  const button = await vi.waitFor(() => {
    const target = Array.from(document.querySelectorAll('button')).find(
      (item) => item.textContent?.replace(/\s/g, '') === label,
    );
    expect(target).toBeDefined();
    return target!;
  });
  await act(async () => button.click());
}

it('AC-FE-F110-19 编辑任职确认重提丢失响应：原槽只锁定实际发出的新命令', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const record = {
    id: '60000000-0000-4000-8000-000000000001',
    revision: 3,
    kind: 'hire',
    status: 'effective',
    fields: { place: '合成原工作地' },
  };
  const session = {
    tenantId: 'synthetic-tenant',
    identityKey: 'synthetic-hr',
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成 HR',
    source: 'server' as const,
  };
  const slot = JSON.stringify([session.tenantId, session.identityKey, `/api/tenant/employment/records/${record.id}`]);
  const writes: { id: string | null; revision: string | null; body: unknown }[] = [];
  const alert = {
    error: { code: 'CONFLICT', message: '已超出设定编制', details: { reason: 'CONFIRMATION_REQUIRED' } },
  };
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    expect(input).toBe(`/api/tenant/employment/records/${record.id}`);
    expect(init.method).toBe('PATCH');
    const headers = new Headers(init.headers);
    writes.push({
      id: headers.get('idempotency-key'),
      revision: headers.get('if-match'),
      body: JSON.parse(String(init.body)),
    });
    if (writes.length === 1) return Response.json(alert, { status: 409 });
    throw new TypeError('合成断线');
  });

  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  try {
    const page = h(RecordEdit, {
      record,
      saved: vi.fn(),
      permission: {
        objectCode: 'TenantBase.EmploymentRecord',
        dataOperations: { update: true },
        viewableFields: ['place'],
        editableFields: ['place'],
        buttons: [{ buttonCode: 'Employment.Edit', level: 'detail' }],
      },
    });
    await act(async () =>
      root.render(
        h(SessionProvider, {
          session,
          children: h(ConfigProvider, { theme: { token: { motion: false } } }, h(App, {}, page)),
        }),
      ),
    );
    await click('编辑任职');
    const input = document.querySelector<HTMLInputElement>('input#place')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '合成新工作地');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('保存');
    await click('继续保存');
    const holder = store.holder([slot]);
    const pending = store.get(holder ?? '');
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({ revision: '3', body: { fields: { place: '合成新工作地' }, confirmed: true } });
    expect(writes[1]?.id).toBeTruthy();
    expect(writes[1]?.id).not.toBe(writes[0]?.id);
    expect(pending?.status).toBe('unknown');
    expect(pending?.command?.id).toBe(writes[1]?.id);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
