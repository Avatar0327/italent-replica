import { describe, expect, it, vi } from 'vitest';
import type { Values } from '../foundation/forms/values.js';
import { regularizeSend, type Send } from './commands.js';

// F-445：转正表单提交命令的三条分支（原嵌套三元拆成 regularizeSend），只锁选择本身，命令内容由 useSends 负责
const sendOf = (path: string): Send => ({ path, body: () => ({}), accept: () => undefined });

function sends() {
  const direct = sendOf('/regularizations');
  const patch = vi.fn((id: string) => sendOf(`patch:${id}`));
  const step = vi.fn((id?: string) => sendOf(`step:${id ?? 'new'}`));
  return { direct, patch, step };
}

const values: Values = { effectiveDate: '2026-12-01', probationResult: 'normal' };
const draft = { id: '50000000-0000-4000-8000-000000000445' };

describe('AC-FE-F445 转正提交命令的选择（行为同拆分前）', () => {
  it('直接转正：走 POST /regularizations，不碰草稿命令', () => {
    const s = sends();
    expect(regularizeSend(s, { application: false, changed: false }, values)).toBe(s.direct);
    expect(regularizeSend(s, { changed: false }, values)).toBe(s.direct);
    expect(s.patch).not.toHaveBeenCalled();
    expect(s.step).not.toHaveBeenCalled();
  });

  it('转正申请没有草稿：建草稿（step 不带单据 ID，带表单值）', () => {
    const s = sends();
    expect(regularizeSend(s, { application: true, changed: false }, values).path).toBe('step:new');
    expect(s.step).toHaveBeenCalledWith(undefined, values);
    expect(s.patch).not.toHaveBeenCalled();
  });

  it('有草稿且改过已确认值：先 PATCH 同一张草稿', () => {
    const s = sends();
    expect(regularizeSend(s, { application: true, draft, changed: true }, values).path).toBe(`patch:${draft.id}`);
    expect(s.patch).toHaveBeenCalledWith(draft.id, values);
    expect(s.step).not.toHaveBeenCalled();
  });

  it('有草稿且没改：直接提交同一张草稿', () => {
    const s = sends();
    expect(regularizeSend(s, { application: true, draft, changed: false }, values).path).toBe(`step:${draft.id}`);
    expect(s.step).toHaveBeenCalledWith(draft.id, values);
    expect(s.patch).not.toHaveBeenCalled();
  });
});
