import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import {
  employmentBusinessObjects,
  employmentCycles,
  employmentEmployees,
  employmentPayloadVersions,
  employmentStateEvents,
  exitRequests,
  retirementRequests,
  transferLinkageDuties,
  transferLinkageVersions,
  withTenant,
  type Db,
} from '@italent/db';
import { EMPLOYEE_STATUS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runDueExitDutyTransfers } from '../../apps/api/src/modules/employment/exit-duty-due.js';
import { dutyExitWorld } from './AC-DT-exit-support.js';

const database = useTestDb();
const lastWorkDate = '2026-10-20';
const effectiveDate = '2026-10-21';
const earlier = '2026-10-11';
const due = '2026-10-12';

/** 批量补齐队列前缀，每单各有员工及周期，历史版本保留职责，最新版本为空。 */
async function seedClearedPrefix(db: Db, tenantId: string, userId: string, subordinateId: string, receiverId: string) {
  const rows = Array.from({ length: 99 }, (_, index) => ({
    tenantId,
    employeeId: randomUUID(),
    staffId: randomUUID(),
    businessId: randomUUID(),
    payloadVersionId: randomUUID(),
    originalVersionId: randomUUID(),
    name: `ZZ_F538_已清空_${index}`,
  }));
  await withTenant(db, tenantId, async (tx) => {
    await tx.insert(employmentEmployees).values(rows.map((row) => ({ tenantId, id: row.employeeId, name: row.name })));
    await tx.insert(employmentCycles).values(
      rows.map(({ employeeId, staffId }) => ({
        tenantId,
        employeeId,
        id: staffId,
        entryDate: '2026-09-01',
        entryType: 'hire',
        employType: 'internal',
      })),
    );
    await tx.insert(employmentBusinessObjects).values(
      rows.map(({ employeeId, businessId }) => ({
        tenantId,
        employeeId,
        id: businessId,
        revision: 2,
      })),
    );
    await tx.insert(employmentPayloadVersions).values(
      rows.map((row) => ({
        tenantId,
        id: row.payloadVersionId,
        employeeId: row.employeeId,
        businessId: row.businessId,
        selectedStaffId: row.staffId,
        versionNo: 1,
        kind: 'retirement',
        mode: 'direct',
        effectiveDate,
        plannedEffectiveDate: effectiveDate,
        lastWorkDate,
        employeeStatus: EMPLOYEE_STATUS.retired,
        formId: 'standard',
        employType: 'internal',
      })),
    );
    await tx.insert(employmentStateEvents).values(
      rows.map(({ employeeId, businessId, payloadVersionId }) => ({
        tenantId,
        employeeId,
        businessId,
        payloadVersionId,
        state: 'approved',
        eventNo: 1,
        commandId: randomUUID(),
      })),
    );
    await tx.insert(exitRequests).values(
      rows.map(({ employeeId, businessId, staffId }) => ({
        tenantId,
        employeeId,
        businessId,
        staffId,
        mode: 'direct',
        initiator: 'hr',
        initiatorUserId: userId,
        dutyTransferTiming: 'specified_date',
        dutyTransferDate: earlier,
      })),
    );
    await tx.insert(retirementRequests).values(
      rows.map(({ employeeId, businessId }) => ({
        tenantId,
        employeeId,
        businessId,
      })),
    );
    await tx.insert(transferLinkageVersions).values(
      rows.flatMap(({ employeeId, businessId, originalVersionId }) => [
        { id: originalVersionId, tenantId, employeeId, businessId, versionNo: 1, commandId: randomUUID() },
        { tenantId, employeeId, businessId, versionNo: 2, commandId: randomUUID() },
      ]),
    );
    await tx.insert(transferLinkageDuties).values(
      rows.map(({ originalVersionId }) => ({
        tenantId,
        versionId: originalVersionId,
        lineNo: 1,
        itemType: 'duty_subordinate',
        subordinateId,
        relation: 'direct',
        receiverId,
      })),
    );
  });
}

it('AC-EN-F538-08 清空的 100 单不占到期额度，后续离职计划在指定日期执行且只执行一次', async () => {
  const db = database().db;
  const x = await dutyExitWorld(db, 'ZZ_F538_指定日期队列');
  const { tenant, user } = x.session;
  const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_清空下属');
  const receiver = await x.peer('ZZ_F538_指定接收人');
  const cleared = await x.directRetire(lastWorkDate, {
    dutyTransferTiming: 'specified_date',
    dutyTransferDate: earlier,
    dutyTransfer: x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] }),
  });
  const clear = await x.patchExit(cleared.id, cleared.revision, { dutyTransfer: null }, 'retirement');
  expect(clear.status, await clear.clone().text()).toBe(200);
  const before = await x.stateOf(x.employee.id);
  await seedClearedPrefix(db, tenant.id, user.id, subordinate.id, receiver.id);

  const leaver = await x.peer('ZZ_F538_有效计划离职人');
  const nextSubordinate = await x.subordinateOf(leaver.id, 'ZZ_F538_到期转交下属');
  const active = await x.createdLeave(
    leaver.id,
    x.bodyOf('leave', lastWorkDate, 'direct', {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: due,
      dutyTransfer: x.plan({ subordinates: [{ employeeId: nextSubordinate.id, receiverId: receiver.id }] }),
    }),
  );

  const run = (hour: string) => runDueExitDutyTransfers(db, tenant, new Date(`${due}T${hour}:00:00Z`), randomUUID());
  expect(await run('02')).toEqual({ completed: 1, failed: 0, skippedLocked: 0, errors: [] });
  expect(await x.managerOf(nextSubordinate.id, due)).toBe(receiver.id);
  expect(await x.items(active.id)).toMatchObject([{ status: 'succeeded', effective: due }]);
  expect(await x.stateOfBusiness(active.id)).toBe('approved');
  expect(await run('05')).toEqual({ completed: 0, failed: 0, skippedLocked: 0, errors: [] });
  expect(await x.items(active.id)).toHaveLength(1);
  expect(await x.managerOf(subordinate.id, due)).toBe(x.employee.id);
  expect(await x.items(cleared.id)).toEqual([]);
  expect(await x.stateOf(x.employee.id)).toEqual(before);
});
