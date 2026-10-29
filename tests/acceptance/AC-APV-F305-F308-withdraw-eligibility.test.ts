/** B1 合 main：F-308 的读写共用撤回资格须保留 F-305 / DEC-674 的交接终态例外。 */
import { expect, it } from 'vitest';
import { approvalWithdrawalFailure } from '../../apps/api/src/modules/approval/withdraw-eligibility.js';

it.each([
  ['employment', 'running', true],
  ['employment', 'returned', true],
  ['employment', 'approved', false],
  ['employment', 'disapproved', false],
  ['employment', 'withdrawn', false],
  ['employment', 'cancelled', false],
  ['exit_handover', 'running', true],
  ['exit_handover', 'returned', false],
  ['exit_handover', 'approved', false],
  ['exit_handover', 'disapproved', false],
  ['exit_handover', 'withdrawn', false],
  ['exit_handover', 'cancelled', false],
] as const)('DEC-674 / F-308：%s / %s 撤回资格=%s，读写与业务入口一致', (businessType, status, allowed) => {
  const instance = { businessType, status, initiatorUserId: 'fixture.initiator' };
  for (const fromBusiness of [false, true]) {
    const denied = approvalWithdrawalFailure(instance, instance.initiatorUserId, undefined, fromBusiness);
    if (allowed) expect(denied).toBeUndefined();
    else expect(denied).toMatchObject({ code: 'CONFLICT', details: { reason: 'APPROVAL_CLOSED' } });
  }
});

it.each(['employment', 'exit_handover'] as const)('AC-TRF-28 / F-308：%s 非发起人仍先按原原因拒绝', (businessType) => {
  const instance = { businessType, status: 'running' as const, initiatorUserId: 'fixture.initiator' };
  expect(approvalWithdrawalFailure(instance, 'fixture.other')).toMatchObject({
    code: 'FORBIDDEN',
    details: { reason: 'APPROVAL_NOT_INITIATOR' },
  });
});
