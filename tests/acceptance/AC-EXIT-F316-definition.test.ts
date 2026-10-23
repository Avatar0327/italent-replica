/** F-316 / DEC-678：既有流程定义接口的校验、版本冻结、幂等和租户边界。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { api, definition, inputOf, KEYS, POLICIES, policyOf, reach, view, world } from './AC-EXIT-F316-support.js';

const database = useTestDb();
const code = () => `F316_${randomUUID().replaceAll('-', '')}`;

describe('AC-EXIT-F316 流程定义 HTTP 配置', () => {
  for (const key of KEYS) {
    it.each(POLICIES[key])(`DEC-678 ${key} / %s 保存、读取、发布、新版本均保留`, async (policy) => {
      const x = await world(database().db, `config-${key}-${policy}`);
      const body = {
        ...definition(x, { [key]: { emptyApproverPolicy: policy, fallbackUserIds: [x.workOwner.userId] } }),
        code: code(),
        approvalType: 'exit_handover',
      };
      const created = await view(await api(x, 'POST', '', 0, body), 201);
      const loaded = await view(await api(x, 'GET', `/${created.id}`));
      expect(policyOf(loaded.latestVersion.nodes.find((node) => node.key === key)!)).toBe(policy);
      const published = await view(await api(x, 'POST', `/${created.id}/publish`, loaded.revision, {}));
      expect(policyOf(published.currentVersion!.nodes.find((node) => node.key === key)!)).toBe(policy);
      const draft = await view(await api(x, 'POST', `/${created.id}/versions`, published.revision, {}), 201);
      expect(policyOf(draft.latestVersion.nodes.find((node) => node.key === key)!)).toBe(policy);
      // DEC-402：整份保存省略策略就恢复 DEC-663 默认语义，不继承上一稿的显式配置。
      const input = inputOf(draft.latestVersion);
      const nodes = input.nodes.map((node) => {
        const copy: Record<string, unknown> = { ...node };
        delete copy.emptyApproverPolicy;
        return copy;
      });
      const saved = await view(await api(x, 'PUT', `/${created.id}/draft`, draft.revision, { ...input, nodes }));
      expect(policyOf(saved.latestVersion.nodes.find((node) => node.key === key)!)).toBeUndefined();
      expect((await api(x, 'PUT', `/${created.id}/draft`, draft.revision, input)).status).toBe(409);
    });
  }

  it('DEC-678 非法枚举、节点错用、新字段结构错误均 422，创建/更新不留下变化', async () => {
    const x = await world(database().db, 'invalid');
    const body = { ...definition(x), code: code(), approvalType: 'exit_handover' };
    const created = await view(await api(x, 'POST', '', 0, body), 201);
    const invalids = [
      { key: 'work_handover', value: 'exception_admin' },
      { key: 'other_handover', value: 'stop' },
      { key: 'work_handover', value: 'unknown' },
      { key: 'work_handover', value: null },
      { key: 'work_handover', value: 1 },
      { key: 'work_handover', value: { type: 'stop' } },
      { key: 'employee_confirm', value: 'auto_approve' },
    ];
    for (const invalid of invalids) {
      const input = definition(x);
      const nodes = input.nodes.map((node) =>
        node.key === invalid.key
          ? {
              ...node,
              emptyApproverPolicy: invalid.value,
            }
          : node,
      );
      for (const [method, path, revision, payload] of [
        ['POST', '', 0, { ...input, code: code(), approvalType: 'exit_handover', nodes }],
        ['PUT', `/${created.id}/draft`, created.revision, { ...input, nodes }],
      ] as const) {
        const response = await api(x, method, path, revision, payload);
        expect(
          response.status,
          `${invalid.key} ${JSON.stringify(invalid.value)}: ${await response.clone().text()}`,
        ).toBe(422);
        expect(await response.json()).toMatchObject({
          error: { details: { reason: 'APPROVAL_EMPTY_APPROVER_POLICY_INVALID' } },
        });
      }
    }
    expect(await view(await api(x, 'GET', `/${created.id}`))).toEqual(created);
    const processes = await x.sqlRows(sql`SELECT id FROM approval_processes WHERE tenant_id=${x.tenantId}
      AND code LIKE 'F316_%'`);
    expect(processes).toHaveLength(1);
  });

  it('DEC-678 不开放给普通审批类型、单人节点；自动同意必须有同意出口', async () => {
    const x = await world(database().db, 'unsupported');
    const input = definition(x, { work_handover: { emptyApproverPolicy: 'auto_approve' } });
    const first = input.nodes[0]!;
    const payloads = [
      { ...input, approvalType: 'transfer', nodes: [{ ...first, approvers: ['owner'] }] },
      {
        ...input,
        approvalType: 'exit_handover',
        nodes: [{ ...first, kind: 'single', approver: 'owner', approvers: undefined, transitionRule: undefined }],
      },
      { ...input, approvalType: 'exit_handover', nodes: [{ ...first, exits: ['disagree'] }] },
    ];
    for (const payload of payloads) {
      const response = await api(x, 'POST', '', 0, { ...payload, code: code() });
      expect(response.status, await response.clone().text()).toBe(422);
    }
  });

  it('DEC-678 在途实例冻结旧策略，新发布只影响后来发起；跨租户不能读写配置', async () => {
    const x = await world(database().db, 'frozen', false);
    const input = definition(x, { other_handover: { emptyApproverPolicy: 'auto_approve' } });
    const created = await view(
      await api(x, 'POST', '', 0, { ...input, code: 'AAA_F316', approvalType: 'exit_handover' }),
      201,
    );
    const published = await view(await api(x, 'POST', `/${created.id}/publish`, created.revision, {}));
    const run = await reach(x, 'work_handover', true);
    const draft = await view(await api(x, 'POST', `/${created.id}/versions`, published.revision, {}), 201);
    const changed = await view(
      await api(
        x,
        'PUT',
        `/${created.id}/draft`,
        draft.revision,
        definition(x, { other_handover: { emptyApproverPolicy: 'exception_admin' } }),
      ),
    );
    await view(await api(x, 'POST', `/${created.id}/publish`, changed.revision, {}));
    const approved = await x.decide(run.instanceId);
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await x.pendingNode(run.instanceId))?.nodeKey).toBe('employee_confirm');
    const employee = await x.person('合成后续离职人员');
    const later = await x.launched(employee.employeeId);
    const next = await x.decide(later.instanceId);
    expect(next.status, await next.clone().text()).toBe(200);
    expect(await x.pendingTasks(later.instanceId)).toEqual([
      expect.objectContaining({ nodeKey: 'other_handover', userId: x.exceptionAdmin.id, isExceptionAdmin: true }),
    ]);
    const stranger = await world(database().db, 'other-tenant');
    expect((await api(stranger, 'GET', `/${created.id}`)).status).toBe(404);
    expect((await api(stranger, 'PUT', `/${created.id}/draft`, changed.revision, input)).status).toBe(404);
  });
});
