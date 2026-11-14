/**
 * F-326 S7a：AC-APV-F326-40 未选人即生成（U-15，DEC-859）。全部经真实 HTTP（createApp），走完整中间件链与全部前置校验：
 * sourceSchema、toDefinition 内各项校验、writeVersionContent 内的第二次来源校验与人员校验。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  audits,
  autoRows,
  firstAuto,
  counter,
  create,
  draftOk,
  expectNoSpecified,
  manager,
  newVersion,
  peopleOf,
  placeholder,
  publicVar,
  s4World,
  saveDraft,
  specified,
  storedNodes,
  variableCount,
} from './AC-APV-F326-S7a-support.js';
import { rejected, variable } from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const single = (key: string, source = placeholder): NodeInput => ({ key, name: `节点${key}`, approver: source });

describe('AC-APV-F326-40 未选人即生成', () => {
  it('① POST /processes 单人节点 approver 为 {specified, null} → 201，person 变量默认值 null、启用', async () => {
    const w = await s4World(database().db, 's7a-ph-1');
    const process = await create(w, [single('n1')]);
    const rows = await autoRows(w, process.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data_type: 'person', status: 'enabled', default_value: null });
    const nodes = await storedNodes(w, process.latestVersion.id);
    expect(nodes[0]!.approver_expression).toEqual({ type: 'public_variable', value: rows[0]!.id });
    expectNoSpecified(nodes);
  });

  it('② PUT draft：会签两个占位 + 直线经理；空人位置一个占位 → persons(null) + 直线经理，空人位置一条 empty_approver', async () => {
    const w = await s4World(database().db, 's7a-ph-2');
    const process = await create(w, [single('seed', specified(w.near.userId))]);
    const nodes = [
      counter([placeholder, placeholder, manager], { key: 'n1' }),
      {
        key: 'n2',
        name: '空人节点',
        approver: manager,
        emptyApproverPolicy: 'specified',
        emptyApproverSources: [placeholder],
      } as NodeInput,
    ];
    const response = await saveDraft(w, process, nodes);
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = await w.json<typeof process>(response);
    const rows = (await autoRows(w, process.id)).filter((row) => row.status === 'enabled');
    const byNode = Object.fromEntries(rows.map((row) => [`${row.origin_node_key}:${row.origin_slot}`, row]));
    expect(byNode['n1:approver']).toMatchObject({ data_type: 'persons', default_value: null });
    expect(byNode['n2:empty_approver']).toMatchObject({ data_type: 'persons', default_value: null });
    const stored = await storedNodes(w, saved.latestVersion.id);
    expect(stored.find((node) => node.node_key === 'n1')!.approver_expressions).toEqual([
      { type: 'public_variable', value: byNode['n1:approver']!.id },
      manager,
    ]);
    expect(stored.find((node) => node.node_key === 'n2')!.empty_approver_sources).toEqual([
      { type: 'public_variable', value: byNode['n2:empty_approver']!.id },
    ]);
    expectNoSpecified(stored);
  });

  it('拒绝对照：会签两个相同人员 + 直线经理 → 400 VALIDATION_FAILED / APPROVAL_DEFINITION_INVALID，无变量写入', async () => {
    const w = await s4World(database().db, 's7a-ph-dup');
    const process = await create(w, [single('seed', specified(w.head.userId))]);
    const total = await variableCount(w);
    const sources = [specified(w.near.userId), specified(w.near.userId), manager];
    const response = await saveDraft(w, process, [counter(sources, { key: 'n1' })]);
    const error = await rejected(response, 400, 'APPROVAL_DEFINITION_INVALID');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('会签节点 n1 的审批人重复');
    expect(await variableCount(w)).toBe(total);
  });

  it('拒绝对照：两个同一公共变量来源 + 一个占位 → 同样 400，无变量写入', async () => {
    const w = await s4World(database().db, 's7a-ph-dup-var');
    const v = await variable(w);
    const process = await create(w, [single('seed', specified(w.head.userId))]);
    const total = await variableCount(w);
    const response = await saveDraft(w, process, [counter([publicVar(v.id), publicVar(v.id), placeholder])]);
    const error = await rejected(response, 400, 'APPROVAL_DEFINITION_INVALID');
    expect(error.message).toContain('审批人重复');
    expect(await variableCount(w)).toBe(total);
  });

  it('拒绝对照：newVersion 草稿的会签既有本位置“指定人员”又以公共变量引用该继承变量 → 合并后查重 400，变量不变', async () => {
    const w = await s4World(database().db, 's7a-ph-merge-dup');
    const p2 = await w.person('合成丙', w.staff);
    const v1 = await w.publish(await create(w, [counter([specified(w.near.userId)], { key: 'n1' })]));
    const x = await firstAuto(w, v1.id);
    const draft = await newVersion(w, v1);
    const total = await variableCount(w);
    const response = await saveDraft(w, draft, [counter([specified(p2.userId), publicVar(x!.id)], { key: 'n1' })]);
    const error = await rejected(response, 400, 'APPROVAL_DEFINITION_INVALID');
    expect(error.message).toContain('会签节点 n1 的审批人重复');
    expect(await variableCount(w)).toBe(total);
    const after = await firstAuto(w, v1.id);
    expect(after).toMatchObject({ id: x!.id, revision: x!.revision });
    expect(peopleOf(after)).toEqual([w.near.userId]);
  });

  it.each([
    ['public_variable 值为 null', { type: 'public_variable', value: null }],
    ['specified 值为空串', { type: 'specified', value: '' }],
  ])('③ 负例：%s → 原错误 APPROVAL_SOURCE_INVALID“审批人来源必须为类型和值”，无变量写入', async (_label, bad) => {
    const w = await s4World(database().db, 's7a-ph-bad');
    const process = await create(w, [single('seed', specified(w.head.userId))]);
    const total = await variableCount(w);
    const response = await saveDraft(w, process, [single('n1', bad as never)]);
    const error = await rejected(response, 422, 'APPROVAL_SOURCE_INVALID');
    expect(error.code).toBe('APPROVAL_SOURCE_INVALID');
    expect(error.message).toBe('审批人来源必须为类型和值');
    expect(await variableCount(w)).toBe(total);
  });

  it('④ 在 ① 的草稿上选人 A 保存 → 同一变量原地更新（auto_update，before 为 null）；改成会签 → 新建 persons 变量', async () => {
    const w = await s4World(database().db, 's7a-ph-4');
    const process = await create(w, [single('n1')]);
    const x = await firstAuto(w, process.id);
    const picked = await draftOk(w, process, [single('n1', specified(w.near.userId))]);
    const updated = await firstAuto(w, process.id);
    expect(updated).toMatchObject({ id: x!.id, data_type: 'person' });
    expect(peopleOf(updated!)).toEqual([w.near.userId]);
    const trail = await audits(w, x!.id);
    expect(actionsOf(trail)).toEqual(['auto_create', 'auto_update']);
    expect(trail[1]!.before).toMatchObject({ defaultValue: null });
    expect(trail[1]!.after).toMatchObject({ defaultValue: w.near.userId });

    await draftOk(w, picked, [counter([specified(w.near.userId)], { key: 'n1' })]);
    const rows = await autoRows(w, process.id);
    expect(rows.find((row) => row.id === x!.id)!.status).toBe('disabled');
    expect(rows.find((row) => row.id !== x!.id)).toMatchObject({ data_type: 'persons', status: 'enabled' });
  });
});
