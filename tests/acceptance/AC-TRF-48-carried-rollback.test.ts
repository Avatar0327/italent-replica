import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { EmploymentBusiness } from './AC-EMP-support.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { snapshot } from './support/revocable-rights.js';
const database = useTestDb();

describe('AC-TRF-48 带编调动沿已有撤销/删除路径反向调整', () => {
  it.each(['delete', 'revoke', 'withdraw'])('%s 恢复原细分与预留，重复命令不重复回退', async (action) => {
    const w = await carriedWorld(database().db, `carried-${action}`, { matched: false });
    const before = await w.capacities();
    const response = await w.save(await w.hired(), action === 'delete' ? {} : { mode: 'application', submit: true });
    expect(response.status, await response.clone().text()).toBe(201);
    const business = (await response.json()) as { id: string; revision: number };
    const execute = () =>
      w.session.request(
        action === 'delete' ? 'DELETE' : 'POST',
        `/businesses/${business.id}${action === 'delete' ? '' : `/${action}`}`,
        {
          ifMatch: business.revision,
          idempotencyKey: `carried-${action}`,
          body: {},
        },
      );
    const removed = await execute();
    expect(removed.status, await removed.clone().text()).toBe(200);
    const after = await w.capacities();
    for (let i = 0; i < before.length; i++)
      expect(after[i]).toMatchObject({
        localCapacity: before[i]!.localCapacity,
        reservedLocal: before[i]!.reservedLocal,
        subdivisions: before[i]!.subdivisions,
      });
    expect(await w.history()).toHaveLength(4);
    expect((await execute()).status).toBe(200);
    expect(await w.history()).toHaveLength(4);
    if (action === 'withdraw') {
      const current = await w.business(business.id);
      const resubmitted = await w.session.request('POST', `/businesses/${business.id}/submit`, {
        ifMatch: current.revision,
        body: {},
      });
      expect(resubmitted.status, await resubmitted.clone().text()).toBe(200);
      expect((await w.capacities())[1]).toMatchObject({ localCapacity: 1 });
      expect(await w.history()).toHaveLength(6);
    }
  });
});

async function consumedDraft(label: string, targetStrict: boolean) {
  const w = await carriedWorld(database().db, label, { targetStrict });
  const mover = await w.hired();
  expect((await w.capacities())[1]).toMatchObject({ localCapacity: 0 });
  const saved = await w.save(mover, { mode: 'application' });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const draft = (await saved.json()) as EmploymentBusiness;
  expect(draft.status).toBe('draft');
  expect((await w.capacities())[1]).toMatchObject({ localCapacity: 1 });
  const occupant = await w.hired('合成占编员工');
  const occupied = await w.save(occupant, { withEstablishment: false });
  expect(occupied.status, await occupied.clone().text()).toBe(201);
  const readState = async () => ({
    capacities: await w.capacities(),
    employment: await snapshot(w.db, w.session.tenant.id),
    history: await w.history(),
    employee: await w.session.getEmployee(mover.employee.id),
    draft: await w.business(draft.id),
    slot: await w.session.request('GET', `/transfers/employees/${mover.employee.id}/draft`).then((res) => res.json()),
  });
  const paths = {
    通用删除: `/businesses/${draft.id}`,
    清除暂存: `/transfers/employees/${mover.employee.id}/draft/${draft.id}`,
  };
  const remove = (entry: keyof typeof paths, confirmed?: boolean) =>
    w.session.request('DELETE', paths[entry], {
      ifMatch: draft.revision,
      ...(confirmed === undefined ? {} : { body: { confirmed } }),
    });
  return { w, draft, readState, remove };
}

describe.each(['通用删除', '清除暂存'] as const)('AC-EST-20 携编草稿 · %s', (entry) => {
  it('非严格：未确认要求确认并回滚容量、状态、revision、审计，带确认才删除', async () => {
    const { w, draft, readState, remove } = await consumedDraft(`est20-carried-warning-${entry}`, false);
    const before = await readState();
    expect(before.slot).toMatchObject({ draft: { id: draft.id, revision: draft.revision } });
    const warning = await remove(entry);
    expect(warning.status, await warning.clone().text()).toBe(409);
    expect(await warning.json()).toMatchObject({
      error: {
        details: {
          reason: 'CONFIRMATION_REQUIRED',
          warnings: [{ departmentId: w.to.id, reason: 'ESTABLISHMENT_EXCEEDED' }],
        },
      },
    });
    expect(await readState()).toEqual(before);
    const deleted = await remove(entry, true);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toMatchObject({ status: 'deleted', revision: draft.revision + 1 });
    expect((await w.capacities())[1]).toMatchObject({ localCapacity: 0 });
    expect(await w.history()).toHaveLength(before.history.length + 2);
  });

  it('严格：即使带确认仍拒绝，容量、状态、revision、审计全部回滚', async () => {
    const { readState, remove } = await consumedDraft(`est20-carried-strict-${entry}`, true);
    const before = await readState();
    const blocked = await remove(entry, true);
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
    expect(await readState()).toEqual(before);
  });
});

it('已转入的额度被其他员工占用：回退严格超编时，业务、容量与审计整体保持原状', async () => {
  const w = await carriedWorld(database().db, 'carried-consumed');
  const response = await w.save(await w.hired());
  expect(response.status).toBe(201);
  const business = (await response.json()) as { id: string; revision: number };
  const occupant = await w.session.employee('合成后来占编员工');
  await w.session.business(
    occupant.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-10-01',
      fields: { departmentId: w.to.id, positionId: w.targetPosition },
    },
    occupant.revision,
  );
  const before = await w.capacities();
  const history = await w.history();
  const result = await w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: business.revision });
  expect(result.status, await result.clone().text()).toBe(409);
  expect(await result.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_EXCEEDED' } } });
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual(history);
  expect(await w.business(business.id)).toMatchObject({ status: 'effective' });
});
