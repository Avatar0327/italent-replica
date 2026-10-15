/// <reference lib="dom" />
// @vitest-environment happy-dom
// F-142（DEC-502②）：ConflictCommands 契约。回执与错误按真实接口形态构造：
// 记录 PUT 成功回执为记录 DTO + ETag（apps/api/src/modules/succession/routes.ts writeRecord），
// 错误体为 { error: { code, message } }（apps/api/src/errors.ts）。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h, act } = requireWeb('react');
const { createRoot } = requireWeb('react-dom/client');
const { SessionProvider, useApiClient } = await import(resolve('apps/web/src/foundation/Session.tsx'));
const { ConflictCommands, useConflictCommand } = await import(
  resolve('apps/web/src/foundation/forms/ConflictCommands.tsx')
);
const { FormCommands, useCommandForm } = await import(resolve('apps/web/src/foundation/forms/useCommandForm.tsx'));
const { slotKey } = await import(resolve('apps/web/src/foundation/forms/slot.ts'));
const { slotContext } = await import(resolve('apps/web/src/foundation/forms/store.ts'));
const { createApiClient } = await import(resolve('apps/web/src/foundation/client.ts'));

const session = {
  tenantId: 't-1',
  identityKey: 'u-1',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server',
};
const RECORDS = '/api/tenant/succession/records';
const path = `${RECORDS}/r-1`;
const record = (revision: number, remark: string) => ({
  id: 'r-1',
  revision,
  remark,
  readiness: 'ready_now',
  endDate: null,
});
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const failure = (status: number, code: string) => json(status, { error: { code, message: '合成错误' } });

type Writer = ReturnType<typeof useConflictCommand>;
type Api = ReturnType<typeof useApiClient>;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: { method: string; ifMatch: string | null; key: string | null; body: unknown }[];
const writers: Record<string, Writer> = {};
let api!: Api;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  calls = [];
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function serve(...responses: Response[]) {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      method: init.method ?? 'GET',
      ifMatch: headers.get('if-match'),
      key: headers.get('idempotency-key'),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
}
function Editor({ name, snapshot }: { name: string; snapshot: { id: string; revision: number; values: object } }) {
  api = useApiClient();
  writers[name] = useConflictCommand(RECORDS, snapshot, async () => {
    const row = (await api.request(path)) as ReturnType<typeof record>;
    return { id: row.id, revision: row.revision, values: row };
  });
  return null;
}
const page = (...editors: unknown[]) =>
  act(() => root.render(h(SessionProvider, { session }, h(ConflictCommands, null, ...editors))));
const snapshot = (revision: number, remark: string) => ({ id: 'r-1', revision, values: record(revision, remark) });
const save = (writer: Writer, remark: string) =>
  writer.run({
    values: { remark },
    editableFields: ['remark'],
    send: async ({ edited, command }: { edited: object; command: object }) => {
      const row = (await api.request(path, {
        method: 'PUT',
        command: { ...command, body: { ...edited } },
      })) as { id: string };
      return { id: row.id };
    },
  });

describe('AC-FE-F142 ConflictCommands', () => {
  it('409 走重读 → 核对差异 → 重提：重提带最新版本与新命令 ID，只发改过的字段', async () => {
    serve(
      failure(409, 'REVISION_CONFLICT'),
      json(200, record(4, '他人备注')),
      json(200, record(5, '我的备注'), { etag: '"5"' }),
    );
    await page(h(Editor, { key: 'a', name: 'a', snapshot: snapshot(3, '原备注') }));
    await act(() => expect(save(writers.a!, '我的备注')).rejects.toThrow());
    expect(writers.a!.form.status).toBe('conflict');
    expect(writers.a!.stale).toBe(true);
    await act(() => writers.a!.form.reload!());
    expect(writers.a!.form.state?.differences).toEqual([
      { field: 'remark', before: '原备注', latest: '他人备注', mine: '我的备注' },
    ]);
    expect(writers.a!.full).toEqual(record(4, '他人备注'));
    await act(() => writers.a!.form.confirm());
    await act(() => save(writers.a!, '我的备注'));
    expect(calls.map((call) => [call.method, call.ifMatch])).toEqual([
      ['PUT', '3'],
      ['GET', null],
      ['PUT', '4'],
    ]);
    expect(calls[2]!.key).not.toBe(calls[0]!.key);
    expect(calls[2]!.body).toEqual({ remark: '我的备注' });
  });

  it('结果未知与 409 分开处理：关闭重开、列表刷新到新版本、换入口都仍锁定，不发第二条命令', async () => {
    serve(failure(503, 'SERVICE_UNAVAILABLE'));
    await page(h(Editor, { key: 'a', name: 'a', snapshot: snapshot(3, '原备注') }));
    await act(() => expect(save(writers.a!, '我的备注')).rejects.toThrow());
    expect(writers.a!.form.status).toBe('unknown');
    const command = writers.a!.form.state?.command?.id;
    await page();
    await page(h(Editor, { key: 'b', name: 'b', snapshot: snapshot(4, '我的备注') }));
    expect(writers.b!.form.status).toBe('unknown');
    expect(writers.b!.form.locked).toBe(true);
    expect(writers.b!.form.state?.command?.id).toBe(command);
    await page(h(Editor, { key: 'c', name: 'c', snapshot: snapshot(4, '我的备注') }));
    await act(() => expect(save(writers.c!, '再改一次')).rejects.toThrow());
    expect(writers.c!.form.state?.command?.id).toBe(command);
    expect(calls).toHaveLength(1);
  });

  it('确认的 409 不跨版本锁定：关闭后列表刷新到新版本，重开即可按新版本保存', async () => {
    serve(failure(409, 'REVISION_CONFLICT'), json(200, record(5, '我的备注'), { etag: '"5"' }));
    await page(h(Editor, { key: 'a', name: 'a', snapshot: snapshot(3, '原备注') }));
    await act(() => expect(save(writers.a!, '我的备注')).rejects.toThrow());
    await page();
    await page(h(Editor, { key: 'b', name: 'b', snapshot: snapshot(4, '他人备注') }));
    expect(writers.b!.form.locked).toBe(false);
    await act(() => save(writers.b!, '我的备注'));
    expect(calls.map((call) => call.ifMatch)).toEqual(['3', '4']);
  });
});

describe('AC-FE-F142 useCommandForm 恢复槽', () => {
  type Form = ReturnType<typeof useCommandForm>;
  let form!: Form;
  function Open({ date }: { date: string }) {
    form = useCommandForm(slotKey('/api/tenant/org/organizations', 'o-1'));
    return h('span', null, String(slotContext(form.state)?.date ?? date));
  }
  const render = (date?: string) =>
    act(() =>
      root.render(h(SessionProvider, { session }, h(FormCommands, null, date ? h(Open, { key: date, date }) : null))),
    );
  it('结果未知后换日期重开：落在同一个槽、仍锁定，显示槽里保存的业务时点', async () => {
    serve(failure(503, 'SERVICE_UNAVAILABLE'));
    await render('2026-10-01');
    await act(async () => {
      await form.submit({
        values: { name: '合成组织' },
        baseline: { name: '原组织' },
        editableFields: ['name'],
        revision: 2,
        businessId: 'o-1',
        context: { date: '2026-10-01' },
        send: (command: object) => createApiClient(() => session).request(path, { method: 'PATCH', command }),
      });
    });
    await render();
    await render('2026-10-09');
    expect(form.locked).toBe(true);
    expect(host.textContent).toBe('2026-10-01');
  });
});
