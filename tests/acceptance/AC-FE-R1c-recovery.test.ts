/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { beginHrWrite, finishHrWrite, readHrSession } from '../../apps/web/src/transfer/hr-session.js';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('AC-FE-R1c-11 DEC-464 / DEC-511 暂存索引只存单号与类型（按人一份），按租户 / 身份隔离且保留其他人的暂存', () => {
  const scope = JSON.stringify(['tenant', 'identity']);
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: 'employee-a', draft: { id: 'draft-a', transferTypeCode: 'transfer' } });
  beginHrWrite(scope);
  finishHrWrite(scope, { employeeId: 'employee-b', draft: { id: 'draft-b' } });
  expect(readHrSession(scope)).toEqual({
    processing: false,
    drafts: { 'employee-a': { id: 'draft-a', transferTypeCode: 'transfer' }, 'employee-b': { id: 'draft-b' } },
  });
  expect(readHrSession(JSON.stringify(['tenant', 'other']))).toEqual({ processing: false, drafts: {} });
  expect(readHrSession(JSON.stringify(['other', 'identity']))).toEqual({ processing: false, drafts: {} });
});

it('AC-FE-R1c-12 DEC-464 未确认标记禁止新命令，不持久化编号或载荷', () => {
  beginHrWrite('scope');
  expect(readHrSession('scope')).toEqual({ processing: true, drafts: {} });
  expect(() => beginHrWrite('scope')).toThrow();
  expect(JSON.parse(sessionStorage.getItem('italent.transfer.l2:scope')!)).toEqual({
    processing: true,
    drafts: {},
  });
});

it('AC-FE-R1c-12 DEC-464 存储不可用必须在写请求之前失败', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota');
    },
  });
  expect(() => beginHrWrite('scope')).toThrow('quota');
});

// AC-FE-R1c-17 / R1c-19 原测“我的申请”暂存单详情；F-153（DEC-511）撤掉该列表，异动类型的取值改由
// AC-FE-F153-04（选人带出暂存时取 transferTypeCode，不用 changeType）覆盖。
