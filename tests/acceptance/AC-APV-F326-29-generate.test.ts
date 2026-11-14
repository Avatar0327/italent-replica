/**
 * F-326 S7a：AC-APV-F326-29（生成）、30（命名边界）、36（空人位置）。
 * 全部经真实 HTTP（createApp）保存流程，变量 / 节点列 / 审计从库里读回服务端真实写出的行。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  APPROVAL,
  audits,
  autoRows,
  firstAuto,
  counter,
  create,
  expectNoSpecified,
  peopleOf,
  publicVar,
  s4World,
  specified,
  storedNodes,
  type TenantDb,
  variableCount,
} from './AC-APV-F326-S7a-support.js';
import { rejected } from './AC-APV-F326-S4-support.js';
import { handoverWorld } from './AC-EXIT-handover-support.js';
import { api, definition, reach, view } from './AC-EXIT-F316-support.js';

const database = useTestDb();
const tenantOf = (x: { db: TenantDb['db']; tenantId: string }): TenantDb => ({ db: x.db, tenant: { id: x.tenantId } });
const NOW_MS = new Date('2026-10-01T01:00:00.000Z').getTime();
const single = (key: string, name: string, userId: string): NodeInput => ({
  key,
  name,
  approver: specified(userId),
});

describe('AC-APV-F326-29 生成', () => {
  it('单人节点指定 A、会签节点指定 B / C → 两条自动变量，节点只存 public_variable', async () => {
    const w = await s4World(database().db, 's7a-gen');
    const b = await w.person('合成丙', w.staff);
    const process = await create(w, [
      single('n1', '甲节点', w.near.userId),
      counter([specified(w.head.userId), specified(b.userId)], { key: 'n2', name: '乙节点' }),
    ]);
    const [first, second] = await autoRows(w, process.id);
    expect(first).toMatchObject({
      code: `Global.B.${process.code}${NOW_MS}`,
      name: '合成指定人员流程-甲节点',
      description: '通过指定人员自动生成的公共变量',
      usage_scopes: ['process'],
      data_type: 'person',
      status: 'enabled',
      created_by: w.hr.id,
      updated_by: w.hr.id,
      origin: 'auto',
      origin_process_id: process.id,
      origin_version_id: process.latestVersion.id,
      origin_node_key: 'n1',
      origin_slot: 'approver',
    });
    expect(peopleOf(first!)).toEqual([w.near.userId]);
    expect(second).toMatchObject({
      code: `Global.B.${process.code}${NOW_MS + 1}`,
      name: '合成指定人员流程-乙节点',
      data_type: 'persons',
      origin_node_key: 'n2',
      origin_slot: 'approver',
    });
    expect(peopleOf(second!)).toEqual([w.head.userId, b.userId]);

    const nodes = await storedNodes(w, process.latestVersion.id);
    expect(nodes[0]!.approver_expression).toEqual({ type: 'public_variable', value: first!.id });
    expect(nodes[1]!.approver_expressions).toEqual([{ type: 'public_variable', value: second!.id }]);
    expectNoSpecified(nodes);
    expect(actionsOf(await audits(w, first!.id))).toEqual(['auto_create']);
  });

  it.each([
    ['引用不存在的变量（引用校验阶段，晚于生成）', () => publicVar('00000000-0000-4000-8000-000000000001'), 422],
    ['指定了非本租户成员（人员校验阶段）', () => specified('00000000-0000-4000-8000-000000000002'), 422],
  ])('另一节点不合法：%s → 事务回滚，一条变量都不写', async (_label, bad, status) => {
    const w = await s4World(database().db, 's7a-gen-rollback');
    const before = await variableCount(w);
    const response = await w.request(w.hr.id, 'POST', `${APPROVAL}/processes`, {
      ifMatch: 0,
      body: {
        code: 'P_ROLLBACK',
        name: '合成回滚流程',
        approvalType: 'transfer',
        isFallback: true,
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [] },
        nodes: [single('n1', '甲', w.near.userId), { key: 'n2', name: '乙', approver: bad() }].map((node) => ({
          ...node,
          actions: { avoidSelf: true },
        })),
      },
    });
    await rejected(response, status);
    expect(await variableCount(w)).toBe(before);
  });
});

describe('AC-APV-F326-30 命名边界', () => {
  it('① 64 位流程编码只取前 51 位，加 13 位时间戳正好 64 位', async () => {
    const w = await s4World(database().db, 's7a-name-stem');
    const code = `P${'a1_'.repeat(21)}`; // 64 位
    expect(code).toHaveLength(64);
    const process = await create(w, [single('n1', '甲', w.near.userId)], { code });
    const row = await firstAuto(w, process.id);
    expect(row!.code).toBe(`Global.B.${code.slice(0, 51)}${NOW_MS}`);
    expect(row!.code.slice('Global.B.'.length)).toHaveLength(64);
  });

  it('① 非法字符被删、非字母开头补 P（入口：直接以编码 9ab-c / ---- 落库）', async () => {
    const w = await s4World(database().db, 's7a-name-stem2');
    const { createProcess } = await import('../../apps/api/src/modules/approval/definitions.js');
    const node = (userId: string) => ({
      key: 'n1',
      name: '甲',
      approver: { type: 'specified' as const, value: userId },
      kind: 'single' as const,
      exits: ['approve' as const],
      noAssignee: 'exception_admin' as const,
      sameAssigneeSkip: false,
      historySameAssigneeSkip: false,
      sameAssigneeResult: 'approve' as const,
      historySameAssigneeResult: 'approve' as const,
      formFields: [],
      editableFields: [],
      editMode: 'none' as const,
      actions: { transfer: false, addSign: false, copySend: false, retrieve: false, urge: 'inherit' as const },
      rejectCommentRequired: false,
      hideRecords: false,
      rejectResubmit: 'restart' as const,
      messageRules: [],
    });
    for (const [raw, stem] of [
      ['9ab-c', 'P9abc'],
      ['----', 'P'],
    ] as const) {
      const created = await withTenant(w.db, w.tenant.id, (tx) =>
        createProcess(
          tx,
          {
            tenantId: w.tenant.id,
            userId: w.hr.id,
            timezone: 'Asia/Shanghai',
            now: w.clock(),
            expectedRevision: 0,
            commandId: crypto.randomUUID(),
          },
          { code: raw, approvalType: 'transfer' },
          {
            name: '合成规整流程',
            groupName: null,
            description: null,
            priority: 0,
            isFallback: true,
            exceptionAdminUserId: w.exceptionAdmin,
            urgeEnabled: true,
            hideRecordsFromInitiator: false,
            conditions: { items: [], expression: '' },
            nodes: [node(w.near.userId)],
          },
        ),
      );
      const row = await firstAuto(w, created.id);
      expect(row!.code).toBe(`Global.B.${stem}${NOW_MS}`);
      expect(row!.code.slice('Global.B.'.length)).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
    }
  });

  it('② 预定编码已被人工变量占用 → 顺延 +1 毫秒，事务不中断，其余变量照常生成', async () => {
    const w = await s4World(database().db, 's7a-name-collide');
    const code = `PCOLLIDE${Date.now()}`;
    const occupied = await w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', `${APPROVAL}/variables`, {
        ifMatch: 0,
        body: {
          scope: 'public',
          codeSuffix: `${code}${NOW_MS}`,
          name: '合成占用',
          dataType: 'person',
          defaultValue: w.near.userId,
          usageScopes: ['process'],
          enable: true,
        },
      }),
      201,
    );
    const process = await create(w, [single('n1', '甲', w.near.userId), single('n2', '乙', w.head.userId)], { code });
    const rows = await autoRows(w, process.id);
    expect(rows.map((row) => row.code)).toEqual([`Global.B.${code}${NOW_MS + 1}`, `Global.B.${code}${NOW_MS + 2}`]);
    expect(rows.map((row) => row.id)).not.toContain(occupied.id);
  });

  it('③ 流程名 + 节点名超 100 码元：先截流程名，不拆代理对，名称都通过 textViolation', async () => {
    const w = await s4World(database().db, 's7a-name-budget');
    const nodeName = '节点'.repeat(10);
    const process = await create(w, [single('n1', nodeName, w.near.userId)], { name: '😀'.repeat(45) });
    const row = await firstAuto(w, process.id);
    // 预算：100 - 1（连字符）- 20（节点名）= 79 码元，按码点截为 39 个表情（78 码元）
    expect(row!.name).toBe(`${'😀'.repeat(39)}-${nodeName}`);
    expect(row!.name.length).toBeLessThanOrEqual(100);
    const { textViolation } = await import('@italent/domain');
    expect(textViolation(row!.name, { max: 100, multiline: false })).toBeNull();
  });

  it('③ 节点名本身超长时再截节点名', async () => {
    const w = await s4World(database().db, 's7a-name-long-node');
    const process = await create(w, [single('n1', '长'.repeat(100), w.near.userId)], { name: '短' });
    const row = await firstAuto(w, process.id);
    expect(row!.name.length).toBe(100);
    expect(row!.name.startsWith('短-长')).toBe(true);
  });
});

describe('AC-APV-F326-36 空人位置', () => {
  it('空人策略为“指定人员”：另生成 empty_approver 的 persons 变量；审批人取不到人时派给 E / F', async () => {
    const x = await handoverWorld(database().db, 'f326-s7a-empty');
    await x.addSettingItems();
    const fallback = [x.workOwner.userId, x.hrbp.userId];
    const body = {
      code: 'AAA_S7A_EMPTY',
      approvalType: 'exit_handover',
      ...definition(x, { work_handover: { emptyApproverPolicy: 'specified', fallbackUserIds: fallback } }),
    };
    const created = await view(await api(x, 'POST', '', 0, body), 201);
    const rows = await autoRows(tenantOf(x), created.id);
    const empty = rows.filter((row) => row.origin_slot === 'empty_approver');
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({
      name: expect.stringMatching(/-work_handover-审批人为空时$|-审批人为空时$/),
      data_type: 'persons',
      origin_node_key: 'work_handover',
    });
    expect([...peopleOf(empty[0]!)!].sort()).toEqual([...fallback].sort());
    const [stored] = (await storedNodes(tenantOf(x), created.latestVersion.id)).filter(
      (node) => node.node_key === 'work_handover',
    );
    expect(stored!.empty_approver_sources).toEqual([{ type: 'public_variable', value: empty[0]!.id }]);
    expectNoSpecified(await storedNodes(tenantOf(x), created.latestVersion.id));

    await view(await api(x, 'POST', `/${created.id}/publish`, created.revision, {}));
    const run = await reach(x, 'work_handover', false);
    const pending = await x.pendingTasks(run.instanceId);
    expect(pending.map((task) => task.userId).sort()).toEqual([...fallback].sort());
    expect(pending.every((task) => task.nodeKey === 'work_handover' && !task.isExceptionAdmin)).toBe(true);
  });
});
