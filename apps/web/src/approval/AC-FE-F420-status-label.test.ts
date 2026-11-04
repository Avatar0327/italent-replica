import { describe, expect, it } from 'vitest';
import { instanceStatus, statusLabels } from './messages';

/**
 * F-420：被离职终止的审批实例状态码是 cancelled（revokeBySystem），界面一律显示“已终止”：
 * 列表与卡片走 instanceStatus，兜底的 statusLabels 与之同一文案，不再显示“已作废”。
 */
describe('F-420 审批实例被终止的状态文案', () => {
  it('cancelled 的兜底文案与列表文案一致，都是“已终止”', () => {
    expect(instanceStatus.cancelled?.label).toBe('已终止');
    expect(statusLabels.cancelled).toBe('已终止');
  });
});
