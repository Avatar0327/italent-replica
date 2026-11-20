/**
 * F-363 R2：已生效离职改期到未来（替代路径）复制原单用工形式，沿用判定以原单引用为基准，不以前驱为基准。
 * 历史入职记录经 PATCH /records 更正为 B 不向后传播，离职单仍是 A；A 停用后改期仍应放行。只用合成人员。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { disableForm, formRefused } from './AC-EMP-F363-support.js';

const database = useTestDb();
const FORM_A = 'regular';
const FORM_B = 'consultant';

/** 员工入职用工形式 A → 离职（保存 A）并生效 → 历史入职记录更正为启用的 B → 停用 A。 */
async function scene(label: string) {
  const x = await downstreamWorld(database().db, `f363-exit-replace-${label}`);
  const [first] = await x.timeline();
  const hireId = first!.record_id;
  const editHire = async (employmentForm: string) =>
    x.session.request('PATCH', `/records/${hireId}`, {
      ifMatch: (await x.business(hireId)).revision,
      body: { fields: { employmentForm } },
    });
  const toA = await editHire(FORM_A);
  expect(toA.status, await toA.clone().text()).toBe(200);
  const leave = await x.directLeave('2026-10-15');
  expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [leave.id] });
  x.setNow('2026-11-05T02:00:00Z');
  const toB = await editHire(FORM_B);
  expect(toB.status, await toB.clone().text()).toBe(200);
  const disabled = await disableForm(x.session.request, FORM_A);
  expect(disabled.status, await disabled.clone().text()).toBe(200);
  const reschedule = async (lastWorkDate: string) =>
    x.session.request('PATCH', `/exits/${leave.id}`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { lastWorkDate },
    });
  return { x, leave, editHire, reschedule };
}

it('AC-EMP-F363-26：离职单存 A、前驱已更正为 B，A 停用后离职改期到未来 → 200，后继单沿用原单的 A', async () => {
  const { x, leave, reschedule } = await scene('keep');
  expect((await x.business(leave.id)).fields).toMatchObject({ employmentForm: FORM_A });
  const response = await reschedule('2026-11-20');
  expect(response.status, await response.clone().text()).toBe(200);
  const { successor } = (await response.json()) as { successor: { id: string; status: string } };
  expect(successor).toMatchObject({ status: 'approved' });
  expect(successor.id).not.toBe(leave.id);
  expect((await x.business(successor.id)).fields).toMatchObject({ employmentForm: FORM_A });
  expect(await x.stateOfBusiness(leave.id)).toBe('deleted');
});

it('AC-EMP-F363-27：同一场景下真正改选停用的 A 仍 422（历史入职记录 B → A），改期不放宽新选约束', async () => {
  const { editHire, reschedule } = await scene('reselect');
  await formRefused(await editHire(FORM_A));
  const response = await reschedule('2026-11-20');
  expect(response.status, await response.clone().text()).toBe(200);
});
