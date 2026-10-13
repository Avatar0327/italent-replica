/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import {
  confirmedReceipt,
  leaveRecovery,
  prepareReceipt,
  readRecovery,
  rememberRecovery,
  sendOriginal,
} from '../../apps/web/src/transfer/recovery.js';
import type { TransferFormModel } from '../../apps/web/src/transfer/types.js';

const model = {
  employeeId: 'synthetic-employee',
  effectiveDate: '2026-11-01',
  transferTypeCode: 'transfer',
  reasonCode: '',
  fields: { place: '合成工作地' },
  customFields: {},
  catalog: { types: [], reasons: [] },
  preview: { employeeRevision: 3, form: { id: 'form' } },
} as unknown as TransferFormModel;
const saved = { id: 'saved', revision: 4, employeeRevision: 3, status: 'draft', fields: { place: '合成旧值' } };
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it('AC-FE-R1c-11 会话按租户和身份隔离，其他员工 / 表单暂存不被新申请清除', () => {
  const scope = JSON.stringify(['tenant', 'identity']);
  const a = confirmedReceipt(prepareReceipt(model, 'draft', null), saved);
  const b = confirmedReceipt(prepareReceipt({ ...model, employeeId: 'other' }, 'draft', null), { ...saved, id: 'b' });
  const c = confirmedReceipt(
    prepareReceipt(
      {
        ...model,
        preview: {
          ...model.preview!,
          form: {
            ...model.preview!.form,
            id: 'other-form',
          },
        },
      },
      'draft',
      null,
    ),
    { ...saved, id: 'c' },
  );
  for (const receipt of [a, b, c]) rememberRecovery(scope, receipt);
  leaveRecovery(scope, c);
  expect(readRecovery(scope).active).toBeUndefined();
  expect(Object.values(readRecovery(scope).entries).map((entry) => entry.saved?.id)).toEqual(['saved', 'b', 'c']);
  expect(readRecovery(JSON.stringify(['tenant', 'other'])).entries).toEqual({});
  expect(readRecovery(JSON.stringify(['other', 'identity'])).entries).toEqual({});
  expect(readRecovery(scope).entries[a.key]!.saved).not.toHaveProperty('fields');
});

it('AC-FE-R1c-12 原命令跨存储恢复保留路径、revision、载荷和编号，不引用后续编辑', async () => {
  const receipt = prepareReceipt(model, 'draft', null);
  rememberRecovery('scope', receipt);
  const restored = readRecovery('scope').entries[receipt.key]!;
  const fetcher = vi.fn(async () => Response.json(saved));
  vi.stubGlobal('fetch', fetcher);
  await sendOriginal('tenant', restored);
  const [path, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(receipt.pending.path);
  expect(new Headers(options.headers).get('if-match')).toBe('3');
  expect(new Headers(options.headers).get('idempotency-key')).toBe(receipt.pending.id);
  expect(options.body).toBe(receipt.pending.body);
  const submit = prepareReceipt(model, 'submit', saved);
  expect(submit.pending.path).toBe('/api/tenant/employment/businesses/saved/submit');
  expect(submit.pending.revision).toBe(4);
  expect(submit.pending.body).toBe('{}');
});

it('AC-FE-R1c-12 无法保存原命令时显式失败，不能静默丢弃恢复记录', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
    clear: () => {},
  });
  expect(() => rememberRecovery('scope', prepareReceipt(model, 'draft', null))).toThrow('quota');
});
