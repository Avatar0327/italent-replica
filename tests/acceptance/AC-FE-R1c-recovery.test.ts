/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { beginHrWrite, finishHrWrite, readHrSession } from '../../apps/web/src/transfer/hr-session.js';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('AC-FE-R1c-11 DEC-464 处理标记按租户 / 身份隔离，不再存暂存索引', () => {
  const scope = JSON.stringify(['tenant', 'identity']);
  beginHrWrite(scope);
  expect(readHrSession(scope)).toEqual({ processing: true });
  expect(readHrSession(JSON.stringify(['tenant', 'other']))).toEqual({ processing: false });
  expect(readHrSession(JSON.stringify(['other', 'identity']))).toEqual({ processing: false });
  finishHrWrite(scope);
  expect(readHrSession(scope)).toEqual({ processing: false });
});

it('AC-FE-R1c-12 DEC-464 未确认标记禁止新命令，不持久化编号或载荷', () => {
  beginHrWrite('scope');
  expect(readHrSession('scope')).toEqual({ processing: true });
  expect(() => beginHrWrite('scope')).toThrow();
  expect(JSON.parse(sessionStorage.getItem('italent.transfer.l2:scope')!)).toEqual({
    processing: true,
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

it('AC-FE-R1c-12 DEC-464 会话损坏时不能通过完成回执覆盖处理状态', () => {
  sessionStorage.setItem('italent.transfer.l2:scope', '{');
  expect(() => finishHrWrite('scope')).toThrow();
  expect(sessionStorage.getItem('italent.transfer.l2:scope')).toBe('{');
});

// AC-FE-R1c-17 / R1c-19 原测“我的申请”暂存单详情；F-153（DEC-511）撤掉该列表，异动类型的取值改由
// AC-FE-F153-04（选人带出暂存时取 transferTypeCode，不用 changeType）覆盖。
