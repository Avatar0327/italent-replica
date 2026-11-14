/**
 * F-326 S7a：AC-APV-F326-31（去重 / 复用，类型感知）、AC-APV-F326-33（在途旧版本）。
 * 设计器侧只发 `specified`（带人员 ID）；服务端判定新建 / 原地更新 / 继承，节点库内只存 public_variable。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  APPROVAL,
  audits,
  autoAt,
  autoRows,
  firstAuto,
  counter,
  create,
  dispatch,
  draftOk,
  manager,
  newVersion,
  peopleOf,
  publishWith,
  readProcess,
  s4World,
  specified,
  storedNodes,
  variableCount,
} from './AC-APV-F326-S7a-support.js';
import { references, variableCommand } from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });

describe('AC-APV-F326-31 去重 / 复用', () => {
  it('① 草稿原样重存 → 变量数不变，无新审计；② 改人 → 同一变量更新并记 auto_update', async () => {
    const w = await s4World(database().db, 's7a-reuse-draft');
    const process = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, process.id);
    const total = await variableCount(w);

    const again = await draftOk(w, process, [single('n1', w.near.userId)]);
    expect(await variableCount(w)).toBe(total);
    expect(actionsOf(await audits(w, x!.id))).toEqual(['auto_create']);

    await draftOk(w, again, [single('n1', w.head.userId)]);
    const [after, ...rest] = await autoRows(w, process.id);
    expect(rest).toEqual([]);
    expect(after).toMatchObject({ id: x!.id, data_type: 'person', revision: x!.revision + 1 });
    expect(peopleOf(after!)).toEqual([w.head.userId]);
    const trail = await audits(w, x!.id);
    expect(actionsOf(trail)).toEqual(['auto_create', 'auto_update']);
    expect(trail[1]!.actor).toBe(w.hr.id);
    expect(trail[1]!.before).toMatchObject({ defaultValue: w.near.userId });
    expect(trail[1]!.after).toMatchObject({ defaultValue: w.head.userId });
  });

  it('③ 两个节点选同一人 → 两条变量', async () => {
    const w = await s4World(database().db, 's7a-reuse-two');
    const process = await create(w, [single('n1', w.near.userId), single('n2', w.near.userId)]);
    const rows = await autoRows(w, process.id);
    expect(rows.map((row) => [row.origin_node_key, row.id]).map(([key]) => key)).toEqual(['n1', 'n2']);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('④ 会签 3 个指定人员 + 1 个直线经理 → 1 条 persons 变量 + 直线经理，派单人数与改造前一致', async () => {
    const w = await s4World(database().db, 's7a-reuse-merge');
    const [p2, p3] = [await w.person('合成丙', w.staff), await w.person('合成丁', w.staff)];
    const sources = [specified(w.near.userId), manager, specified(p2.userId), specified(p3.userId)];
    const process = await w.publish(await create(w, [counter(sources, { key: 'n1' })]));
    const rows = await autoRows(w, process.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data_type: 'persons', origin_slot: 'approver' });
    expect(peopleOf(rows[0]!)).toEqual([w.near.userId, p2.userId, p3.userId]);

    const [stored] = await storedNodes(w, process.latestVersion.id);
    expect(stored!.approver_expressions).toEqual([{ type: 'public_variable', value: rows[0]!.id }, manager]);
    const { tasks } = await dispatch(w);
    const assignees = tasks.map(([, user]) => user);
    for (const user of [w.near.userId, p2.userId, p3.userId]) expect(assignees).toContain(user);
    expect(assignees.length).toBeGreaterThanOrEqual(3);
  });

  it('⑤ 编辑最新版本 → v2 草稿引用 v1 同一变量；⑥ v2 改人不新建变量，发布前 v1 仍派原人员', async () => {
    const w = await s4World(database().db, 's7a-reuse-inherit');
    const v1 = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await firstAuto(w, v1.id);
    const draft = await newVersion(w, v1);
    const [stored] = await storedNodes(w, draft.latestVersion.id);
    expect(stored!.approver_expression).toEqual({ type: 'public_variable', value: x!.id });

    const edited = await draftOk(w, draft, [single('n1', w.head.userId)]);
    const rows = await autoRows(w, v1.id);
    expect(rows.map((row) => row.id)).toEqual([x!.id]);
    expect(rows[0]).toMatchObject({ data_type: 'person', revision: x!.revision });
    expect(peopleOf(rows[0]!)).toEqual([w.near.userId]);
    // v1 仍派原人员；发布 v2 后一起改派（DEC-861⑤，生效细节见 AC-57）
    expect((await dispatch(w)).tasks.map(([, user]) => user)).toEqual([w.near.userId]);
    const published = await publishWith(w, edited);
    expect(published.status, await published.clone().text()).toBe(200);
    expect(peopleOf((await autoRows(w, v1.id))[0]!)).toEqual([w.head.userId]);
  });

  it('⑦ 人员顺序不同、集合相同 → 复用同一变量，无写入', async () => {
    const w = await s4World(database().db, 's7a-reuse-order');
    const p2 = await w.person('合成丙', w.staff);
    const process = await create(w, [counter([specified(w.near.userId), specified(p2.userId)])]);
    const x = await firstAuto(w, process.id);
    await draftOk(w, process, [counter([specified(p2.userId), specified(w.near.userId)])]);
    const rows = await autoRows(w, process.id);
    expect(rows.map((row) => row.id)).toEqual([x!.id]);
    expect(rows[0]!.revision).toBe(x!.revision);
    expect(actionsOf(await audits(w, x!.id))).toEqual(['auto_create']);
  });

  it('⑧ 草稿内同节点同人员，会签 → 单人：旧 persons 变量 auto_disable，新建 person 变量', async () => {
    const w = await s4World(database().db, 's7a-reuse-c2s-draft');
    const process = await create(w, [counter([specified(w.near.userId)], { key: 'n1' })]);
    const x = await firstAuto(w, process.id);
    expect(x).toMatchObject({ data_type: 'persons' });
    await draftOk(w, process, [single('n1', w.near.userId)]);
    const rows = await autoRows(w, process.id);
    const old = rows.find((row) => row.id === x!.id)!;
    const fresh = rows.find((row) => row.id !== x!.id)!;
    expect(old.status).toBe('disabled');
    expect(peopleOf(old)).toEqual([w.near.userId]);
    expect(fresh).toMatchObject({ data_type: 'person', status: 'enabled', origin_node_key: 'n1' });
    expect(actionsOf(await audits(w, x!.id))).toEqual(['auto_create', 'auto_disable']);
    expect(actionsOf(await audits(w, fresh.id))).toEqual(['auto_create']);
  });

  it('⑧ 已发布 v1 的继承变量做同样修改 → 新建 person 变量归属 v2，v1 变量保持启用且 v1 照旧派单', async () => {
    const w = await s4World(database().db, 's7a-reuse-c2s-inherit');
    const v1 = await w.publish(await create(w, [counter([specified(w.near.userId)], { key: 'n1' })]));
    const x = await firstAuto(w, v1.id);
    const draft = await newVersion(w, v1);
    await draftOk(w, draft, [single('n1', w.near.userId)]);
    const rows = await autoRows(w, v1.id);
    const fresh = rows.find((row) => row.id !== x!.id)!;
    expect(fresh).toMatchObject({ data_type: 'person', origin_version_id: draft.latestVersion.id });
    const old = rows.find((row) => row.id === x!.id)!;
    expect(old).toMatchObject({ status: 'enabled', revision: x!.revision });
    expect(peopleOf(old)).toEqual([w.near.userId]);
    expect((await dispatch(w)).tasks.map(([, user]) => user)).toEqual([w.near.userId]);
  });

  it('⑨ 单人 → 会签，与 ⑧ 对称（草稿内 / 继承两种）', async () => {
    const w = await s4World(database().db, 's7a-reuse-s2c');
    const draftProcess = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, draftProcess.id);
    await draftOk(w, draftProcess, [counter([specified(w.near.userId)], { key: 'n1' })]);
    const rows = await autoRows(w, draftProcess.id);
    expect(rows.find((row) => row.id === x!.id)!.status).toBe('disabled');
    expect(rows.find((row) => row.id !== x!.id)).toMatchObject({ data_type: 'persons', status: 'enabled' });

    const v1 = await w.publish(await create(w, [single('n1', w.head.userId)]));
    const y = await firstAuto(w, v1.id);
    const draft = await newVersion(w, v1);
    await draftOk(w, draft, [counter([specified(w.head.userId)], { key: 'n1' })]);
    const after = await autoRows(w, v1.id);
    expect(after.find((row) => row.id === y!.id)).toMatchObject({ status: 'enabled', data_type: 'person' });
    expect(after.find((row) => row.id !== y!.id)).toMatchObject({
      data_type: 'persons',
      origin_version_id: draft.latestVersion.id,
    });
  });
});

describe('AC-APV-F326-33 在途旧版本', () => {
  it('v2 不再引用 X 仍不停用；v1 在途实例照派，停用 X 后推进走空人策略', async () => {
    const w = await s4World(database().db, 's7a-inflight');
    const second = await w.person('合成第二申请对象', w.staff);
    const v1 = await w.publish(await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)]));
    const x = await autoAt(w, v1.id, 'n2');
    const first = await dispatch(w);
    const other = await dispatch(w, second.employeeId);

    const draft = await newVersion(w, v1);
    const saved = await draftOk(w, draft, [
      single('n1', w.head.userId),
      { key: 'n2', name: '节点n2', approver: manager },
    ]);
    expect((await autoRows(w, v1.id)).find((row) => row.id === x.id)!.status).toBe('enabled');
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create']);
    const published = await publishWith(w, saved);
    expect(published.status, await published.clone().text()).toBe(200);

    // 推进第一个 v1 实例 → 节点 2 派给 X 的人
    const task = w.pending(first.instance)[0]!;
    const approved = await w.taskAction(w.head.userId, task.id, 'approve', first.instance.revision, {});
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(w.pending(await w.detail(first.instance.id)).map((t) => [t.nodeKey, t.assigneeUserId])).toEqual([
      ['n2', w.near.userId],
    ]);

    const refs = await references(w, 'variables', x.id);
    const stale = refs.items.find((item) => item.versionKind === 'in_flight')!;
    expect(stale).toMatchObject({ versionNo: 1, nodeKey: 'n2', position: 'approver' });
    expect(stale.instanceCount).toBe(2);

    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `${APPROVAL}/variables/${x.id}`),
    );
    const disabled = await variableCommand(w, { id: x.id, revision: current.revision }, 'disable', {
      acknowledgedReferenceCount: refs.total,
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const otherTask = w.pending(other.instance)[0]!;
    const moved = await w.taskAction(w.head.userId, otherTask.id, 'approve', other.instance.revision, {});
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(w.pending(await w.detail(other.instance.id)).map((t) => t.assigneeUserId)).toEqual([w.exceptionAdmin]);
    expect((await readProcess(w, v1.id)).currentVersion?.versionNo).toBe(2);
  });
});
