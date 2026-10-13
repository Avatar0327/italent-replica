/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { beginHrWrite, finishHrWrite, readHrSession } from '../../apps/web/src/transfer/hr-session.js';
import { draftRows } from '../../apps/web/src/transfer/draft-fields.js';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('AC-FE-R1c-11 DEC-464 暂存目录只存单号，按租户 / 身份隔离且保留其他暂存单', () => {
  const scope = JSON.stringify(['tenant', 'identity']);
  beginHrWrite(scope);
  finishHrWrite(scope, 'draft-a');
  beginHrWrite(scope);
  finishHrWrite(scope, 'draft-b');
  expect(readHrSession(scope)).toEqual({ processing: false, drafts: ['draft-a', 'draft-b'] });
  expect(readHrSession(JSON.stringify(['tenant', 'other']))).toEqual({ processing: false, drafts: [] });
  expect(readHrSession(JSON.stringify(['other', 'identity']))).toEqual({ processing: false, drafts: [] });
});

it('AC-FE-R1c-12 DEC-464 未确认标记禁止新命令，不持久化编号或载荷', () => {
  beginHrWrite('scope');
  expect(readHrSession('scope')).toEqual({ processing: true, drafts: [] });
  expect(() => beginHrWrite('scope')).toThrow();
  expect(JSON.parse(sessionStorage.getItem('italent.transfer.l2:scope')!)).toEqual({
    processing: true,
    drafts: [],
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

it('AC-FE-R1c-17 DEC-464 草稿选项区分 true / false / null / 未读取，保留嵌套返回字段', () => {
  const rows = draftRows(
    {
      id: 'draft',
      revision: 3,
      employeeRevision: 4,
      status: 'draft',
      withEstablishment: true,
      fields: { place: '服务端工作地' },
      customFields: { custom: '服务端自定义' },
    },
    { adjustSalary: true, contract: null, onTrial: { months: 3 }, dutyTransfer: { subordinates: [] } },
  );
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ label: '带编调动', value: '是' }),
      expect.objectContaining({ label: '是否调整薪资', value: '是' }),
      expect.objectContaining({ label: '是否变更合同', value: '否' }),
      expect.objectContaining({ label: '试岗开始日期', value: '未读取' }),
      expect.objectContaining({ label: '试岗期限（月）', value: '3' }),
      expect.objectContaining({ label: '交接人', value: '未读取' }),
      expect.objectContaining({ label: '工作地', value: '服务端工作地' }),
      expect.objectContaining({ label: 'custom', value: '服务端自定义' }),
    ]),
  );
  const hidden = draftRows({ id: 'draft', revision: 3, employeeRevision: 4, status: 'draft' }, {});
  expect(hidden.find((row) => row.label === '带编调动')?.value).toBe('未读取');
  expect(hidden.find((row) => row.label === '是否调整薪资')?.value).toBe('未读取');
  expect(
    draftRows(
      { id: 'draft', revision: 3, employeeRevision: 4, status: 'draft', withEstablishment: false },
      {
        adjustSalary: false,
      },
    ).find((row) => row.label === '是否调整薪资')?.value,
  ).toBe('否');
});

it('AC-FE-R1c-19 DEC-467 异动类型只读取 transferTypeCode，不使用系统变动类型', () => {
  const business = {
    id: 'draft',
    revision: 1,
    employeeRevision: 4,
    status: 'draft',
    transferTypeCode: 'transfer',
    changeType: 'position_adjustment',
  };
  expect(draftRows(business, {}).find((row) => row.label === '异动类型')).toEqual({
    key: 'transferTypeCode',
    label: '异动类型',
    value: 'transfer',
  });
});

it.each([null, 'position_adjustment'])(
  'AC-FE-R1c-19 DEC-467 缺少异动类型时显示未读取（changeType=%s）',
  (changeType) => {
    const business = { id: 'draft', revision: 1, employeeRevision: 4, status: 'draft', changeType };
    expect(draftRows(business, {}).find((row) => row.label === '异动类型')?.value).toBe('未读取');
  },
);
