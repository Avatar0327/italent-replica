/**
 * F-141 ②（DEC-500）：TRF-13 被退回后，员工“我的申请”应显示“已退回”，不是“审批中”。
 * 后端 applicationStatus 与前端 statusText（manager-messages 的状态表）必须是同一份文案。
 */
import { describe, expect, it } from 'vitest';
import { applicationStatus } from '../../apps/api/src/modules/employee-self-service/queries.js';
import { statusText } from '../../apps/web/src/self-service/pages/model.js';

describe('AC-F141-returned-status 我的申请状态文案（DEC-500②）', () => {
  it('returned 显示“已退回”，running 仍是“审批中”', () => {
    expect(applicationStatus('returned')).toBe('已退回');
    expect(applicationStatus('running')).toBe('审批中');
  });

  it('approved 通过；其余终态（取消 / 撤回 / 未通过）显示“已终止”', () => {
    expect(applicationStatus('approved')).toBe('通过');
    for (const state of ['cancelled', 'withdrawn', 'rejected']) expect(applicationStatus(state), state).toBe('已终止');
  });

  it('前端状态表对 returned 与后端同文案，且经后端文案再映射不变（同一映射入口）', () => {
    expect(statusText('returned')).toBe(applicationStatus('returned'));
    expect(statusText(applicationStatus('returned'))).toBe('已退回');
    expect(statusText('running')).toBe(applicationStatus('running'));
  });
});
