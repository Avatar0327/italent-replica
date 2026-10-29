/** DEC-686：统一来源的 HTTP 保存契约，合成数据，普通角色 withTenant 夹具。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { uniqueSuffix } from './support/unique.js';
import { describe, expect, it } from 'vitest';
import { api, definition, view, world } from './AC-EXIT-F316-support.js';

const database = useTestDb();
const source = (type: string, value: string) => ({ type, value });

describe('AC-APV-F318a 来源统一模型', () => {
  it('指定人员与空审批人指定人员独立保存，版本复制保留结构', async () => {
    const x = await world(database().db, 'source-model');
    const input = definition(x);
    const nodes = [
      {
        ...input.nodes[0],
        approvers: [source('specified', x.workOwner.userId)],
        emptyApproverPolicy: 'specified',
        emptyApproverSources: [source('specified', x.hrbp.userId)],
        fallbackUserIds: [],
      },
    ];
    const created = await view(
      await api(x, 'POST', '', 0, {
        ...input,
        nodes,
        code: `F318a_${uniqueSuffix()}`,
        approvalType: 'exit_handover',
      }),
      201,
    );
    const expected = {
      approvers: nodes[0]!.approvers,
      emptyApproverPolicy: 'specified',
      emptyApproverSources: nodes[0]!.emptyApproverSources,
    };
    expect(created.latestVersion.nodes).toMatchObject([expected]);
    expect(created.latestVersion.nodes[0]!.fallbackUserIds ?? []).toEqual([]);
    const published = await view(await api(x, 'POST', `/${created.id}/publish`, created.revision, {}));
    const draft = await view(await api(x, 'POST', `/${created.id}/versions`, published.revision, {}), 201);
    expect(draft.latestVersion.nodes).toMatchObject([expected]);
  });

  it('F-326 与 F-318c 未开放值给出明确的 422 原因', async () => {
    const x = await world(database().db, 'unsupported-sources');
    const input = definition(x);
    for (const type of [
      'public_variable',
      'application_variable',
      'matrix',
      'department',
      'business_org',
      'profit_center',
      'reserve4',
      'reserve5',
      'position',
      'job',
      'identity',
    ]) {
      const response = await api(x, 'POST', '', 0, {
        ...input,
        code: `F318a_${uniqueSuffix()}`,
        approvalType: 'exit_handover',
        nodes: [{ ...input.nodes[0], approvers: [source(type, randomUUID())] }],
      });
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.message).toContain(
        ['public_variable', 'application_variable', 'matrix'].includes(type) ? '暂不支持，后补' : '待 F-318c 开放',
      );
    }
  });

  it('拒绝跨租户指定人员；旧字符串不能再作为来源模型保存', async () => {
    const x = await world(database().db, 'source-isolation');
    const other = await world(database().db, 'source-other');
    const input = definition(x);
    for (const approvers of [[source('specified', other.workOwner.userId)], ['handover_work_owner']]) {
      const response = await api(x, 'POST', '', 0, {
        ...input,
        code: `F318a_${uniqueSuffix()}`,
        approvalType: 'exit_handover',
        nodes: [{ ...input.nodes[0], approvers }],
      });
      expect(response.status).toBe(422);
    }
  });
});
