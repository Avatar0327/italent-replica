/**
 * F-326-L AC-57 ⑤⑥⑦（S7e1 补测，产品代码在 S7a，退路见 F-326-L §9.3）：
 * ⑤ 草稿期间管理员手工改了继承变量 → 发布 409，由发布人选“设计器值 / 保留变量页值”（DEC-864③）；
 * ⑥ 首个版本的草稿改人 → 原地更新占位变量；⑦ 发布被优先级重复拒绝 → 变量与草稿待生效值都不变。
 * 流程 A 为“调动”，流程 B 为“个人信息变更”（引用 X；B 的新实例经真实的自助变更申请发起）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  audits,
  autoAt,
  autoRows,
  autoViewOf,
  create,
  dispatch,
  draftOk,
  editVariable,
  newVersion,
  peopleOf,
  publicVar,
  publishWith,
  readProcess,
  s4World,
  saveDraft,
  specified,
  storedNodes,
  varRow,
  variableCount,
  type S4World,
} from './AC-APV-F326-S7a-support.js';
import { counter, rejected, variableCommand, references } from './AC-APV-F326-S4-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const CONDITION = { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }] };
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });

/** 个人信息变更：每人各提交一张（教育经历自助修改），返回首个待办的办理人。 */
async function changeSubmitter(w: S4World) {
  const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: { education: ['school'] } },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  return async (person: { userId: string; employeeId: string }) => {
    const path = `/api/tenant/personnel/employees/${person.employeeId}/subsets/education`;
    const record = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
      201,
    );
    const created = await w.request(person.userId, 'POST', '/api/tenant/personnel/change-requests', {
      ifMatch: 0,
      body: {
        employeeId: person.employeeId,
        subset: 'education',
        recordId: record.id,
        targetRevision: record.revision,
        values: { school: `乙校${uniqueSuffix()}` },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const request = (await created.json()) as { id: string };
    return w.pending(await w.instanceOf(request.id, person.userId)).map((task) => task.assigneeUserId);
  };
}

/**
 * 基准：A v1 节点 2 = X（A1）；B 的当前版本引用 X；v1 有在途 I 停在节点 1；
 * v2 草稿把节点 2 改选 A2 并保存（草稿的待生效值基于 X 的 r0）；然后管理员在变量页把 X 改为 A3（r1）。
 */
async function conflictWorld(label: string) {
  const w = await s4World(database().db, label);
  const [a2, a3, a4] = [
    await w.person('合成设计器选人', w.staff),
    await w.person('合成变量页改选人', w.staff),
    await w.person('合成变量页再改选人', w.staff),
  ];
  const a = await w.publish(await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)]));
  const x = await autoAt(w, a.id, 'n2');
  await w.publish(
    await create(w, [counter([publicVar(x.id)], { key: 'b1' })], { approvalType: 'personnel_change', name: 'B流程' }),
  );
  const submit = await changeSubmitter(w);
  const inflight = await dispatch(w, (await w.person('合成对象甲', w.staff)).employeeId);
  const saved = await draftOk(w, await newVersion(w, a), [single('n1', w.head.userId), single('n2', a2.userId)]);
  const edited = await editVariable(w, x, { defaultValue: a3.userId });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const r1 = (await varRow(w, x.id)).revision;
  const next = () => w.person(`合成对象${uniqueSuffix()}`, w.staff);
  return { w, a, a2, a3, a4, x, r1, saved, submit, inflight, next };
}

/** 库内版本节点 n2 的来源（读视图会裁掉 pendingRevision 等内部键，所以直接读节点表）。 */
const storedN2 = async (w: S4World, versionId: string) =>
  (await storedNodes(w, versionId)).find((node) => node.node_key === 'n2')!.approver_expression;
const publishAudits = async (w: S4World, processId: string) =>
  (await audits(w, processId, 'approval.process.publish')).length;

