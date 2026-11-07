/**
 * AC-APV-F478-02 分支违规的 HTTP 映射（设计 §2.4、§8）：保存草稿 / 发布时 validateRoutes 的每种违规都返回
 * 400 VALIDATION_FAILED，details.code=APPROVAL_ROUTE_INVALID，details.reason 精确，并带出节点 / 出口 / 分支序号。
 * 不可达节点只在发布时拦（草稿编辑中途允许暂时孤立）；业务出口在注册表为空时一律 business_exit_type。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  APV,
  approveTo,
  direct,
  otherwise,
  routeScene,
  when,
  type BranchInput,
  type RouteScene,
  type RoutesInput,
} from './AC-APV-F478-support.js';
import type { ProcessView } from './AC-APV-support.js';
import { cloneForPut, errorInfo, getProcess, putDraft, withRoutesOn } from './AC-APV-F478-s2-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

async function saveRoutes(s: RouteScene, routes: RoutesInput, process?: ProcessView) {
  const created = process ?? (await s.w.createProcess({ nodes: s.nodes() }));
  const body = cloneForPut(created.latestVersion, { nodes: withRoutesOn(created.latestVersion.nodes, routes) });
  return { created, response: await putDraft(s.w, created, body) };
}

describe('AC-APV-F478-02 保存草稿的违规原因', () => {
  const cases = (s: RouteScene): [string, RoutesInput, { nodeKey: string; exit?: string; branchNo?: number }][] => {
    const d1 = s.depts.d1;
    return [
      ['backward_target', { n3: [approveTo(direct('n2'))] }, { nodeKey: 'n3', exit: 'approve', branchNo: 1 }],
      ['self_target', { n2: [approveTo(direct('n2'))] }, { nodeKey: 'n2', exit: 'approve', branchNo: 1 }],
      [
        'duplicate_priority',
        { n1: [approveTo(when(1, 'eq', d1, 'n3'), when(1, 'ne', d1, 'n4'), otherwise('n2'))] },
        { nodeKey: 'n1', exit: 'approve' },
      ],
      ['missing_else', { n1: [approveTo(when(1, 'eq', d1, 'n3'))] }, { nodeKey: 'n1', exit: 'approve' }],
      [
        'else_with_condition',
        {
          n1: [
            approveTo(when(1, 'eq', d1, 'n3'), {
              kind: 'else',
              conditions: {
                items: [{ no: 1, field: 'record.departmentId', operator: 'eq', value: d1 }],
                expression: '1',
              },
              target: 'n2',
            } as BranchInput),
          ],
        },
        { nodeKey: 'n1', exit: 'approve', branchNo: 2 },
      ],
      ['direct_mixed', { n1: [approveTo(direct('n3'), otherwise('n2'))] }, { nodeKey: 'n1', exit: 'approve' }],
      [
        'unknown_field',
        { n1: [approveTo(when(1, 'eq', d1, 'n3', 'employee.salary'), otherwise('n2'))] },
        { nodeKey: 'n1', exit: 'approve', branchNo: 1 },
      ],
      [
        'invalid_condition',
        // “属于”给单个字符串：值必须是列表
        { n1: [approveTo(when(1, 'in', d1, 'n3'), otherwise('n2'))] },
        { nodeKey: 'n1', exit: 'approve', branchNo: 1 },
      ],
      ['unknown_target', { n1: [approveTo(direct('nope'))] }, { nodeKey: 'n1', exit: 'approve', branchNo: 1 }],
      [
        'exit_not_on_node',
        { n1: [{ exit: 'disagree', branches: [direct('n3')] }] },
        { nodeKey: 'n1', exit: 'disagree' },
      ],
    ];
  };

  it('逐条违规 → 400 APPROVAL_ROUTE_INVALID，details.reason 精确', async () => {
    const s = await routeScene(testDb().db, 'f478-02-save');
    for (const [reason, routes, at] of cases(s)) {
      const { response } = await saveRoutes(s, routes);
      expect(await errorInfo(response), reason).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason,
        detailCode: 'APPROVAL_ROUTE_INVALID',
        ...at,
      });
    }
  });

  it('违规保存不改动草稿：读回仍是原先的版本', async () => {
    const s = await routeScene(testDb().db, 'f478-02-unchanged');
    const first = await saveRoutes(s, { n1: [approveTo(direct('n3'))] });
    const saved = await s.w.json<ProcessView>(first.response);
    const refused = await saveRoutes(s, { n1: [approveTo(direct('n1'))] }, saved);
    expect((await errorInfo(refused.response)).reason).toBe('self_target');
    const after = await getProcess(s.w, saved.id);
    expect(after.revision).toBe(saved.revision);
    expect(after.latestVersion.nodes[0]).toMatchObject({ routes: [{ exit: 'approve', branches: [{ target: 'n3' }] }] });
  });

  it('不可达节点：保存草稿允许，发布时 400 unreachable_node', async () => {
    const s = await routeScene(testDb().db, 'f478-02-unreachable');
    // N1 直达 N3，N2 没有任何来路
    const { response, created } = await saveRoutes(s, { n1: [approveTo(direct('n3'))] });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await s.w.json<ProcessView>(response);
    const published = await s.w.request(s.w.hr.id, 'POST', `${APV}/processes/${created.id}/publish`, {
      ifMatch: saved.revision,
    });
    expect(await errorInfo(published)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      reason: 'unreachable_node',
      detailCode: 'APPROVAL_ROUTE_INVALID',
      nodeKey: 'n2',
    });
  });

  it('业务出口：任何审批类型提交都是 business_exit_type（注册表尚空）；出口组不完整 / 会签用业务出口另有原因', async () => {
    const s = await routeScene(testDb().db, 'f478-02-business');
    for (const approvalType of ['transfer', 'leave', 'retirement']) {
      const created = await s.w.createProcess({ approvalType, nodes: s.nodes().slice(0, 2) });
      const nodes = created.latestVersion.nodes.map((node) =>
        node.key === 'n1' ? { ...node, exits: ['approve_no_rehire', 'approve_rehire'] } : node,
      );
      const response = await putDraft(s.w, created, cloneForPut(created.latestVersion, { nodes }));
      expect(await errorInfo(response), approvalType).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'business_exit_type',
        detailCode: 'APPROVAL_ROUTE_INVALID',
        nodeKey: 'n1',
      });
    }
    const created = await s.w.createProcess({ nodes: s.nodes().slice(0, 2) });
    const lonely = created.latestVersion.nodes.map((node) =>
      node.key === 'n1' ? { ...node, exits: ['approve_rehire'] } : node,
    );
    const lonelyResponse = await putDraft(s.w, created, cloneForPut(created.latestVersion, { nodes: lonely }));
    expect(await errorInfo(lonelyResponse)).toMatchObject({
      status: 400,
      reason: 'incomplete_exit_group',
      nodeKey: 'n1',
    });
  });

  it('未知编码的出口、多余字段、超出上限的分支数：400，不进入分支校验', async () => {
    const s = await routeScene(testDb().db, 'f478-02-shape');
    const created = await s.w.createProcess({ nodes: s.nodes().slice(0, 3) });
    const send = (routes: unknown) =>
      putDraft(
        s.w,
        created,
        cloneForPut(created.latestVersion, {
          nodes: created.latestVersion.nodes.map((node) => (node.key === 'n1' ? { ...node, routes } : node)),
        }),
      );
    const unknownExit = await send([{ exit: 'maybe', branches: [{ kind: 'direct', target: 'n3' }] }]);
    expect(unknownExit.status).toBe(400);
    const extra = await send([{ exit: 'approve', branches: [{ kind: 'direct', target: 'n3', note: 'x' }] }]);
    expect(extra.status).toBe(400);
    const tooMany = await send([
      { exit: 'approve', branches: Array.from({ length: 11 }, () => ({ kind: 'direct', target: 'n3' })) },
    ]);
    expect(tooMany.status).toBe(400);
    const nullTarget = await send([{ exit: 'approve', branches: [{ kind: 'direct', target: null }] }]);
    expect(nullTarget.status).toBe(400);
    const twice = await send([
      { exit: 'approve', branches: [{ kind: 'direct', target: 'n3' }] },
      { exit: 'approve', branches: [{ kind: 'direct', target: 'n2' }] },
    ]);
    expect(twice.status).toBe(400);
  });

  it('合法的复杂配置能保存：不同意出口路由到后续节点，Else 指向 END', async () => {
    const s = await routeScene(testDb().db, 'f478-02-valid');
    const nodes = s.nodes({ n1: { exits: ['approve', 'disagree'] } });
    const created = await s.w.createProcess({ nodes });
    const body = cloneForPut(created.latestVersion, {
      nodes: withRoutesOn(created.latestVersion.nodes, {
        n1: [
          approveTo(when(1, 'in', [s.depts.d1], 'n3'), otherwise('END')),
          { exit: 'disagree', branches: [direct('n4')] },
        ],
      }),
    });
    const response = await putDraft(s.w, created, body);
    expect(response.status, await response.clone().text()).toBe(200);
  });

  describe('priority 取值范围（库里是 smallint：1～32767）', () => {
    const routesAt = (s: RouteScene, priority: number): RoutesInput => ({
      n1: [approveTo(when(priority, 'eq', s.depts.d1, 'n3'), otherwise('n2'))],
    });
    const invalid = { status: 400, code: 'VALIDATION_FAILED', reason: 'invalid_condition' } as const;
    const at = { detailCode: 'APPROVAL_ROUTE_INVALID', nodeKey: 'n1', exit: 'approve', branchNo: 1 } as const;

    it('草稿 PUT：32767 保存成功并读回；32768 / 0 / 小数 → 400 invalid_condition，草稿与 revision 不变', async () => {
      const s = await routeScene(testDb().db, 'f478-02-priority-put');
      const ok = await saveRoutes(s, routesAt(s, 32767));
      const saved = await s.w.json<ProcessView>(ok.response);
      expect(saved.latestVersion.nodes[0]).toMatchObject({ routes: [{ branches: [{ priority: 32767 }, {}] }] });
      for (const priority of [32768, 2147483648, 0, 1.5]) {
        const { response } = await saveRoutes(s, routesAt(s, priority), saved);
        expect(await errorInfo(response), String(priority)).toMatchObject({ ...invalid, ...at });
        const after = await getProcess(s.w, saved.id);
        expect(after.revision, String(priority)).toBe(saved.revision);
        expect(after.latestVersion.nodes[0], String(priority)).toMatchObject({
          routes: [{ branches: [{ priority: 32767 }, {}] }],
        });
      }
    });

    it('创建流程：32767 成功；32768 → 400 invalid_condition，且不落库', async () => {
      const s = await routeScene(testDb().db, 'f478-02-priority-create');
      const create = (priority: number, code: string) =>
        s.w.request(s.w.hr.id, 'POST', `${APV}/processes`, {
          ifMatch: 0,
          body: {
            code,
            name: '合成调动流程',
            approvalType: 'transfer',
            priority: 0,
            isFallback: false,
            exceptionAdminUserId: null,
            conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] },
            nodes: withRoutesOn(s.nodes(), routesAt(s, priority)),
          },
        });
      const okCode = `P_${uniqueSuffix()}`;
      const ok = await create(32767, okCode);
      expect(ok.status, await ok.clone().text()).toBe(201);
      const badCode = `P_${uniqueSuffix()}`;
      expect(await errorInfo(await create(32768, badCode))).toMatchObject({ ...invalid, ...at });
      const listed = await s.w.json<{ items: { code: string }[] }>(
        await s.w.request(s.w.hr.id, 'GET', `${APV}/processes`),
      );
      expect(listed.items.map((item) => item.code)).toContain(okCode);
      expect(listed.items.map((item) => item.code)).not.toContain(badCode);
    });
  });
});
