import { expect, it } from 'vitest';
import { cellValue as exitCell } from '../exit/exit-model.js';
import { cellValue as probationCell } from '../probation/model.js';
import { cellValue as internCell } from '../intern/model.js';
import { cellValue as retireCell } from '../retirement/model.js';
import { cellValue as partCell } from '../part-time/model.js';
import { value as contractCell } from '../contracts/model.js';
import { cell as recordCell } from '../employment-records/model.js';
import { fieldValue } from '../personnel/model.js';
import { userColumns } from '../settings/user-columns.js';
import type { User } from '../settings/model.js';

it('FE-09 各列表空工号统一 --，非空工号原样保留', () => {
  for (const code of [null, '合成001']) {
    const expected = code ?? '--';
    const row = { id: 'synthetic', employeeId: 'synthetic', code };
    expect(exitCell(row, 'code')).toBe(expected);
    expect(probationCell(row, 'code')).toBe(expected);
    expect(internCell(row as never, 'code')).toBe(expected);
    expect(retireCell(row, 'code')).toBe(expected);
    expect(partCell({ ...row, employee: { code } } as never, 'code', 'all')).toBe(expected);
    expect(contractCell(code, 'code')).toBe(expected);
    expect(recordCell({ ...row, employeeCode: code } as never, 'code')).toBe(expected);
    expect(fieldValue('code', code)).toBe(expected);
  }
});

it('FE-10 全部用户依次显示登录用户名与联系邮箱，空登录名 --', () => {
  const columns = userColumns(false, () => {}, undefined, true);
  const simple = columns.filter((column) => 'dataIndex' in column);
  const login = simple.find((column) => column.dataIndex === 'email')!;
  const contact = simple.find((column) => column.dataIndex === 'contactEmail')!;
  expect(login?.title).toBe('登录用户名');
  expect(contact?.title).toBe('联系邮箱');
  expect(simple.indexOf(login)).toBeLessThan(simple.indexOf(contact));
  const row = { email: '', contactEmail: 'synthetic@example.com' } as User;
  expect(login.render!('', row, 0)).toBe('--');
  expect(contact.render!('synthetic@example.com', row, 0)).toBe('synthetic@example.com');
  expect(contact.render!(null, row, 0)).toBe('--');
});