const publishView = async (w: S4World, id: string) => (await readProcess(w, id)).currentVersion!;
type Version = Awaited<ReturnType<typeof readProcess>>['latestVersion'];
const slotOf = (version: Version, key = 'n2') => autoViewOf(version.nodes.find((node) => node.key === key)!.approver);
const draftSlot = (view: Awaited<ReturnType<typeof readProcess>>, key = 'n2') => slotOf(view.latestVersion, key);
const pendingTrigger = (versionId: string, resolution?: string) => ({
  kind: 'publish',
  versionId,
  ...(resolution ? { resolution } : {}),
});

describe('AC-APV-F326-57 ⑤ 手工改动冲突（DEC-864③）', () => {
  it('⑤ 读视图 pendingConflict；发布 409，X / 草稿 / 当前版本都不变，无 auto_update 与 publish 审计', async () => {
    const { w, a, a2, a3, x, r1, saved, submit, next } = await conflictWorld('s7e1-57-conflict');
    const before = await publishView(w, a.id);
    expect(draftSlot(await readProcess(w, a.id))).toMatchObject({
      pendingConflict: true,
      revision: r1,
      pendingUserIds: [a2.userId],
    });

    const error = await rejected(await publishWith(w, saved), 409, 'APPROVAL_PENDING_VARIABLE_CONFLICT');
    expect(error.code).toBe('CONFLICT');
    expect((error.details as { conflicts?: unknown[] }).conflicts).toEqual([
      expect.objectContaining({
        variableId: x.id,
        revision: r1,
        designerUserIds: [a2.userId],
        currentUserIds: [a3.userId],
      }),
    ]);

    const row = await varRow(w, x.id);
    expect(peopleOf(row)).toEqual([a3.userId]);
    expect(row.revision).toBe(r1);
    const draft = await readProcess(w, a.id);
    expect(draft.latestVersion.status).toBe('draft');
    expect(draftSlot(draft)).toMatchObject({ pendingUserIds: [a2.userId] });
    expect((await publishView(w, a.id)).id).toBe(before.id);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create', 'update']);
    // 库内：草稿节点仍带待生效值与记录时的变量 revision（r0），没有新增 publish 审计（仅 v1 的一条）
    expect(await storedN2(w, saved.latestVersion.id)).toEqual({
      type: 'public_variable',
      value: x.id,
      pendingUserIds: [a2.userId],
      pendingRevision: x.revision,
    });
    expect(await publishAudits(w, a.id)).toBe(1);
    expect(await submit(await next())).toEqual([a3.userId]);
  });

  it('⑤甲 选“用设计器值”（新命令 ID）→ 200；X 为 A2、revision r1+1，恰好一条 auto_update 记发布人与 resolution', async () => {
    const { w, a, a2, x, r1, saved, submit, next } = await conflictWorld('s7e1-57-designer');
    await rejected(await publishWith(w, saved), 409, 'APPROVAL_PENDING_VARIABLE_CONFLICT');
    const ok = await publishWith(w, saved, {
      pendingResolutions: [{ variableId: x.id, revision: r1, choice: 'designer' }],
    });
    expect(ok.status, await ok.clone().text()).toBe(200);

    const row = await varRow(w, x.id);
    expect(peopleOf(row)).toEqual([a2.userId]);
    expect(row.revision).toBe(r1 + 1);
    const trail = await audits(w, x.id);
    expect(actionsOf(trail)).toEqual(['auto_create', 'update', 'auto_update']);
    expect(trail[1]).toMatchObject({ actor: w.hr.id });
    expect(trail[2]).toMatchObject({ actor: w.hr.id });
    expect(trail[2]!.after).toMatchObject({ trigger: pendingTrigger(saved.latestVersion.id, 'designer') });
    expect(trail[2]!.before).toMatchObject({ defaultValue: expect.anything() });
    // 库内：v2 节点指向 X 且待生效键已清；发布留下第 2 条 publish 审计
    expect(await storedN2(w, saved.latestVersion.id)).toEqual({ type: 'public_variable', value: x.id });
    expect(await publishAudits(w, a.id)).toBe(2);
    expect(await submit(await next())).toEqual([a2.userId]);
  });

  it('⑤乙 选“保留变量页值”→ 200；X 仍为 A3、revision 不变、无 auto_update；v2 节点无待生效键', async () => {
    const { w, a, a3, x, r1, saved, submit, next } = await conflictWorld('s7e1-57-current');
    const ok = await publishWith(w, saved, {
      pendingResolutions: [{ variableId: x.id, revision: r1, choice: 'current' }],
    });
    expect(ok.status, await ok.clone().text()).toBe(200);

    const row = await varRow(w, x.id);
    expect(peopleOf(row)).toEqual([a3.userId]);
    expect(row.revision).toBe(r1);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create', 'update']);
    const published = await readProcess(w, saved.id);
    expect(slotOf(published.currentVersion as unknown as Version)).toMatchObject({ id: x.id });
    expect(JSON.stringify(published.currentVersion)).not.toContain('pending');
    expect((await publishView(w, saved.id)).id).toBe(saved.latestVersion.id);
    // 库内：保留变量页值时同样清掉待生效键（含 pendingRevision），并留下第 2 条 publish 审计
    expect(await storedN2(w, saved.latestVersion.id)).toEqual({ type: 'public_variable', value: x.id });
    expect(await publishAudits(w, a.id)).toBe(2);
    expect(await submit(await next())).toEqual([a3.userId]);
  });

  it('⑤丙 409 之后管理员又改为 A4（r2）；带 r1 的选择发布 → 再 409（revision=r2、currentUserIds=[A4]），X 与草稿不变', async () => {
    const { w, a, a2, a4, x, r1, saved } = await conflictWorld('s7e1-57-stale');
    await rejected(await publishWith(w, saved), 409, 'APPROVAL_PENDING_VARIABLE_CONFLICT');
    const again = await editVariable(w, await varRow(w, x.id), { defaultValue: a4.userId });
    expect(again.status, await again.clone().text()).toBe(200);
    const latest = await varRow(w, x.id);
    expect(latest.revision).toBe(r1 + 1);

    const error = await rejected(
      await publishWith(w, saved, { pendingResolutions: [{ variableId: x.id, revision: r1, choice: 'designer' }] }),
      409,
      'APPROVAL_PENDING_VARIABLE_CONFLICT',
    );
    expect((error.details as { conflicts?: unknown[] }).conflicts).toEqual([
      expect.objectContaining({ variableId: x.id, revision: latest.revision, currentUserIds: [a4.userId] }),
    ]);
    expect(await varRow(w, x.id)).toEqual(latest);
    expect(draftSlot(await readProcess(w, a.id))).toMatchObject({ pendingUserIds: [a2.userId] });
  });

  it('⑤丁 选择里的 variableId 不是本草稿的待生效变量 → 400 APPROVAL_PENDING_RESOLUTION_INVALID，无写入', async () => {
    const { w, a, x, saved } = await conflictWorld('s7e1-57-invalid');
    const stranger = await w.publish(await create(w, [single('n1', w.near.userId)], { name: '无关流程' }));
    const other = await autoAt(w, stranger.id, 'n1');
    const row = await varRow(w, x.id);
    // 只提交无关变量：条数（1）不超过待生效位置数（1），拒绝只能来自“选择须属于本草稿”的校验；
    // 若去掉该校验，X 的冲突没有选择，会变成 409 APPROVAL_PENDING_VARIABLE_CONFLICT
    const response = await publishWith(w, saved, {
      pendingResolutions: [{ variableId: other.id, revision: other.revision, choice: 'designer' }],
    });
    await rejected(response, 400, 'APPROVAL_PENDING_RESOLUTION_INVALID');
    expect(await varRow(w, x.id)).toEqual(row);
    expect(await varRow(w, other.id)).toEqual(other);
    expect((await readProcess(w, a.id)).latestVersion.status).toBe('draft');
    expect(await publishAudits(w, a.id)).toBe(1);
  });

  it('⑤戊 变量页改成与待生效值相同 → 发布 200 不写 X；变量被停用 → 发布 200，新建 person 变量，X 保持停用', async () => {
    const same = await conflictWorld('s7e1-57-same');
    const equal = await editVariable(same.w, await varRow(same.w, same.x.id), { defaultValue: same.a2.userId });
    expect(equal.status, await equal.clone().text()).toBe(200);
    const settled = await varRow(same.w, same.x.id);
    expect((await publishWith(same.w, same.saved)).status).toBe(200);
    expect(await varRow(same.w, same.x.id)).toEqual(settled);
    expect(await storedN2(same.w, same.saved.latestVersion.id)).toEqual({ type: 'public_variable', value: same.x.id });

    const off = await conflictWorld('s7e1-57-disabled');
    const { total } = await references(off.w, 'variables', off.x.id);
    const stopped = await variableCommand(off.w, await varRow(off.w, off.x.id), 'disable', {
      acknowledgedReferenceCount: total,
    });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    const count = await variableCount(off.w);
    const ok = await publishWith(off.w, off.saved);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await variableCount(off.w)).toBe(count + 1);
    expect((await varRow(off.w, off.x.id)).status).toBe('disabled');
    const created = (await autoRows(off.w, off.a.id)).find(
      (row) => row.origin_node_key === 'n2' && row.id !== off.x.id,
    )!;
    expect(created).toMatchObject({ data_type: 'person', origin_version_id: off.saved.latestVersion.id });
    expect(peopleOf(created)).toEqual([off.a2.userId]);
    // 库内：发布后的 v2 节点 2 指向新建的变量（不是停用的 X），且没有残留待生效键
    expect(await storedN2(off.w, off.saved.latestVersion.id)).toEqual({ type: 'public_variable', value: created.id });
  });
});

