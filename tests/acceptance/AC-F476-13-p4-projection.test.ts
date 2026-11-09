/**
 * AC-F476-13（P4 第 1 轮审查返工）：已办读取的“业务内容”整体取自办理时冻结份，并逐字段按
 * 办理时上限 ∩ 办理节点表单 ∩ 当前字段权取舍（P1-1）；自定义字段按 `custom:<id>` 判权（P2-2）；
 * 原定最后工作日跟随最后工作日的披露（P2-3）；新写办理份局部缺损一律 503（P2-4）。
 * 第 2 轮返工（P2-4）：投影实际会读的必需键（日期块、版本列表、字段对象等）缺失或非法，也一律 503，不得 500。
 * 夹具：业务数据都经真实接口创建；日期、部门等取值手写，便于断言“旁路值”不在整个响应里。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  BEFORE,
  AFTER,
  activateOn,
  changeAfterHandled,
  changeLastWorkDate,
  damageCopy,
  detailEntries,
  handledScene,
  readEntries,
  type Damage,
  type ScenarioKind,
} from './AC-F476-p4-support.js';

const testDb = useTestDb();
const EXIT_SCENES: ScenarioKind[] = ['leave', 'retirement'];
const text = (body: unknown) => JSON.stringify(body);

describe('AC-F476-13 P4 leave：办理后改期，已办读取不见后改的日期（P1-1）', () => {
  it('整个响应里没有改后的日期（含版本列表），发起人读现值才有', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-proj-date-leave', 'leave');
    await changeLastWorkDate(scene, '2026-10-25');
    const approver = await readEntries(scene, scene.approver.userId);
    for (const entry of detailEntries('leave')) {
      expect(approver[entry]!.status, `leave/${entry}`).toBe(200);
      expect(approver[entry]!.body.contentView?.mode, `leave/${entry}`).toBe('frozen');
      for (const bypass of ['2026-10-25', '2026-10-26'])
        expect(text(approver[entry]!.body), `leave/${entry} 不应含 ${bypass}`).not.toContain(bypass);
    }
    const initiator = await readEntries(scene, scene.w.hr.id);
    expect(text(initiator.exit!.body)).toContain('2026-10-25');
  });

  it('节点表单含最后工作日与生效日：日期块与版本取办理时的值（手写 2026-10-20 / 2026-10-21）', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-proj-dates-leave', 'leave', {
      nodeForm: ['lastWorkDate', 'effectiveDate'],
    });
    await changeLastWorkDate(scene, '2026-10-25');
    const body = (await readEntries(scene, scene.approver.userId)).exit!.body;
    expect(body.dates).toMatchObject({
      planned: { lastWorkDate: '2026-10-20', effectiveDate: '2026-10-21' },
      final: { lastWorkDate: '2026-10-20', effectiveDate: '2026-10-21' },
    });
    expect(text(body)).not.toContain('2026-10-25');
    expect(text(body)).not.toContain('2026-10-26');
  });
});

describe.each(EXIT_SCENES)('AC-F476-13 P4 %s：节点表单之外的部门不由现值补露（P1-1）', (kind) => {
  it('整个响应里没有被办理人所在部门的编号', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-proj-dept-${kind}`, kind);
    const approver = await readEntries(scene, scene.approver.userId);
    for (const entry of detailEntries(kind)) {
      expect(approver[entry]!.status, `${kind}/${entry}`).toBe(200);
      expect(text(approver[entry]!.body), `${kind}/${entry}`).not.toContain(scene.departmentId);
    }
  });
});

describe('AC-F476-13 P4 业务批准生效后，已办读取不由现值旁路补露（P1-1）', () => {
  it('transfer：节点表单不含地点，生效后读 /businesses/:id，整个响应不含该地点', async () => {
    const scene = await handledScene(testDb().db, 'f476-p4-proj-record', 'transfer', {
      action: 'approve',
      nodeForm: ['effectiveDate', 'departmentId'],
    });
    await activateOn(scene, '2026-10-06');
    const approver = (await readEntries(scene, scene.approver.userId)).business!;
    expect(approver.status).toBe(200);
    expect(approver.body.contentView?.mode).toBe('frozen');
    expect(text(approver.body)).not.toContain(BEFORE);
    // 对照：发起人读现值，生效后的现值记录里确有该地点
    expect(text((await readEntries(scene, scene.w.hr.id)).business!.body)).toContain(BEFORE);
  });
});

describe.each(['transfer', 'hire', 'regularization'] as ScenarioKind[])(
  'AC-F476-13 P4 %s：自定义字段按 custom:<id> 判权，响应键保持裸 id（P2-2）',
  (kind) => {
    it('节点表单含该自定义字段：已办读到办理时的值，发起人读到改后的值', async () => {
      const scene = await handledScene(testDb().db, `f476-p4-proj-custom-${kind}`, kind, { customField: 'node' });
      await changeAfterHandled(scene);
      const id = scene.customFieldId!;
      const approver = (await readEntries(scene, scene.approver.userId)).business!;
      expect(approver.status).toBe(200);
      expect(approver.body.customFields).toEqual({ [id]: BEFORE });
      const initiator = (await readEntries(scene, scene.w.hr.id)).business!;
      expect(initiator.body.customFields).toEqual({ [id]: AFTER });
    });

    it('节点表单不含该自定义字段：已办读取没有它', async () => {
      const scene = await handledScene(testDb().db, `f476-p4-proj-custom-hidden-${kind}`, kind, {
        customField: 'hidden',
      });
      const approver = (await readEntries(scene, scene.approver.userId)).business!;
      expect(approver.status).toBe(200);
      expect(approver.body.customFields).toEqual({});
    });
  },
);

describe.each(EXIT_SCENES)('AC-F476-13 P4 %s：原定最后工作日跟随最后工作日披露（P2-3）', (kind) => {
  it('节点放开最后工作日与生效日：原定日期块是办理时手写的值，不是 null', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-proj-planned-${kind}`, kind, {
      nodeForm: ['lastWorkDate', 'effectiveDate'],
    });
    const approver = await readEntries(scene, scene.approver.userId);
    for (const entry of detailEntries(kind).filter((e) => e !== 'business')) {
      expect(approver[entry]!.status, `${kind}/${entry}`).toBe(200);
      const body = approver[entry]!.body;
      expect(body.dates, `${kind}/${entry}`).toMatchObject({
        planned: { lastWorkDate: '2026-10-20', effectiveDate: '2026-10-21' },
      });
    }
  });

  it('节点不含最后工作日：原定日期块为空，响应不含任何手写日期', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-proj-planned-hidden-${kind}`, kind, {
      nodeForm: kind === 'leave' ? ['exitTypeCode'] : ['handoverEmployeeId'],
    });
    const approver = await readEntries(scene, scene.approver.userId);
    for (const entry of detailEntries(kind).filter((e) => e !== 'business')) {
      const body = approver[entry]!.body;
      expect(text(body), `${kind}/${entry}`).not.toMatch(/2026-10-2[0-9]/);
    }
  });
});

describe.each(EXIT_SCENES)('AC-F476-13 P4 %s：新办理份局部缺损 → 统一 503（P2-4，非旧数据兼容）', (kind) => {
  const sections = [
    ['ext.exit 整段缺失', 'remove', ['ext', 'exit']],
    ['ext.exit 为 null', 'null', ['ext', 'exit']],
    ['ext.business 整段缺失', 'remove', ['ext', 'business']],
    ['ext.business 为 null', 'null', ['ext', 'business']],
    ['ext 为 null', 'null', ['ext']],
  ] as const;
  it.each(sections)('%s', async (_name, damage, path) => {
    const scene = await handledScene(testDb().db, `f476-p4-proj-broken-${kind}-${path.join('-')}-${damage}`, kind);
    await damageCopy(scene, damage, path);
    const approver = await readEntries(scene, scene.approver.userId);
    for (const entry of detailEntries(kind)) {
      expect(approver[entry]!.status, `${kind}/${entry}`).toBe(503);
      expect(text(approver[entry]!.body), `${kind}/${entry}`).toContain('APPROVAL_HANDLING_CONTENT_MISSING');
    }
    // 发起人读现值，不受影响
    const initiator = await readEntries(scene, scene.w.hr.id);
    for (const entry of detailEntries(kind)) expect(initiator[entry]!.status, `${kind}/${entry}`).toBe(200);
  });
});

describe('AC-F476-13 P4 transfer：新办理份缺 ext.business → 503（P2-4）', () => {
  it.each([['remove'], ['null']] as const)('ext.business %s', async (damage) => {
    const scene = await handledScene(testDb().db, `f476-p4-proj-broken-transfer-${damage}`, 'transfer');
    await damageCopy(scene, damage, ['ext', 'business']);
    const approver = (await readEntries(scene, scene.approver.userId)).business!;
    expect(approver.status).toBe(503);
    expect(text(approver.body)).toContain('APPROVAL_HANDLING_CONTENT_MISSING');
  });
});

/** 投影实际会读的必需键：缺失 / null / 非法值都按办理份不可读处理（503），不得在投影里抛 500。 */
const BUSINESS_KEYS: readonly (readonly [string, Damage])[] = [
  ['fields', 'invalid'],
  ['customFields', 'remove'],
  ['customFields', 'invalid'],
  ['record', 'remove'],
  ['record', 'invalid'],
  ['effectiveDate', 'remove'],
  ['effectiveDate', 'invalid'],
];
const EXIT_KEYS: readonly (readonly [string, Damage])[] = [
  ['plannedLastWorkDate', 'remove'],
  ['plannedLastWorkDate', 'null'],
  ['plannedLastWorkDate', 'invalid'],
  ['lastWorkDate', 'remove'],
  ['lastWorkDate', 'invalid'],
  ['effectiveDate', 'remove'],
  ['effectiveDate', 'invalid'],
  ['versions', 'invalid'],
];

