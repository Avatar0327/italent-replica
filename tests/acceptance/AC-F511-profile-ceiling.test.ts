/**
 * F-511（F-476 P5 #651 第 4 轮 Sol 核实后补）：兼职审批快照里的员工档案只读字段 gender / age（profileFields，
 * 按员工信息对象 PERSONNEL_OBJECT 的字段权，DEC-122）在已办人的审批中心冻结详情里，按「办理时上限 ∩ 当前字段权」披露：
 * 引擎为 profileFields 另存办理时上限，办理时有权的已办人照常可见（对齐 DEC-834④），办理时无权或事后才授权的仍不可见。
 * 原先只记 snapshot.fieldObjectCode（兼职 = 任职记录）的上限，冻结详情一律不显示这两个字段（少露、不补露）。
 * 系统办理份没有办理人，上限存空（失败闭合）。反向自证：删掉引擎另存的 profileCeiling 或读取侧的放行，A / C 用例变红。
 */
import { sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import { rights } from './AC-F476-p5-support.js';

const testDb = useTestDb();

async function handled(label: string, options: { autoSecond?: boolean } = {}) {
  const w = await requestWorld(testDb().db, label, { profileForm: true, ...options });
  const r = rights(w);
  const record = await w.seedRecord({ endDate: '2026-10-31' });
  const created = await w.extend(record, '2026-12-31');
  await w.send(created.id, created.revision);
  const [first] = w.order.extend;
  const view = await w.instance(created.id);
  /** 已办人读审批中心冻结详情，返回表单值的键名（键在 = 披露了该字段）。 */
  const formKeys = async (user: string) => {
    const centre = await r.detail(user, view.id);
    expect(centre.status).toBe(200);
    const form = (centre.body as { form?: { values?: object } }).form;
    return Object.keys(form?.values ?? {});
  };
  return { w, r, first: first!, instanceId: view.id, formKeys };
}

describe('F-511 兼职审批 profileFields（gender / age）：办理时上限 ∩ 当前字段权', () => {
  it('A 办理时有权的已办人：冻结详情照常显示 gender / age', async () => {
    const s = await handled('f511-seen');
    await s.r.decide(s.instanceId, s.first, 'approve');
    const frozen = await s.r.detail(s.first.userId, s.instanceId);
    expect((frozen.body as { contentView?: { mode: string } }).contentView?.mode).toBe('frozen');
    expect(await s.formKeys(s.first.userId)).toEqual(expect.arrayContaining(['gender', 'age']));
  });

  it('B 办理时无权（字段级）：事后补授权也不补露，另一个办理时有权的字段照常', async () => {
    const s = await handled('f511-unseen');
    s.r.hide(PERSONNEL_OBJECT, 'gender');
    await s.r.decide(s.instanceId, s.first, 'approve');
    s.r.show(PERSONNEL_OBJECT, 'gender');
    const keys = await s.formKeys(s.first.userId);
    expect(keys, '办理时看不到的 gender 事后补授权也不得补露').not.toContain('gender');
    expect(keys, '办理时看得到的 age 照常').toContain('age');
  });

  it('C 办理时有权、读取前撤权：按当前字段权隐藏（上限不是授权）', async () => {
    const s = await handled('f511-revoked');
    await s.r.decide(s.instanceId, s.first, 'approve');
    s.r.hide(PERSONNEL_OBJECT, 'age');
    const keys = await s.formKeys(s.first.userId);
    expect(keys).not.toContain('age');
    expect(keys).toContain('gender');
  });

  it('D 同人自动同意的系统办理份：办理人为空，profileFields 上限存空；人工份存办理人的可见字段', async () => {
    const s = await handled('f511-system', { autoSecond: true });
    await s.r.decide(s.instanceId, s.first, 'approve');
    const rows = await withTenant(s.w.db, s.w.tenant.id,async (tx) => {
      const result = await tx.execute(sql`SELECT c.handling_kind, c.actor_user_id::text AS actor,
          c.content->'profileCeiling' AS ceiling
        FROM approval_handling_contents c
        JOIN approval_instance_logs l ON l.tenant_id = c.tenant_id AND l.id = c.handling_log_id
        WHERE c.instance_id = ${s.instanceId}::uuid ORDER BY l.created_at, l.seq`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        handling_kind: string;
        actor: string | null;
        ceiling: string[] | null;
      }[];
    });
    expect(rows.map((row) => [row.handling_kind, row.actor])).toEqual([
      ['human', s.first.userId],
      ['system', null],
    ]);
    expect(rows[0]!.ceiling).toEqual(expect.arrayContaining(['age', 'gender']));
    expect(rows[1]!.ceiling).toEqual([]);
  });

  it('E profileFields 为空的审批类型（员工子集变更）不带 profileCeiling，办理份内容形状不变', async () => {
    const { personnelScene, latestInstance, textFieldsOf } = await import('./AC-F476-p5-support.js');
    const scene = await personnelScene(testDb().db, 'f511-empty');
    const r = rights(scene.w);
    const [field] = textFieldsOf('education') as [string];
    const request = await scene.apply('education', { [field]: 'ZZ_办理时' });
    const instance = await latestInstance(scene.w, 'personnel_change', request.id);
    await r.decide(instance.id, scene.n1, 'approve');
    const [row] = await withTenant(scene.w.db, scene.w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT c.content ? 'profileCeiling' AS has
        FROM approval_handling_contents c WHERE c.instance_id = ${instance.id}::uuid`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { has: boolean }[];
    });
    expect(row!.has).toBe(false);
  });
});
