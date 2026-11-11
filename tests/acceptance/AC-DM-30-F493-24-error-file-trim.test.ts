/**
 * AC-DM-30-F493-24（及 AC-43 的撤权部分）：错误文件按提交人“当前”字段权裁剪（S3c，设计 §8.2、DEC-804）。
 * 真实授权器下的导入操作员：保留功能权与导入按钮，只撤查看权；不豁免提交人。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import {
  EMPLOYEE_OBJECT_CODE,
  importOperator,
  PROFILE_OBJECT_CODE,
  RECORD_OBJECT_CODE,
} from './support/exit-import-operator.js';
import { readXlsx, valueAt } from './support/xlsx-read.js';

const database = useTestDb();
const MOBILE = '13800000001';
const HIDDEN_D = '[*部门编码]：无查看权限，错误原因已隐藏';

async function submitted(x: ImportWorld, op: Awaited<ReturnType<typeof importOperator>>, rows: readonly unknown[]) {
  const response = await op.submit(rows);
  expect(response.status, await response.clone().text()).toBe(202);
  const { batchId } = (await response.json()) as { batchId: string };
  await x.settle();
  return batchId;
}
const download = async (op: Awaited<ReturnType<typeof importOperator>>, batchId: string) =>
  op.get(`/exits/import/batches/${batchId}/error-file`);
const bookOf = async (response: Response) => {
  expect(response.status, await response.clone().text()).toBe(200);
  return readXlsx(Buffer.from(await response.arrayBuffer()));
};

describe('AC-DM-30-F493-24 错误文件按当前字段权裁剪', () => {
  it('撤任职 departmentId 查看权：D 列为空、错误原文换成 FIELD_HIDDEN；撤档案 mobilePhone：L 列为空', async () => {
    const x = await importWorld(database().db, '24');
    const op = await importOperator(x);
    const batchId = await submitted(x, op, [x.row(1, 'zzf496nope', { mobilePhone: MOBILE })]);

    const before = await bookOf(await download(op, batchId));
    expect(valueAt(before, 'D2')).toBe('zzf496nope');
    expect(valueAt(before, 'L2')).toBe(MOBILE);
    expect(valueAt(before, 'A2')).toBe('[*部门编码]：*部门编码【zzf496nope】不存在或者已被删除，请检查');

    await op.reconfigure({ noView: [[RECORD_OBJECT_CODE, 'departmentId']] });
    const noDept = await bookOf(await download(op, batchId));
    expect(noDept.cells.has('D2')).toBe(false);
    expect(valueAt(noDept, 'A2')).toBe(HIDDEN_D);
    expect(valueAt(noDept, 'L2')).toBe(MOBILE);

    await op.reconfigure({ noView: [[PROFILE_OBJECT_CODE, 'mobilePhone']] });
    const noPhone = await bookOf(await download(op, batchId));
    expect(noPhone.cells.has('L2')).toBe(false);
    expect(valueAt(noPhone, 'D2')).toBe('zzf496nope');
  });

  it('同租户另一位有导入权的用户下载：404；撤档案对象看全部范围：403', async () => {
    const x = await importWorld(database().db, '24-other');
    const op = await importOperator(x);
    const batchId = await submitted(x, op, [x.row(1, 'zzf496nope')]);
    // 世界管理员（全放行）也有导入权，但不是提交人
    const other = await x.session.request('GET', `/exits/import/batches/${batchId}/error-file`);
    expect(other.status).toBe(404);

    expect((await download(op, batchId)).status).toBe(200);
    await op.revokeScope(PROFILE_OBJECT_CODE);
    expect((await download(op, batchId)).status).toBe(403);
  });
});

describe('AC-DM-30-F493-24 B、E 列跟随的字段权（设计 §3.1、§8.2 R1 P2-1）', () => {
  it('撤人员对象 name 查看权：B 列留空、B 列错误换成 FIELD_HIDDEN（档案 name 仍可见不影响）', async () => {
    const x = await importWorld(database().db, '24-b');
    const op = await importOperator(x);
    const d = await x.dept('B列部门');
    const batchId = await submitted(x, op, [x.row(1, d.code, { name: null }), x.row(2, 'zzf496nope')]);
    const before = await bookOf(await download(op, batchId));
    expect(valueAt(before, 'A2')).toContain('[*姓名]：*姓名不能为空');
    expect(valueAt(before, 'B3')).toBe('合成乙');

    await op.reconfigure({ noView: [[EMPLOYEE_OBJECT_CODE, 'name']] });
    const after = await bookOf(await download(op, batchId));
    expect(after.cells.has('B3')).toBe(false);
    expect(valueAt(after, 'A2')).toBe('[*姓名]：无查看权限，错误原因已隐藏');
    expect(valueAt(after, 'D3')).toBe('zzf496nope');
  });

  it('撤任职 effectiveDate 查看权：E 列留空、E 列错误换成 FIELD_HIDDEN', async () => {
    const x = await importWorld(database().db, '24-e');
    const op = await importOperator(x);
    const d = await x.dept('E列部门');
    const batchId = await submitted(x, op, [x.row(1, d.code, { entryDate: '2023/13/01' })]);
    const before = await bookOf(await download(op, batchId));
    expect(valueAt(before, 'E2')).toBe('2023/13/01');
    expect(String(valueAt(before, 'A2'))).toContain('[*入职日期]：');

    await op.reconfigure({ noView: [[RECORD_OBJECT_CODE, 'effectiveDate']] });
    const after = await bookOf(await download(op, batchId));
    expect(after.cells.has('E2')).toBe(false);
    expect(String(valueAt(after, 'A2'))).toContain('[*入职日期]：无查看权限，错误原因已隐藏');
    expect(String(valueAt(after, 'A2'))).not.toContain('2023/13/01');
  });
});

describe('AC-DM-30-F493-24 下载准入范围（设计 §8.2：功能权、按钮、人员 / 档案两个对象的看全部）', () => {
  it('只撤任职对象看全部：仍 200，且按当前字段权裁剪；撤人员对象或档案对象看全部：403', async () => {
    const x = await importWorld(database().db, '24-scope');
    const op = await importOperator(x);
    const batchId = await submitted(x, op, [x.row(1, 'zzf496nope', { mobilePhone: MOBILE })]);
    await op.revokeScope(RECORD_OBJECT_CODE);
    await op.reconfigure({ noView: [[PROFILE_OBJECT_CODE, 'mobilePhone']] });
    const book = await bookOf(await download(op, batchId));
    expect(book.cells.has('L2')).toBe(false);
    expect(valueAt(book, 'D2')).toBe('zzf496nope');

    await op.revokeScope(EMPLOYEE_OBJECT_CODE);
    expect((await download(op, batchId)).status).toBe(403);
  });
});

describe('AC-DM-30-F493-43 撤权后的错误文件', () => {
  it('撤提交人档案 gender 查看权：第 02 行 A 列换成 FIELD_HIDDEN 文案，批次 error_count 仍为 10', async () => {
    const x = await importWorld(database().db, '43-trim');
    const op = await importOperator(x);
    const d = await x.dept('撤权部门');
    const cases: [string | null, string | null, string | null][] = [
      ['男', '汉族', '群众'],
      ['M', null, null],
      ['男性', null, null],
      ['abc', null, null],
      [null, '汉', null],
      [null, 'abc', null],
      [null, null, '党员'],
      [null, null, 'abc'],
      [null, null, null],
      ['女', '回族', '中共党员'],
      ['F', 'Han', '团员'],
    ];
    const batchId = await submitted(
      x,
      op,
      cases.map(([gender, nation, politicalStatus], i) => x.row(i + 1, d.code, { gender, nation, politicalStatus })),
    );
    await op.reconfigure({ noView: [[PROFILE_OBJECT_CODE, 'gender']] });
    const book = await bookOf(await download(op, batchId));
    expect(valueAt(book, 'A2')).toBe('[性别]：无查看权限，错误原因已隐藏');
    expect(book.cells.has('N2')).toBe(false);
    expect(valueAt(book, 'A5')).toContain('[民族]：民族【汉】'); // 未撤权的列照常
    expect(await x.batchOf(batchId)).toMatchObject({ error_count: 10, error_row_count: 8 });
  });
});