async function expectAll503(kind: ScenarioKind, label: string, damage: Damage, path: readonly string[]) {
  const scene = await handledScene(testDb().db, `f476-p4-proj-key-${kind}-${label}-${damage}`, kind);
  await damageCopy(scene, damage, path);
  const approver = await readEntries(scene, scene.approver.userId);
  for (const entry of detailEntries(kind)) {
    expect(approver[entry]!.status, `${kind}/${entry} ${path.join('.')} ${damage}`).toBe(503);
    expect(text(approver[entry]!.body), `${kind}/${entry}`).toContain('APPROVAL_HANDLING_CONTENT_MISSING');
  }
}

describe('AC-F476-13 P4 transfer：业务部分的必需键缺失 / 非法 → 503（第 2 轮 P2-4）', () => {
  it.each(BUSINESS_KEYS)('ext.business.%s %s', async (key, damage) => {
    await expectAll503('transfer', `b-${key}`, damage, ['ext', 'business', key]);
  });
});

describe.each(EXIT_SCENES)('AC-F476-13 P4 %s：离退部分的必需键缺失 / 非法 → 各入口 503（第 2 轮 P2-4）', (kind) => {
  it.each(EXIT_KEYS)('ext.exit.%s %s', async (key, damage) => {
    await expectAll503(kind, `x-${key}`, damage, ['ext', 'exit', key]);
  });
  it('ext.business.effectiveDate invalid：离退入口同样 503', async () => {
    await expectAll503(kind, 'b-effectiveDate', 'invalid', ['ext', 'business', 'effectiveDate']);
  });
});
