/**
 * AC-APV-F326-27 审计可见字段（F-326 S1 第 1 轮返工 P2-1，设计 §4.5）：
 * 变量与矩阵的审计键（dataType / defaultValue / usageScopes / appId，动态的 row:<id> / column:<id>，删除快照里的
 * cells / columns）不在「审批流程」字段目录里，若直接套用该目录，即使查看人有全部字段权限，详情也会被裁成空。
 * 本文件走真实的审计详情接口链路（routes.ts 详情 → fieldsOf → 差异 / 前后值 / 删除快照裁剪），不只核对“已登记”：
 * ① 有审批流程「节点」字段权限：变量整值、矩阵整行差异与前后值、行删除快照都完整返回；
 * ② 只有基础字段（编码 / 名称 / 状态）：看得到编码名称，看不到内容；
 * ③ 没有任何字段权限：仍能看到这条配置日志（DEC-203），但差异与前后值为空（fail-closed）；
 * ④ 撤权后重新读取，内容立即消失。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi, type DataChangeDetail } from './AC-AUD-support.js';
import {
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const OBJECT = 'TenantBase.ApprovalProcess';
const FULL = ['code', 'name', 'description', 'status', 'revision', 'nodes'];
const BASIC = ['code', 'name', 'status'];

const USER_A = randomUUID();
const USER_B = randomUUID();
const COLUMN_DEPT = randomUUID();
const COLUMN_APPROVER = randomUUID();
const ROW_ONE = randomUUID();
const ROW_TWO = randomUUID();

async function viewer(world: PermissionWorld, label: string, fields: readonly string[]) {
  const member = await memberWithAdminRole(world, 'audit_admin', `${label}-${uniqueSuffix()}`);
  const profile = await createProfile(world, `apv-aud-${uniqueSuffix()}`);
  await narrow(world, profile, fields);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, member.user.id, profile.id)).status).toBe(201);
  return { member, profile };
}

async function narrow(world: PermissionWorld, profile: ProfileBody, fields: readonly string[]) {
  const response = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: fields.map((fieldCode) => ({ fieldCode, view: true, edit: false })),
      buttons: [],
    },
    OBJECT,
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('F-326 S1 审计可见字段（真实详情接口）', () => {
  let world: PermissionWorld;
  let audit: ReturnType<typeof auditApi>;
  const events: Record<string, string> = {};

  async function write(
    key: string,
    objectType: string,
    action: string,
    objectId: string,
    before: unknown,
    after: unknown,
  ) {
    await withTenant(database().db, world.tenant.id, (tx) =>
      insertAuditEvent(tx, {
        tenantId: world.tenant.id,
        actorUserId: world.admin.id,
        action,
        objectType,
        objectId,
        before,
        after,
        occurredAt: new Date(NOW),
      }),
    );
    const { items } = await audit.dataChanges(world.asAdmin, { objectId, action });
    events[key] = items.find((item) => item.action === action)!.id;
  }

  const publicVariable = {
    code: 'Global.B.Approver1',
    name: '合成公共变量',
    dataType: 'persons',
    defaultValue: [USER_A, USER_B],
    usageScopes: ['process', 'business_rule'],
    description: '合成描述',
    status: 'enabled',
    appId: null,
  };
  const applicationVariable = {
    code: 'B.Mgr',
    name: '合成应用变量',
    dataType: 'person',
    defaultValue: USER_A,
    usageScopes: [],
    status: 'enabled',
    appId: 'transfer',
  };
  const autoVariable = {
    ...publicVariable,
    code: 'Global.B.Auto1',
    dataType: 'person',
    defaultValue: USER_A,
    usageScopes: ['process'],
    origin: 'auto',
    originProcessId: randomUUID(),
    originVersionId: randomUUID(),
    originNodeKey: 'n1',
    originSlot: 'approver',
  };
  const rowCells = { [COLUMN_DEPT]: [randomUUID()], [COLUMN_APPROVER]: [USER_A] };
  const matrixId = randomUUID();

  beforeAll(async () => {
    world = await seedPermissionWorld(database().db);
    audit = auditApi(database().db, NOW, { authorize: undefined });
    const variableId = randomUUID();
    await write(
      'var.create',
      'approval-public-variable',
      'approval.public_variable.create',
      variableId,
      null,
      publicVariable,
    );
    await write(
      'var.update',
      'approval-public-variable',
      'approval.public_variable.update',
      variableId,
      publicVariable,
      {
        ...publicVariable,
        defaultValue: [USER_B],
      },
    );
    await write(
      'app.create',
      'approval-application-variable',
      'approval.application_variable.create',
      randomUUID(),
      null,
      applicationVariable,
    );
    await write(
      'auto.create',
      'approval-public-variable',
      'approval.public_variable.create',
      randomUUID(),
      null,
      autoVariable,
    );
    await write('matrix.create', 'approval-matrix', 'approval.matrix.create', matrixId, null, {
      code: 'M1',
      name: '合成矩阵',
      description: '矩阵描述',
      status: 'draft',
    });
    await write('matrix.structure.add', 'approval-matrix', 'approval.matrix.structure', matrixId, null, {
      [`column:${COLUMN_DEPT}`]: {
        kind: 'condition',
        dimension: 'department',
        includeChildren: true,
        name: '部门',
        seq: 1,
        allowMultiple: false,
      },
      [`column:${COLUMN_APPROVER}`]: {
        kind: 'role',
        dimension: null,
        includeChildren: false,
        name: '审批人',
        seq: 2,
        allowMultiple: true,
      },
      [`row:${ROW_ONE}`]: { seq: 1, cells: rowCells },
    });
    await write(
      'matrix.structure.edit',
      'approval-matrix',
      'approval.matrix.structure',
      randomUUID(),
      { [`row:${ROW_ONE}`]: { seq: 1, cells: rowCells }, [`row:${ROW_TWO}`]: { seq: 2, cells: rowCells } },
      {
        [`row:${ROW_ONE}`]: { seq: 1, cells: { ...rowCells, [COLUMN_APPROVER]: [USER_B] } },
        [`row:${ROW_TWO}`]: { seq: 3, cells: rowCells },
      },
    );
    await write(
      'row.delete',
      'approval-matrix-row',
      'approval.matrix.row.delete',
      ROW_TWO,
      {
        matrixId,
        matrixCode: 'M1',
        seq: 2,
        cells: rowCells,
        columns: {
          [COLUMN_DEPT]: { name: '部门', kind: 'condition' },
          [COLUMN_APPROVER]: { name: '审批人', kind: 'role' },
        },
      },
      null,
    );
  });

  const detail = (as: { user: string; tenant: string }, key: string): Promise<DataChangeDetail> =>
    audit.dataChange(as, events[key]!);
  const fieldsOf = (d: DataChangeDetail) => d.changes.map((change) => change.field);

  it('① 有节点字段权限：公共变量的整值（含数据类型、默认值、适用范围）原样返回', async () => {
    const { member } = await viewer(world, 'apv-aud-full-var', FULL);
    const created = await detail(member.as, 'var.create');
    expect(created.after).toEqual(publicVariable);
    expect(fieldsOf(created)).toEqual(
      expect.arrayContaining(['code', 'name', 'dataType', 'defaultValue', 'usageScopes', 'description', 'status']),
    );
    const changed = await detail(member.as, 'var.update');
    expect(changed.changes).toEqual([
      expect.objectContaining({ field: 'defaultValue', from: [USER_A, USER_B], to: [USER_B] }),
    ]);
    expect(changed.before).toEqual(publicVariable);
    const listed = await audit.dataChanges(member.as, {
      objectType: 'approval-public-variable',
      field: 'defaultValue',
    });
    expect(listed.items.map((item) => item.id)).toContain(events['var.update']);
  });

  it('① 自动变量的来源标记与来源流程 / 版本 / 节点 / 位置随内容权限一起返回，基础字段看不到', async () => {
    const { member } = await viewer(world, 'apv-aud-auto', FULL);
    const created = await detail(member.as, 'auto.create');
    expect(created.after).toEqual(autoVariable);
    expect(fieldsOf(created)).toEqual(
      expect.arrayContaining(['origin', 'originProcessId', 'originVersionId', 'originNodeKey', 'originSlot']),
    );
    const basic = await viewer(world, 'apv-aud-auto-basic', BASIC);
    const hidden = await detail(basic.member.as, 'auto.create');
    expect(fieldsOf(hidden).sort()).toEqual(['code', 'name', 'status']);
    expect(JSON.stringify(hidden)).not.toContain(autoVariable.originNodeKey + '"');
  });

  it('① 应用变量的应用与默认值同样完整', async () => {
    const { member } = await viewer(world, 'apv-aud-full-app', FULL);
    const created = await detail(member.as, 'app.create');
    expect(created.after).toEqual(applicationVariable);
    expect(fieldsOf(created)).toEqual(expect.arrayContaining(['appId', 'dataType', 'defaultValue']));
  });

  it('① 矩阵：新增的列 / 行整体可见；改一个格记整行前后（含全部单元格）', async () => {
    const { member } = await viewer(world, 'apv-aud-full-matrix', FULL);
    const added = await detail(member.as, 'matrix.structure.add');
    expect(fieldsOf(added)).toEqual(
      expect.arrayContaining([
        `column:${COLUMN_DEPT}.name`,
        `column:${COLUMN_DEPT}.dimension`,
        `column:${COLUMN_APPROVER}.allowMultiple`,
        `row:${ROW_ONE}.seq`,
        `row:${ROW_ONE}.cells`,
      ]),
    );
    expect((added.after as Record<string, unknown>)[`row:${ROW_ONE}`]).toEqual({ seq: 1, cells: rowCells });
    expect((added.after as Record<string, unknown>)[`column:${COLUMN_DEPT}`]).toMatchObject({ name: '部门' });

    const edited = await detail(member.as, 'matrix.structure.edit');
    const cells = edited.changes.find((change) => change.field === `row:${ROW_ONE}.cells`);
    expect(cells, JSON.stringify(edited.changes)).toMatchObject({
      from: rowCells,
      to: { ...rowCells, [COLUMN_APPROVER]: [USER_B] },
    });
    expect(edited.changes.find((change) => change.field === `row:${ROW_TWO}.seq`)).toMatchObject({ from: 2, to: 3 });
    expect(edited.before).toEqual({
      [`row:${ROW_ONE}`]: { seq: 1, cells: rowCells },
      [`row:${ROW_TWO}`]: { seq: 2, cells: rowCells },
    });
  });

  it('① 矩阵头（编码、名称、描述、状态）随基础字段可见', async () => {
    const { member } = await viewer(world, 'apv-aud-full-head', FULL);
    const created = await detail(member.as, 'matrix.create');
    expect(created.after).toEqual({ code: 'M1', name: '合成矩阵', description: '矩阵描述', status: 'draft' });
  });

  it('① 行删除：判为删除操作，快照含行序、全部单元格与当时列名', async () => {
    const { member } = await viewer(world, 'apv-aud-full-delete', FULL);
    const removed = await detail(member.as, 'row.delete');
    expect(removed.operation).toBe('delete');
    expect(removed.snapshot).toEqual({
      matrixId,
      matrixCode: 'M1',
      seq: 2,
      cells: rowCells,
      columns: {
        [COLUMN_DEPT]: { name: '部门', kind: 'condition' },
        [COLUMN_APPROVER]: { name: '审批人', kind: 'role' },
      },
    });
  });

  it('② 只有基础字段：看得到编码、名称、状态；数据类型、默认值、矩阵行列与删除快照内容都看不到', async () => {
    const { member } = await viewer(world, 'apv-aud-basic', BASIC);
    const variable = await detail(member.as, 'var.create');
    expect(variable.after).toEqual({ code: 'Global.B.Approver1', name: '合成公共变量', status: 'enabled' });
    expect(fieldsOf(variable).sort()).toEqual(['code', 'name', 'status']);
    const structure = await detail(member.as, 'matrix.structure.add');
    expect(structure.changes).toEqual([]);
    expect(structure.after).toEqual({});
    const removed = await detail(member.as, 'row.delete');
    expect(removed.operation).toBe('delete');
    expect(removed.snapshot).toEqual({ matrixCode: 'M1' });
    const everything = JSON.stringify([variable, structure, removed]);
    expect(everything).not.toContain(USER_A);
    expect(everything).not.toContain(COLUMN_DEPT);
  });

  it('③ 没有审批流程任何字段权限：仍见到配置日志，但差异、前后值、快照全空', async () => {
    const bare = await memberWithAdminRole(world, 'audit_admin', `apv-aud-bare-${uniqueSuffix()}`);
    for (const key of ['var.create', 'app.create', 'matrix.structure.add', 'matrix.structure.edit', 'row.delete']) {
      const view = await detail(bare.as, key);
      expect(view.changes, key).toEqual([]);
      expect(view.after ?? {}, key).toEqual({});
      expect(view.before ?? {}, key).toEqual({});
      expect(view.snapshot ?? {}, key).toEqual({});
      const text = JSON.stringify(view);
      for (const secret of [USER_A, USER_B, COLUMN_DEPT, ROW_ONE]) expect(text, key).not.toContain(secret);
    }
  });

  it('④ 撤权：节点字段权限被收回后，同一条详情立即只剩基础字段', async () => {
    const { member, profile } = await viewer(world, 'apv-aud-revoke', FULL);
    const before = await detail(member.as, 'var.create');
    expect(before.after).toEqual(publicVariable);
    const rowBefore = await detail(member.as, 'row.delete');
    expect(rowBefore.snapshot).toMatchObject({ seq: 2 });
    await narrow(world, profile, BASIC);
    const after = await detail(member.as, 'var.create');
    expect(after.after).toEqual({ code: 'Global.B.Approver1', name: '合成公共变量', status: 'enabled' });
    const afterRow = await detail(member.as, 'row.delete');
    expect(afterRow.snapshot).toEqual({ matrixCode: 'M1' });
    expect(JSON.stringify(await detail(member.as, 'matrix.structure.edit'))).not.toContain(ROW_ONE);
  });

  it('⑤ 动态键只认标准 UUID：伪造的 row:<非 UUID> 键即使有节点权限也不放行', async () => {
    const forged = randomUUID();
    await write('forged', 'approval-matrix', 'approval.matrix.structure', forged, null, {
      'row:not-a-uuid': { seq: 1, cells: {} },
      'column:../../x': { kind: 'role' },
      'secret:abc': 'x',
    });
    const { member } = await viewer(world, 'apv-aud-forged', FULL);
    const view = await detail(member.as, 'forged');
    expect(view.changes).toEqual([]);
    expect(view.after).toEqual({});
  });
});
