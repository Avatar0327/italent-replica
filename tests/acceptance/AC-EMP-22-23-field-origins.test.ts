import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID } from '../../apps/api/src/system-actor.js';
import { approvalWorld, type InstanceView } from './AC-APV-support.js';
import { E, execWorld } from './AC-OA-exec-support.js';
import { rename } from './AC-OA-items-support.js';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const date = '2026-10-08';

interface Origin {
  field: string;
  kind: string;
  value: unknown;
  hasValue: boolean;
  actor: string;
  sourceRecord: string | null;
  sourceBusiness: string | null;
  record: string | null;
  rule: string | null;
  reference: string | null;
  command: string | null;
}

async function history(db: Db, tenantId: string, businessId: string) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ version: number; origins: Origin[] }>(
      await tx.execute(sql`
        SELECT p.version_no AS version, COALESCE(jsonb_agg(jsonb_build_object(
          'field', o.field_code, 'kind', o.origin_kind, 'value', o.value, 'hasValue', o.value IS NOT NULL,
          'actor', o.actor_user_id, 'sourceRecord', o.source_record_id, 'sourceBusiness', o.source_business_id,
          'record', o.record_id, 'rule', o.derivation_rule, 'reference', o.reference_id, 'command', o.command_id
        ) ORDER BY o.seq) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb) AS origins
        FROM employment_payload_versions p LEFT JOIN employment_field_origins o
          ON o.tenant_id = p.tenant_id AND o.payload_version_id = p.id
        WHERE p.tenant_id = ${tenantId} AND p.business_id = ${businessId}
        GROUP BY p.id, p.version_no ORDER BY p.version_no
      `),
    ),
  );
}

const fieldRows = (origins: Origin[], ...codes: string[]) =>
  origins
    .filter((row) => codes.includes(row.field))
    .map(({ field, kind, value, hasValue }) => ({
      field,
      kind,
      value,
      hasValue,
    }));
const recorded = (field: string, kind: string, value: unknown) => ({ field, kind, value, hasValue: true });

