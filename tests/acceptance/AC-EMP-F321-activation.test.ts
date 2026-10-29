/** F-321 / DEC-052：提前审批后字典停用是确定性业务失败，须进入失败待办与显式重试。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();

it('AC-EMP-F321-10：提前审批 → 停用 → 到期记录失败 → 重新启用后显式重试生效', async () => {
  const w = await activationWorld(database().db, 'f321-activation');
  const { employee, hire } = await w.hired();
  const approved = await w.approve(
    await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, employmentForm: 'regular' }),
    '2026-10-02T02:00:00Z',
  );
  expect(approved).toMatchObject({ status: 'approved', record: null, activation: { status: 'pending' } });
  const dictionary = await w.session.request('GET', '/employment-forms');
  expect(dictionary.status).toBe(200);
  const { items } = (await dictionary.json()) as { items: { id: string; code: string; revision: number }[] };
  const form = items.find((item) => item.code === 'regular')!;
  const disabled = await w.session.request('PUT', `/employment-forms/${form.id}`, {
    ifMatch: form.revision,
    body: { enabled: false },
  });
  expect(disabled.status, await disabled.clone().text()).toBe(200);
  const disabledForm = (await disabled.json()) as { revision: number };

  const run = await w.runScheduler('2026-10-05T01:00:00Z');
  expect(run).toMatchObject({ activated: [], failed: [approved.id], errors: [] });
  expect(await w.business(approved.id)).toMatchObject({
    status: 'approved',
    record: null,
    activation: { status: 'failed', failureCount: 1, failureReason: 'RULE_REJECTED' },
  });
  expect((await w.session.records(employee.id, '2026-10-05')).map((record) => record.id)).toEqual([hire.id]);
  expect(await w.todos()).toEqual([
    expect.objectContaining({
      id: approved.id,
      activation: expect.objectContaining({ status: 'failed', failureCount: 1, failureReason: 'RULE_REJECTED' }),
    }),
  ]);
  expect(
    (await w.auditEvents(approved.id)).find((event) => event.action === 'employment.activation.failed'),
  ).toMatchObject({
    after: {
      attempt: 1,
      reason: 'RULE_REJECTED',
      detail: {
        code: 'EMPLOYMENT_FORM_INVALID',
        rule: 'EMPLOYMENT_FORM_DISABLED',
        message: '用工形式不存在或已停用',
      },
    },
  });
  expect((await w.outboxEvents(approved.id)).map((event) => event.eventType)).toContain('employment.activation.failed');
  // 自动补跑不能把已失败业务当成 pending 反复尝试、重复计数。
  expect(await w.runScheduler('2026-10-05T02:00:00Z')).toMatchObject({ activated: [], failed: [], errors: [] });
  expect((await w.business(approved.id)).activation).toMatchObject({ status: 'failed', failureCount: 1 });

  const enabled = await w.session.request('PUT', `/employment-forms/${form.id}`, {
    ifMatch: disabledForm.revision,
    body: { enabled: true },
  });
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const retried = await w.retry(approved, '2026-10-05T03:00:00Z');
  expect(retried.status, await retried.clone().text()).toBe(200);
  expect(await retried.json()).toMatchObject({
    status: 'effective',
    record: { fields: { departmentId: w.to.id, employmentForm: 'regular', employmentFormName: '正式员工' } },
    activation: { status: 'effective', failureCount: 1, failureReason: null },
  });
  expect(await w.todos()).toEqual([]);
  expect(await w.session.records(employee.id, '2026-10-05')).toHaveLength(2);
});
