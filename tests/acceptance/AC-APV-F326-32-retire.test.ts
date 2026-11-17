/**
 * F-326 S7a：AC-APV-F326-32（删节点 / 改来源 / 再生成）、AC-APV-F326-34（审计与手改）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  audits,
  auditAtRevision,
  autoAt,
  autoRows,
  firstAuto,
  autoViewOf,
  create,
  dispatch,
  draftOk,
  editVariable,
  manager,
  newVersion,
  peopleOf,
  readProcess,
  s4World,
  specified,
  variableCount,
  varRow,
  type S4World,
} from './AC-APV-F326-S7a-support.js';
import { references, rejected, variableCommand, VARIABLES } from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });
const viaManager = (key: string): NodeInput => ({ key, name: `节点${key}`, approver: manager });

async function disable(w: S4World, id: string) {
  const row = await varRow(w, id);
  const { total } = await references(w, 'variables', id);
  const response = await variableCommand(w, { id, revision: row.revision }, 'disable', {
    acknowledgedReferenceCount: total,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function enable(w: S4World, id: string) {
  const row = await varRow(w, id);
  return variableCommand(w, { id, revision: row.revision }, 'enable');
}

describe('AC-APV-F326-32 删节点 / 改来源 / 再生成', () => {
  it('① 指定 A → 直线经理 → 指定 A：第 2 次旧变量 auto_disable，第 3 次新建 Y，X 保留为停用', async () => {
    const w = await s4World(database().db, 's7a-retire-1');
    const created = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, created.id);
    const second = await draftOk(w, created, [viaManager('n1')]);
    const third = await draftOk(w, second, [single('n1', w.near.userId)]);
    expect(third.latestVersion.nodes).toHaveLength(1);

    const rows = await autoRows(w, created.id);
    const y = rows.find((row) => row.id !== x!.id)!;
    expect(rows).toHaveLength(2);
    expect(y.code).not.toBe(x!.code);
    const old = rows.find((row) => row.id === x!.id)!;
    expect(old.status).toBe('disabled');
    expect(peopleOf(old)).toEqual([w.near.userId]);
    expect(y.status).toBe('enabled');

    const xTrail = await audits(w, x!.id);
    expect(actionsOf(xTrail)).toEqual(['auto_create', 'auto_disable']);
    expect(xTrail[1]!.actor).toBe(w.hr.id);
    expect(xTrail[1]!.after).toMatchObject({ reason: '不再被引用' });
    expect(actionsOf(await audits(w, y.id))).toEqual(['auto_create']);
  });

  it('② 管理员停用占位变量 X 后设计器同人员重存 → 新建 Y，X 仍停用', async () => {
    const w = await s4World(database().db, 's7a-retire-2');
    const created = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, created.id);
    await disable(w, x!.id);
    await draftOk(w, created, [single('n1', w.near.userId)]);
    const rows = await autoRows(w, created.id);
    const y = rows.find((row) => row.id !== x!.id)!;
    expect(rows.find((row) => row.id === x!.id)!.status).toBe('disabled');
    expect(y.status).toBe('enabled');
    expect(actionsOf(await audits(w, x!.id))).toEqual(['auto_create', 'disable']);
    expect(actionsOf(await audits(w, y.id))).toEqual(['auto_create']);
  });

  it('③ 重新启用 X 时位置已被 Y 占用 → 409；停用 Y 后可启用；再改成其他来源后下次保存 X 被 auto_disable', async () => {
    const w = await s4World(database().db, 's7a-retire-3');
    const created = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, created.id);
    await disable(w, x!.id);
    const saved = await draftOk(w, created, [single('n1', w.near.userId)]);
    const y = (await autoRows(w, created.id)).find((row) => row.id !== x!.id)!;

    const taken = await enable(w, x!.id);
    const error = await rejected(taken, 409);
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ reason: 'APPROVAL_AUTO_VARIABLE_SLOT_TAKEN' });
    expect(JSON.stringify(error.details)).toContain(y.id);
    expect(JSON.stringify(error.details)).toContain(y.code);
    expect((await varRow(w, x!.id)).status).toBe('disabled');

    await disable(w, y.id);
    const ok = await enable(w, x!.id);
    expect(ok.status, await ok.clone().text()).toBe(200);

    // 节点改成直线经理：Y、X 都不再被引用
    const toManager = await draftOk(w, saved, [viaManager('n1')]);
    expect((await varRow(w, x!.id)).status).toBe('disabled');
    const reenabled = await enable(w, x!.id);
    expect(reenabled.status, await reenabled.clone().text()).toBe(200);
    await draftOk(w, toManager, [viaManager('n1')]);
    expect((await varRow(w, x!.id)).status).toBe('disabled');
    const last = await auditAtRevision(w, x!.id, (await varRow(w, x!.id)).revision);
    expect(last.action).toBe('approval.public_variable.auto_disable');
    expect(last.actor).toBe(w.hr.id);
    expect(last.after).toMatchObject({ reason: '不再被引用' });
  });

  it('③ 对照：v1 的另一条自动变量 Z 从未手工启用，v2 不再引用 → 保存后 Z 仍启用，无 auto_disable', async () => {
    const w = await s4World(database().db, 's7a-retire-z');
    const v1 = await w.publish(await create(w, [single('n1', w.near.userId), single('n2', w.head.userId)]));
    const z = await autoAt(w, v1.id, 'n2');
    const draft = await newVersion(w, v1);
    await draftOk(w, draft, [single('n1', w.near.userId), viaManager('n2')]);
    expect((await varRow(w, z.id)).status).toBe('enabled');
    expect(actionsOf(await audits(w, z.id))).toEqual(['auto_create']);
  });

  it('④ 删除节点、清空为其他来源：占位变量都被停用；v2 删掉继承自 v1 的节点 → v1 的变量不变', async () => {
    const w = await s4World(database().db, 's7a-retire-4');
    const created = await create(w, [single('n1', w.near.userId), single('n2', w.head.userId)]);
    const rows = await autoRows(w, created.id);
    expect(rows).toHaveLength(2);
    const [a, b] = [rows[0]!, rows[1]!];
    const removed = await draftOk(w, created, [single('n1', w.near.userId)]);
    expect((await varRow(w, b.id)).status).toBe('disabled');
    expect((await varRow(w, a.id)).status).toBe('enabled');
    await draftOk(w, removed, [viaManager('n1')]);
    expect((await varRow(w, a.id)).status).toBe('disabled');

    const v1 = await w.publish(await create(w, [single('n1', w.near.userId), single('n2', w.head.userId)]));
    const inherited = await autoRows(w, v1.id);
    const draft = await newVersion(w, v1);
    await draftOk(w, draft, [single('n1', w.near.userId)]);
    for (const row of inherited)
      expect(await varRow(w, row.id)).toMatchObject({ status: 'enabled', revision: row.revision });
  });
});

describe('AC-APV-F326-34 审计与手改', () => {
  it('操作人为保存人，前后值为整值；管理员改默认值记 update，视图与运行时跟随', async () => {
    const w = await s4World(database().db, 's7a-audit');
    const far = await w.person('合成丙', w.staff);
    const created = await w.publish(await create(w, [single('n1', w.near.userId)]));
    const x = await firstAuto(w, created.id);
    const [create1] = await audits(w, x!.id);
    expect(create1).toMatchObject({ action: 'approval.public_variable.auto_create', actor: w.hr.id, before: null });
    expect(create1!.after).toMatchObject({ defaultValue: w.near.userId, status: 'enabled', origin: 'auto' });

    const edited = await editVariable(w, x!, { defaultValue: far.userId });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(actionsOf(await audits(w, x!.id))).toEqual(['auto_create', 'update']);
    const view = await readProcess(w, created.id);
    const source = view.currentVersion!.nodes[0]!.approver;
    expect(autoViewOf(source)).toMatchObject({ id: x!.id, userIds: [far.userId] });
    expect((await dispatch(w)).tasks.map(([, user]) => user)).toEqual([far.userId]);
  });

  it('改适用范围 / 编码 / origin → 400 APPROVAL_AUTO_VARIABLE_FIELD_LOCKED；人工新建带 origin → 400', async () => {
    const w = await s4World(database().db, 's7a-locked');
    const created = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, created.id);
    for (const body of [{ usageScopes: ['process', 'external'] }, { code: 'Global.B.Renamed' }, { origin: 'human' }]) {
      const before = await varRow(w, x!.id);
      const response = await editVariable(w, x!, body);
      const error = await rejected(response, 400);
      expect(error.details.reason, JSON.stringify(body)).toBe('APPROVAL_AUTO_VARIABLE_FIELD_LOCKED');
      expect(await varRow(w, x!.id)).toEqual(before);
    }
    const total = await variableCount(w);
    const human = await w.request(w.hr.id, 'POST', VARIABLES, {
      ifMatch: 0,
      body: {
        scope: 'public',
        codeSuffix: `H${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        name: '合成人工变量',
        dataType: 'person',
        defaultValue: w.near.userId,
        usageScopes: ['process'],
        origin: 'auto',
      },
    });
    expect(human.status, await human.clone().text()).toBe(400);
    expect(await variableCount(w)).toBe(total);
  });

  it('管理员把启用中的自动变量默认值清空 → 409 APPROVAL_VARIABLE_EMPTY', async () => {
    const w = await s4World(database().db, 's7a-empty-default');
    const created = await create(w, [single('n1', w.near.userId)]);
    const x = await firstAuto(w, created.id);
    const response = await editVariable(w, x!, { defaultValue: null });
    const error = await rejected(response, 409);
    expect(error.details.reason).toBe('APPROVAL_VARIABLE_EMPTY');
    expect(peopleOf(await varRow(w, x!.id))).toEqual([w.near.userId]);
  });
});