describe('AC-EMP-22 建单、修改与审批编辑的字段来源', () => {
  it('建单记录继承策略和派生锚点；备注修改、清空、换值与同键重放逐版核对', async () => {
    const { db } = database();
    const w = await orgPeopleWorld(db, 'f036-form');
    const department = await w.org('初始部门');
    const employee = await w.hire('待调动员工', { departmentId: department.id, place: '初始地' });
    const sequence = await w.job('sequences', '职务序列');
    const post = await w.job('posts', '调入职务', { sequenceId: sequence.id });
    const draft = await w.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: date, fields: { postId: post.id, place: '甲地' } },
      employee.revision,
    );
    const read = () => history(db, w.tenant.id, draft.id);
    const [initial] = await read();
    expect(initial?.origins, '建单后台账有来源行').not.toHaveLength(0);
    expect(
      initial!.origins
        .filter((row) => row.kind === 'hr-input')
        .map((row) => row.field)
        .sort(),
    ).toEqual(['preset:place', 'preset:postId']);
    expect(initial!.origins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'preset:departmentId',
          kind: 'inherit',
          value: department.id,
          sourceRecord: employee.recordId,
        }),
        expect.objectContaining({
          field: 'preset:sequenceId',
          kind: 'derive',
          value: sequence.id,
          rule: 'post-sequence',
          reference: post.id,
        }),
        expect.objectContaining({ field: 'preset:place', kind: 'hr-input', value: '甲地', actor: w.user.id }),
      ]),
    );

    const patch = (revision: number, fields: Record<string, unknown>, commandId = uniqueSuffix()) =>
      w.request('PATCH', `/businesses/${draft.id}`, { ifMatch: revision, idempotencyKey: commandId, body: { fields } });
    const revision = async (response: Response) => {
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { revision: number }).revision;
    };
    const second = await revision(await patch(draft.revision, { remarks: '只改备注' }));
    const third = await revision(await patch(second, { place: null, postId: post.id.toUpperCase() }));
    const key = uniqueSuffix();
    const fourth = await revision(await patch(third, { place: '乙地' }, key));
    expect(await revision(await patch(third, { place: '乙地' }, key))).toBe(fourth);

    const versions = await read();
    expect(versions.map(({ version }) => version)).toEqual([1, 2, 3, 4]);
    expect(
      versions.slice(1).map(({ origins }) =>
        origins.map(({ field, kind, value, hasValue }) => ({
          field,
          kind,
          value,
          hasValue,
        })),
      ),
    ).toEqual([
      [recorded('preset:remarks', 'hr-input', '只改备注')],
      [recorded('preset:place', 'hr-input', null)],
      [recorded('preset:place', 'hr-input', '乙地')],
    ]);
    expect(versions[3]?.origins[0]).toMatchObject({ command: key, actor: w.user.id });
  });

  it.each([
    { mode: 'separate', action: 'edit', value: null },
    { mode: 'with_approve', action: 'approve', value: '审批地点' },
  ] as const)('$action 记录审批人的输入；驳回后 HR 修改另记 HR 来源', async ({ mode, action, value }) => {
    const { db } = database();
    const w = await approvalWorld(db, `f036-${action}`);
    const department = await w.org('审批部门');
    const head = await w.person('部门负责人', department);
    await w.setOrgRoles(department, { head: head.employeeId });
    const employee = await w.person('申请人', department);
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: { type: 'department', value: 'latest_record_department_head' },
          formFields: ['departmentId', 'place', 'effectiveDate'],
          editableFields: ['place'],
          editMode: mode,
        },
      ],
    });
    const draft = await w.application(employee.employeeId, { place: '原地点' }, { effectiveDate: date });
    const instance = await w.submit(draft);
    const edited = await w.json<InstanceView>(
      await w.taskAction(head.userId, w.pending(instance)[0]!.id, action, instance.revision, {
        fields: { place: value },
      }),
    );
    expect((await w.business(draft.id)).fields.place).toBe(value);

    const read = () => history(db, w.tenant.id, draft.id);
    const versions = await read();
    expect(versions.map(({ version }) => version)).toEqual([1, 2]);
    expect(versions[1]?.origins, '审批编辑后台账有一条变更来源').toEqual([
      expect.objectContaining({
        field: 'preset:place',
        kind: 'approval-edit',
        value,
        hasValue: true,
        actor: head.userId,
      }),
    ]);

    if (action === 'edit') {
      await w.json(
        await w.taskAction(head.userId, w.pending(edited)[0]!.id, 'reject', edited.revision, {
          comment: '请补充',
        }),
      );
      const rejected = await w.business(draft.id);
      expect(rejected.status).toBe('rejected');
      await w.json(
        await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/businesses/${draft.id}`, {
          ifMatch: rejected.revision,
          body: { fields: { place: '退回后修改' } },
        }),
      );
      const updated = await read();
      expect(updated.map(({ version }) => version)).toEqual([1, 2, 3]);
      expect(updated[2]?.origins).toEqual([
        expect.objectContaining({ field: 'preset:place', kind: 'hr-input', value: '退回后修改', actor: w.hr.id }),
      ]);
    }
  });
});

describe('AC-EMP-23 组织调整的复制、系统改写与派生', () => {
  it.each(['改名', '改上级', '改名并调整负责人'])('%s的组织联动逐字段复制真实前驱', async (operation) => {
    const { db } = database();
    const w = await orgPeopleWorld(db, 'f036-org');
    const department = await w.org('初始部门');
    const parent = await w.org('目标上级');
    const employee = await w.hire('组织内员工', { departmentId: department.id, place: '原地点' });
    const head = operation === '改名并调整负责人' ? await w.hire('新负责人', { departmentId: parent.id }) : null;
    const patch =
      operation === '改上级'
        ? { parents: { admin: { parentId: parent.id } } }
        : { name: '新部门名', ...(head && { personInChargeId: head.id }) };
    const response = await w.patchOrg(department, { ...patch, effectiveDate: date, addEmployment: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const records = await w.records(employee.id, date);
    expect(records).toHaveLength(2);
    const added = records.find((record) => record.kind === 'org_adjustment')!;
    const versions = await history(db, w.tenant.id, added.id);
    expect(versions.map(({ version }) => version)).toEqual([1]);
    const rows = versions[0]!.origins;
    expect(rows, '组织联动后台账有复制来源').not.toHaveLength(0);
    expect(fieldRows(rows, 'preset:departmentId', 'preset:place')).toEqual(
      expect.arrayContaining([
        recorded('preset:departmentId', 'copy', department.id),
        recorded('preset:place', 'copy', '原地点'),
      ]),
    );
    expect(
      rows.every(
        (row) =>
          row.kind === 'copy' &&
          row.sourceRecord === employee.recordId &&
          row.sourceBusiness === employee.recordId &&
          row.record === added.id &&
          row.actor === w.user.id,
      ),
    ).toBe(true);
  });

  it('组织调整申请单真实审批并执行后，复制行关联前驱和执行生成的记录', async () => {
    const { db } = database();
    const w = await execWorld(db, 'f036-org-exec');
    const department = await w.org('调整部门', w.a);
    const employee = await w.staff(department);
    const adjustment = await w.approved([w.a], [rename(department, { name: '执行后名称', addEmployment: true })]);
    expect((await w.run()).completed).toEqual([adjustment.id]);

    const records = await w.json<{ items: { id: string; kind: string }[] }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employee}/records?asOf=${E}`),
    );
    expect(records.items).toHaveLength(2);
    const previous = records.items.find(({ kind }) => kind === 'hire')!;
    const added = records.items.find(({ kind }) => kind === 'org_adjustment')!;
    const versions = await history(db, w.tenant.id, added.id);
    expect(versions.map(({ version }) => version)).toEqual([1]);
    expect(versions[0]?.origins).toContainEqual(
      expect.objectContaining({
        field: 'preset:departmentId',
        kind: 'copy',
        value: department,
        sourceRecord: previous.id,
        sourceBusiness: previous.id,
        record: added.id,
        actor: SYSTEM_USER_ID,
      }),
    );
  });

  it('F-006 职位改汇报上级带出的经理记录实际职位引用和结果', async () => {
    const { db } = database();
    const w = await orgPeopleWorld(db, 'f036-job-manager');
    const department = await w.org('职位所在部门');
    const post = await w.job('posts', '职务');
    const position = (name: string) => w.job('positions', name, { orgId: department.id, postId: post.id });
    const parent = await position('新上级职位');
    const target = await position('调整职位');
    const manager = await w.hire('新经理', { departmentId: department.id, positionId: parent.id });
    const employee = await w.hire('调整员工', { departmentId: department.id, positionId: target.id });
    const response = await w.call('PATCH', `job/positions/${target.id}`, {
      ifMatch: target.revision,
      body: { parents: { admin: { parentId: parent.id } }, effectiveDate: date, adjustEmployeeDirectManager: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const records = await w.records(employee.id, date);
    const added = records.find(({ kind }) => kind === 'org_adjustment')!;
    expect(added.fields.directManagerId).toBe(manager.id);
    const versions = await history(db, w.tenant.id, added.id);
    expect(versions.map(({ version }) => version)).toEqual([1]);
    expect(
      versions[0]?.origins.filter(({ field, kind }) => field === 'preset:directManagerId' && kind !== 'inherit'),
    ).toEqual([
      expect.objectContaining({
        kind: 'derive',
        value: manager.id,
        rule: 'position-manager',
        reference: target.id,
      }),
    ]);
  });
});
