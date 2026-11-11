/**
 * AC-F476-08（P4 第 1 轮审查返工，P2-1）：已办审批人读本人办理时冻结的内容，不套用其当前数据范围（DEC-834④）。
 * 用真实授权器（不注入 allowAll）：先给办理人“对象 / 字段权 + 含被办理人所在部门的范围”，办理后把范围改为空，
 * 四个入口（任职业务 / 离职 / 退休 / 员工在途退休单）仍读到本人冻结内容；成员、对象权限与当前字段权照旧校验。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  changeAfterHandled,
  detailEntries,
  expectedMarker,
  handledScene,
  markerOf,
  readEntries,
  realWorld,
  type Entry,
  type ScenarioKind,
} from './AC-F476-p4-support.js';

const testDb = useTestDb();
const KINDS: ScenarioKind[] = ['transfer', 'leave', 'retirement'];

const marker = (kind: ScenarioKind, reads: Awaited<ReturnType<typeof readEntries>>) =>
  markerOf(kind, {
    business: reads.business ?? { status: 0, body: {} },
    exit: reads.exit ?? { status: 0, body: {} },
    retirement: reads.retirement ?? reads.inFlight ?? { status: 0, body: {} },
  });

describe.each(KINDS)('AC-F476-08 P4 %s：办理后范围缩小为空，已办审批人仍读本人冻结内容', (kind) => {
  it('范围含员工 → 范围为空：各入口仍 200 + frozen + 办理时的值', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-scope-${kind}`, kind);
    await changeAfterHandled(scene);
    const real = await realWorld(scene);
    const user = scene.approver.userId;
    await real.grantRead(user);
    await real.setScope(user, 'contains');
    const entries: Entry[] = detailEntries(kind);
    const inScope = await readEntries(scene, user, entries, real.fetch);
    for (const entry of entries) expect(inScope[entry]!.status, `范围内 ${kind}/${entry}`).toBe(200);

    await real.setScope(user, 'empty');
    const outScope = await readEntries(scene, user, entries, real.fetch);
    for (const entry of entries) {
      expect(outScope[entry]!.status, `范围为空 ${kind}/${entry}`).toBe(200);
      expect(outScope[entry]!.body.contentView?.mode, `${kind}/${entry}`).toBe('frozen');
    }
    expect(marker(kind, outScope)).toBe(expectedMarker(scene, 'before'));
  });

  it('对照：不是参与人的读者范围为空仍是 404（范围例外只限本人已办）', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-scope-stranger-${kind}`, kind);
    const real = await realWorld(scene);
    const stranger = (await scene.w.person('旁观者', scene.departmentId)).userId;
    await real.grantRead(stranger);
    const reads = await readEntries(
      scene,
      stranger,
      detailEntries(kind).filter((e) => e !== 'inFlight'),
      real.fetch,
    );
    for (const entry of Object.keys(reads) as Entry[]) expect(reads[entry]!.status, `${kind}/${entry}`).toBe(404);
  });

  it('对照：已办审批人没有对象 / 字段权时，范围例外不能绕过权限校验', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-scope-noperm-${kind}`, kind);
    const real = await realWorld(scene);
    const reads = await readEntries(scene, scene.approver.userId, detailEntries(kind), real.fetch);
    for (const entry of Object.keys(reads) as Entry[])
      expect(reads[entry]!.status, `${kind}/${entry}`).toBeGreaterThanOrEqual(403);
  });
});
