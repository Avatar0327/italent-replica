/**
 * F-237（#419 B3-2 第 2 轮审查后补建议）：离职预览在“将作废的在途申请”超过上限时给出 EXIT_APPLICATIONS_TO_VOID 之外的
 * EXIT_APPLICATIONS_TOO_MANY 提示（只提示，不阻断预览；生效时 voidInFlightApplications 才整单拒绝）。
 * 预览与执行共用 VOID_LIMIT / exceedsVoidLimit；提示只带 limit，不带实际数量或条目（不暴露操作人看不到的申请）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { VOID_LIMIT } from '../../apps/api/src/modules/employment/exit-void-applications.js';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LAST_WORK_DATE = '2026-10-20';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);

interface Preview {
  warnings: { reason: string; limit?: number; items?: unknown[]; hiddenCount?: number }[];
}
async function previewOf(x: DownstreamWorld): Promise<Preview> {
  const response = await x.session.request('POST', `/exits/employees/${x.employee.id}/preview`, {
    body: { lastWorkDate: LAST_WORK_DATE },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Preview;
}
const reasons = (preview: Preview) => preview.warnings.map((item) => item.reason);

describe('F-237 离职预览：在途申请超上限提示', () => {
  it('上限 + 1：预览 200，带 EXIT_APPLICATIONS_TOO_MANY（只含 limit），不列条目，只读不写', async () => {
    const x = await world('f237-over');
    await x.bulkDrafts(VOID_LIMIT + 1);
    const counts = await x.stateCounts();
    const preview = await previewOf(x);
    expect(preview.warnings.find((item) => item.reason === 'EXIT_APPLICATIONS_TOO_MANY')).toEqual({
      reason: 'EXIT_APPLICATIONS_TOO_MANY',
      limit: VOID_LIMIT,
    });
    expect(reasons(preview)).not.toContain('EXIT_APPLICATIONS_TO_VOID');
    expect(await x.stateCounts()).toEqual(counts);
  }, 600_000);

  it('恰为上限：不带超限提示，照常列出将作废的申请', async () => {
    const x = await world('f237-at-limit');
    await x.bulkDrafts(VOID_LIMIT);
    const preview = await previewOf(x);
    expect(reasons(preview)).not.toContain('EXIT_APPLICATIONS_TOO_MANY');
    const toVoid = preview.warnings.find((item) => item.reason === 'EXIT_APPLICATIONS_TO_VOID')!;
    expect(toVoid.items).toHaveLength(VOID_LIMIT);
  }, 600_000);

  it('没有在途申请：不带超限提示，原有两项 warning 保持', async () => {
    const x = await world('f237-none');
    const preview = await previewOf(x);
    expect(reasons(preview)).toEqual(['EXIT_APPLICATIONS_TO_VOID', 'EXIT_FUTURE_TRANSFER_LANDED']);
  });

  it('少量在途申请（回归）：EXIT_APPLICATIONS_TO_VOID 列出条目，无超限提示', async () => {
    const x = await world('f237-few');
    const draft = await x.transferIn('draft', '2026-10-25');
    const preview = await previewOf(x);
    expect(reasons(preview)).not.toContain('EXIT_APPLICATIONS_TOO_MANY');
    const toVoid = preview.warnings.find((item) => item.reason === 'EXIT_APPLICATIONS_TO_VOID')!;
    expect(toVoid.items).toEqual([expect.objectContaining({ businessId: draft.id })]);
  });
});