describe('AC-APV-F326-57 ⑥⑦ 首个版本草稿与优先级重复', () => {
  it('⑥ 首个版本的草稿（无已发布版本）改人 → 原地更新占位变量，auto_update 操作者为保存人，无待生效值', async () => {
    const w = await s4World(database().db, 's7e1-57-first');
    const other = await w.person('合成保存人改选的人', w.staff);
    const process = await create(w, [single('n1', w.near.userId)]);
    const x = await autoAt(w, process.id, 'n1');
    const saved = await draftOk(w, process, [single('n1', other.userId)], w.hr.id);

    const row = await varRow(w, x.id);
    expect(peopleOf(row)).toEqual([other.userId]);
    expect(row.revision).toBe(x.revision + 1);
    const trail = await audits(w, x.id);
    expect(actionsOf(trail)).toEqual(['auto_create', 'auto_update']);
    expect(trail[1]).toMatchObject({ actor: w.hr.id });
    expect(draftSlot(saved, 'n1')).toMatchObject({ id: x.id, userIds: [other.userId] });
    expect(draftSlot(saved, 'n1')!.pendingUserIds).toBeUndefined();
  });

  it('⑦ 发布被 APPROVAL_PRIORITY_DUPLICATE 拒绝 → X 与草稿的待生效值都不变', async () => {
    const w = await s4World(database().db, 's7e1-57-priority');
    const a2 = await w.person('合成待改选人', w.staff);
    const a = await w.publish(
      await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)], {
        isFallback: false,
        priority: 5,
        conditions: CONDITION,
      }),
    );
    await w.publish(
      await create(w, [single('n1', w.head.userId)], {
        isFallback: false,
        priority: 6,
        name: '同类流程',
        conditions: CONDITION,
      }),
    );
    const x = await autoAt(w, a.id, 'n2');
    const draft = await newVersion(w, a);
    const tied = { ...draft, latestVersion: { ...draft.latestVersion, priority: 6 } };
    const saved = await w.json<typeof draft>(
      await saveDraft(w, tied, [single('n1', w.head.userId), single('n2', a2.userId)]),
    );
    const before = await varRow(w, x.id);

    await rejected(await publishWith(w, saved), 409, 'APPROVAL_PRIORITY_DUPLICATE');

    expect(await varRow(w, x.id)).toEqual(before);
    expect(peopleOf(before)).toEqual([w.near.userId]);
    const view = await readProcess(w, a.id);
    expect(view.latestVersion.status).toBe('draft');
    expect(draftSlot(view)).toMatchObject({ pendingUserIds: [a2.userId] });
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create']);
  });
});
