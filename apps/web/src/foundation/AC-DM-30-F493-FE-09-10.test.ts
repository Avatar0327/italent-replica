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

it.each([
  ['离职', (code: string | null) => exitCell({ id: 'synthetic', code }, 'code')],
  ['试用', (code: string | null) => probationCell({ code }, 'code')],
  ['实习', (code: string | null) => internCell({ id: 'synthetic', code }, 'code')],
  ['退休', (code: string | null) => retireCell({ id: 'synthetic', code }, 'code')],
  ['兼职', (code: string | null) => partCell({ id: 'synthetic', employee: { code } }, 'code', 'all')],
  ['合同', (code: string | null) => contractCell(code, 'code')],
  [
    '任职记录',
    (code: string | null) => recordCell({ id: 'synthetic', employeeId: 'synthetic', employeeCode: code }, 'code'),
  ],
  ['人员', (code: string | null) => fieldValue('code', code)],
] as const)('FE-09 %s列表空工号统一 --，非空原样', (_, render) => {
  expect(render(null)).toBe('--');
  expect(render('合成001')).toBe('合成001');
});

it('FE-10 全部用户依次显示登录用户名与联系邮箱，空登录名 --', () => {
  const columns = userColumns(false, () => {}, undefined, true);
  const simple = columns.filter((column) => 'dataIndex' in column);
  const login = simple.find((column) => 'dataIndex' in column && column.dataIndex === 'email')!;
  const contact = simple.find((column) => 'dataIndex' in column && column.dataIndex === 'contactEmail')!;
  expect(login?.title).toBe('登录用户名');
  expect(contact?.title).toBe('联系邮箱');
  expect(simple.indexOf(login)).toBeLessThan(simple.indexOf(contact));
  const row = { email: '', contactEmail: 'synthetic@example.com' } as User;
  expect(login.render!('', row, 0)).toBe('--');
  expect(contact.render!('synthetic@example.com', row, 0)).toBe('synthetic@example.com');
  expect(contact.render!(null, row, 0)).toBe('--');
});
