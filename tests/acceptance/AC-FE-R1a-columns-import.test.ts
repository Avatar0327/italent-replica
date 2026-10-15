// F-132 第 2 段（组织页）：列设置（原站 B2_03 居中两栏弹窗）与组织导入的纯函数规则。
// 导入回执按接口真实形状核对：200 { results: [{ sourceCode, code, status, orgId?, reason? }] }，与提交行同序。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const columns = () => import(resolve('apps/web/src/org/columns.ts'));
const importing = () => import(resolve('apps/web/src/org/import-model.ts'));
const DEFAULT = ['code', 'name', 'fullName', 'location', 'broadType', 'establishedOn', 'startDate', 'stopDate'];
const gate = (hidden: string[]) => ({ field: (name: string) => ({ visible: !hidden.includes(name) }) });

describe('AC-FE-R1a-40 组织列设置', () => {
  it('默认列即原站「启用的组织」列；恢复默认返回新数组', async () => {
    const { restoreOrgColumns } = await columns();
    const first = restoreOrgColumns();
    first.push('remarks');
    expect(restoreOrgColumns()).toEqual(DEFAULT);
  });

  it('无查看权的字段不进候选，也不成列', async () => {
    const { orgColumnOptions, visibleOrgColumns } = await columns();
    const allowed = orgColumnOptions(gate(['fullName', 'remarks']));
    expect(allowed).not.toContain('fullName');
    expect(allowed).not.toContain('remarks');
    expect(visibleOrgColumns(['code', 'fullName', 'name'], allowed)).toEqual(['code', 'name']);
  });

  it('机构ID、名称锁定：不能取消、不能拖动，其他字段拖不到它们前面', async () => {
    const { toggleOrgColumn, moveOrgColumn, toggleOrgColumnGroup } = await columns();
    expect(toggleOrgColumn(DEFAULT, 'code', false)).toEqual(DEFAULT);
    expect(moveOrgColumn(DEFAULT, 'name', 'stopDate')).toEqual(DEFAULT);
    expect(moveOrgColumn(DEFAULT, 'stopDate', 'code')).toEqual([
      'code',
      'name',
      'stopDate',
      'fullName',
      'location',
      'broadType',
      'establishedOn',
      'startDate',
    ]);
    expect(toggleOrgColumnGroup(DEFAULT, DEFAULT, false)).toEqual(['code', 'name']);
  });

  it('新勾选的字段排到末尾；拖动按目标位置排序；非候选字段不能加入', async () => {
    const { toggleOrgColumn, moveOrgColumn } = await columns();
    const added = toggleOrgColumn(DEFAULT, 'shortName', true);
    expect(added.at(-1)).toBe('shortName');
    expect(moveOrgColumn(added, 'shortName', 'fullName').slice(0, 4)).toEqual([
      'code',
      'name',
      'shortName',
      'fullName',
    ]);
    expect(toggleOrgColumn(DEFAULT, 'personInChargeId', true)).toEqual(DEFAULT);
  });

  it('全选框只算可取消的字段：部分勾选为半选', async () => {
    const { orgColumnGroupState } = await columns();
    expect(orgColumnGroupState(['code', 'name', 'fullName'], DEFAULT)).toEqual({ checked: false, indeterminate: true });
    expect(orgColumnGroupState(DEFAULT, DEFAULT)).toEqual({ checked: true, indeterminate: false });
    expect(orgColumnGroupState(['code', 'name'], DEFAULT)).toEqual({ checked: false, indeterminate: false });
  });

  it('搜索按列名匹配', async () => {
    const { matchOrgColumns } = await columns();
    expect(matchOrgColumns(DEFAULT, '日期')).toEqual(['establishedOn', 'startDate', 'stopDate']);
    expect(matchOrgColumns(DEFAULT, '  ')).toEqual(DEFAULT);
  });
});

const row = (sourceCode: string) => ({
  sourceCode,
  code: `ORG-${sourceCode}`,
  name: '合成导入组织',
  parentId: '00000000-0000-4000-8000-000000000002',
});

describe('AC-FE-R1a-41 组织导入前置检查与回执', () => {
  it('模板格式 { rows } 原样提交；缺必填列、空表、超过 100 行、非 JSON 都不发请求', async () => {
    const { parseOrgImport } = await importing();
    const rows = [{ ...row('S-1'), startDate: '2026-10-09' }];
    expect(parseOrgImport(JSON.stringify({ rows }))).toEqual({ rows });
    expect(parseOrgImport('not json')).toEqual({ error: '文件不是有效的 JSON，请按模板填写' });
    expect(parseOrgImport('{"rows":[]}')).toHaveProperty('error');
    expect(parseOrgImport(JSON.stringify({ rows: Array.from({ length: 101 }, (_, i) => row(`S-${i}`)) }))).toEqual({
      error: expect.stringContaining('100'),
    });
    const missing = parseOrgImport(JSON.stringify({ rows: [row('S-1'), { ...row('S-2'), parentId: ' ' }] }));
    expect(missing).toEqual({ error: expect.stringContaining('2') });
    expect((missing as { error: string }).error).toContain('parentId');
  });

  it('回执须与提交行同序、同 sourceCode、状态在 created / updated / conflict 内', async () => {
    const { orgImportReceipt } = await importing();
    const rows = [row('S-1'), row('S-2')];
    const results = [
      { sourceCode: 'S-1', code: 'ORG-S-1', status: 'created', orgId: '00000000-0000-4000-8000-000000000011' },
      { sourceCode: 'S-2', code: 'ORG-S-2', status: 'updated', orgId: '00000000-0000-4000-8000-000000000012' },
    ];
    expect(orgImportReceipt(rows, { results })).toEqual(results);
    expect(orgImportReceipt(rows, { results: [...results].reverse() })).toBeUndefined();
    expect(orgImportReceipt(rows, { results: results.slice(0, 1) })).toBeUndefined();
    expect(orgImportReceipt(rows, { results: [results[0], { ...results[1], status: 'done' }] })).toBeUndefined();
    expect(orgImportReceipt(rows, { items: results })).toBeUndefined();
    expect(orgImportReceipt(rows, {})).toBeUndefined();
  });
});
