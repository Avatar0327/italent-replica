import { describe, expect, it } from 'vitest';
import { DirectError } from '../part-time/direct-api.js';
import { confirmationOf } from './model.js';

/**
 * F-400（DEC-725）：离职生效要终止的其他流程（个人信息类、意向申请等）进入 §8 确认集合后，
 * 后端在只有这类流程时返回 409 EXIT_FLOW_TERMINATION_ACK_REQUIRED（同带 ackToken）。
 * 结束实习 / 试用期离职共用 confirmationOf：它与旧两码同形，确认后带 pendingTransferAck 重提，不是确定的拒绝。
 */
const ackError = (reason: string) =>
  new DirectError(409, 'CONFLICT', '离职生效时将终止以下流程，请确认', { reason, ackToken: 'token-1' });

describe('AC-FE-F400 离职确认原因码', () => {
  it('EXIT_FLOW_TERMINATION_ACK_REQUIRED 返回 pendingTransferAck 确认项，与旧两码同形', () => {
    for (const reason of [
      'EXIT_FLOW_TERMINATION_ACK_REQUIRED',
      'EXIT_PENDING_TRANSFER_ACK_REQUIRED',
      'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED',
    ])
      expect(confirmationOf(ackError(reason)), reason).toEqual({
        message: '离职生效时将终止以下流程，请确认',
        extra: { pendingTransferAck: 'token-1' },
        pendingEntry: false,
      });
  });

  it('其他 409 原因或缺令牌仍是确定的拒绝', () => {
    expect(confirmationOf(ackError('EXIT_APPLICATIONS_TOO_MANY'))).toBeUndefined();
    const noToken = new DirectError(409, 'CONFLICT', 'x', { reason: 'EXIT_FLOW_TERMINATION_ACK_REQUIRED' });
    expect(confirmationOf(noToken)).toBeUndefined();
  });
});
