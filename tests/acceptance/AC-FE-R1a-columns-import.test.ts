// F-132 第 2 段（组织页）：列设置（原站 B2_03 居中两栏弹窗）与组织导入的纯函数规则。
// 导入回执按接口真实形状核对：200 { results: [{ sourceCode, code, status, orgId?, reason? }] }，与提交行同序。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const columns = () => import(resolve('apps/web/src/org/columns.ts'));
const importing = () => import(resolve('apps/web/src/org/import-model.ts'));
const pageModel = () => import(resolve('apps/web/src/org/page-model.ts'));
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

// 权限按接口 GET /permission/me/objects/:code 的真实形状（dataOperations / editableFields / buttons）。
const IMPORT_FIELDS = ['sourceCode', 'code', 'name', 'parentId', 'parents', 'startDate'];
const permission = (operations: { create?: boolean; update?: boolean }, editable = IMPORT_FIELDS) => ({
  objectCode: 'TenantBase.Organization',
  dataOperations: { create: false, update: false, ...operations },
  viewableFields: IMPORT_FIELDS,
  editableFields: editable,
  buttons: [{ buttonCode: 'import', level: 'list' }],
});
const ORG = '00000000-0000-4000-8000-000000000011';
const update = (sourceCode: string) => ({ ...row(sourceCode), orgId: ORG, expectedRevision: 1 });

describe('AC-FE-R1a-41 组织导入前置检查与回执', () => {
  it('模板格式 { rows } 原样提交；缺必填列、空表、超过 100 行、非 JSON 都不发请求', async () => {
    const { parseOrgImport } = await importing();
    const { pageAccess } = await pageModel();
    const gate = pageAccess(permission({ create: true, update: true }));
    const parse = (text: string) => parseOrgImport(text, gate);
    const rows = [{ ...row('S-1'), startDate: '2026-10-09' }];
    expect(parse(JSON.stringify({ rows }))).toEqual({ rows });
    expect(parse('not json')).toEqual({ error: '文件不是有效的 JSON，请按模板填写' });
    expect(parse('{"rows":[]}')).toHaveProperty('error');
    expect(parse(JSON.stringify({ rows: Array.from({ length: 101 }, (_, i) => row(`S-${i}`)) }))).toEqual({
      error: expect.stringContaining('100'),
    });
    const missing = parse(JSON.stringify({ rows: [row('S-1'), { ...row('S-2'), parentId: ' ' }] }));
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

  it('逐行按接口口径校验写权：有 orgId 或 expectedRevision 为更新、否则为新建，控制项以外的列都须可写（反向）', async () => {
    const { parseOrgImport } = await importing();
    const { pageAccess } = await pageModel();
    const text = (rows: unknown[]) => JSON.stringify({ rows });
    const createOnly = pageAccess(permission({ create: true }));
    expect(parseOrgImport(text([row('S-1')]), createOnly)).toEqual({ rows: [row('S-1')] });
    expect(parseOrgImport(text([row('S-1'), update('S-2')]), createOnly)).toEqual({
      error: '第 2 行需要更新组织的权限，当前无权更新',
    });
    const updateOnly = pageAccess(permission({ update: true }));
    expect(parseOrgImport(text([update('S-1'), { ...update('S-2'), addEmployment: true }]), updateOnly)).toHaveProperty(
      'rows',
    );
    expect(parseOrgImport(text([update('S-1'), row('S-2')]), updateOnly)).toEqual({
      error: '第 2 行需要新建组织的权限，当前无权新建',
    });
    const noSource = pageAccess(
      permission(
        { create: true },
        IMPORT_FIELDS.filter((field) => field !== 'sourceCode'),
      ),
    );
    expect(parseOrgImport(text([row('S-1')]), noSource)).toEqual({ error: expect.stringContaining('sourceCode') });
    const noStart = pageAccess(
      permission(
        { create: true },
        IMPORT_FIELDS.filter((field) => field !== 'startDate'),
      ),
    );
    expect(parseOrgImport(text([row('S-1')]), noStart)).toHaveProperty('rows');
    expect(parseOrgImport(text([{ ...row('S-1'), startDate: '2026-10-09' }]), noStart)).toEqual({
      error: expect.stringContaining('startDate'),
    });
    // 第 2 轮 P2-3：只写 sourceCode 映射与 expectedRevision、没有 orgId 的行是接口认可的更新行（AC-ORG-12 / DEC-060），
    // 按更新权预检后放行；只有新建权时按“更新”拦下。
    const { orgId: _, ...mappedOnly } = update('S-1');
    expect(parseOrgImport(text([mappedOnly]), updateOnly)).toEqual({ rows: [mappedOnly] });
    expect(parseOrgImport(text([mappedOnly]), createOnly)).toEqual({ error: expect.stringContaining('更新') });
  });

  it('导入入口：有 import@list 但新建、更新数据权都没有，或必填列（含 sourceCode、parentId）不可写时不出入口', async () => {
    const { orgImportable, pageAccess } = await pageModel();
    expect(orgImportable(pageAccess(permission({ create: true })))).toBe(true);
    expect(orgImportable(pageAccess(permission({ update: true })))).toBe(true);
    expect(orgImportable(pageAccess(permission({})))).toBe(false);
    for (const field of ['sourceCode', 'parentId'])
      expect(
        orgImportable(
          pageAccess(
            permission(
              { create: true },
              IMPORT_FIELDS.filter((name) => name !== field),
            ),
          ),
        ),
      ).toBe(false);
    expect(orgImportable(pageAccess({ ...permission({ create: true }), buttons: [] }))).toBe(false);
  });

  it('冲突重读：最新快照只放接口返回的业务字段与版本，文件内容不被改写；读回不是同一组织或版本无效时读取失败', async () => {
    const { rereadImportRows } = await importing();
    const rows = [row('S-1'), update('S-2')];
    // GET /api/tenant/org/organizations/:id 的真实形状（read-model.ts OrgRecord）：行政上级在 parents.admin。
    const record = (id: string) => ({
      id,
      revision: 3,
      code: 'ORG-001',
      name: '他人改过的名称',
      parents: { admin: { parentId: '00000000-0000-4000-8000-000000000009', sequence: 1 } },
    });
    const latest = await rereadImportRows(rows, async (id: string) => record(id));
    expect(latest).toEqual([
      { sourceCode: 'S-1' },
      {
        sourceCode: 'S-2',
        orgId: ORG,
        code: 'ORG-001',
        name: '他人改过的名称',
        parentId: '00000000-0000-4000-8000-000000000009',
        expectedRevision: 3,
      },
    ]);
    await expect(rereadImportRows(rows, async () => ({ id: 'other', revision: 3 }))).rejects.toThrow();
    await expect(rereadImportRows(rows, async (id: string) => ({ id, revision: '3' }))).rejects.toThrow();
  });

  it('重提：版本控制项取权威重读值，其余列保持文件内容；原系统编码或 orgId 对不上的行不套用', async () => {
    const { withLatestRevisions } = await importing();
    const mine = [row('S-1'), update('S-2'), update('S-3')];
    const latest = [
      { sourceCode: 'S-1' },
      { sourceCode: 'S-2', orgId: ORG, name: '他人改过的名称', expectedRevision: 7 },
      { sourceCode: 'S-3', orgId: '00000000-0000-4000-8000-000000000099', expectedRevision: 9 },
    ];
    expect(withLatestRevisions(mine, latest)).toEqual([
      row('S-1'),
      { ...update('S-2'), expectedRevision: 7 },
      update('S-3'),
    ]);
    expect(withLatestRevisions(mine, undefined)).toEqual(mine);
  });
});
