// @vitest-environment happy-dom
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { useOpening } from '../intern/commands.js';
import { useProbationRead } from './ProbationForm.js';

const employeeId = '30000000-0000-4000-8000-000000000021';
const session = {
  tenantId: 'synthetic-tenant',
  identityKey: 'synthetic-user',
  tenantName: '合成租户',
  timezone: 'Asia/Shanghai',
  displayName: '合成用户',
  source: 'server' as const,
};
// 形状照 probation.ts probationDetail
const detail = {
  employeeId,
  revision: 4,
  recordId: '40000000-0000-4000-8000-000000000021',
  entryDate: '2026-08-01',
  hasProbation: true,
  startDate: '2026-08-01',
  months: 3,
  expectedEndDate: '2026-10-31',
  regularizationDate: null,
  actualEndDate: null,
  regularizationBusinessId: null,
  regularizationState: null,
  regularizationMode: null,
  probationResult: null,
  records: [],
};
let root: ReturnType<typeof createRoot>;
let reads: number;
// 同 AdjustForm → WithOpening：读取在上层建，打开在下层
function Opening({ read }: { read: Parameters<typeof useOpening>[0] }) {
  const opening = useOpening(read);
  return h('output', null, opening.data ? String(opening.data.revision) : '');
}
// tick 只用来让上层重渲染（如列表刷新时详情随之重渲染）
function Form(_: { tick: number }) {
  return h(Opening, { read: useProbationRead(employeeId) });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      reads += 1;
      return Response.json(detail);
    }),
  );
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

it('AC-FE-R2c1 打开编辑试用期后上层重渲染不重读试用详情：编辑基线只取打开时那一次', async () => {
  const render = (tick: number) => root.render(h(SessionProvider, { session, children: h(Form, { tick }) }));
  await act(async () => render(1));
  expect(document.querySelector('output')?.textContent).toBe('4');
  for (const tick of [2, 3]) await act(async () => render(tick));
  expect(reads).toBe(1);
});
