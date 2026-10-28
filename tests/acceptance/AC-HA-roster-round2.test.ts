/**
 * BE-12a 第 1 轮审查返工（#473，DEC-438）：P2-1 个人邮箱列取 BackupMail；P2-2 导出超限 422；P2-3 非法年份 0000 → 400。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type * as RosterQuery from '../../apps/api/src/modules/hr-analysis/roster-query.js';
import { PERSON_OBJECT, parseCsv, rosterWorld, stripBom } from './AC-HA-roster-support.js';

// P2-2：边界值（10000 / 10001）不可能真造出上万条在职任职，用可控的总数替换 countRoster，其余（权限、导出、响应）都走真实路径
const forced = vi.hoisted(() => ({ total: undefined as number | undefined }));
vi.mock('../../apps/api/src/modules/hr-analysis/roster-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RosterQuery>();
  return {
    ...actual,
    countRoster: async (...args: Parameters<typeof actual.countRoster>) => forced.total ?? actual.countRoster(...args),
  };
});

const database = useTestDb();
const ASOF = '2025-07-01';
const allow: Authorizer = () => true;

describe('P2-1 个人邮箱列 = BackupMail（规格 17 身份与基本信息）', () => {
  async function fixture(label: string) {
    const w = await rosterWorld(database().db, label);
    const dept = await w.org('邮箱部门');
    await w.hire('HG0001', '两个都填', '2025-01-01', dept, {
      email: 'main1@example.com',
      backupMail: 'backup1@example.com',
    });
    await w.hire('HG0002', '只填备用', '2025-01-01', dept, { backupMail: 'backup2@example.com' });
    await w.hire('HG0003', '只填主邮箱', '2025-01-01', dept, { email: 'main3@example.com' });
    return w;
  }

  it('email 与 backupMail 不同、只填 backupMail、只填 email 三种情况：名册输出的都是 backupMail', async () => {
    const w = await fixture('ha-r2-mail');
    const page = await w.rosterOk(ASOF);
    const byCode = (code: string) => page.items.find((item) => item.code === code)!;
    expect(byCode('HG0001')).toMatchObject({ backupMail: 'backup1@example.com' });
    expect(byCode('HG0002')).toMatchObject({ backupMail: 'backup2@example.com' });
    expect(byCode('HG0003')).toMatchObject({ backupMail: null });
    expect(page.columns.find((column) => column.label === '个人邮箱')?.key).toBe('backupMail');
    for (const item of page.items) expect(item).not.toHaveProperty('email');
    expect(JSON.stringify(page.items)).not.toContain('main1@example.com');
  });

  it('CSV 的“个人邮箱”列同样是 backupMail（主邮箱值不出现在该列）', async () => {
    const w = await fixture('ha-r2-mail-csv');
    const lines = parseCsv(stripBom(await (await w.exported(ASOF)).text()));
    const column = lines[0]!.indexOf('个人邮箱');
    expect(column).toBeGreaterThan(-1);
    const cell = (code: string) => lines.find((line) => line[1] === code)![column];
    expect(cell('HG0001')).toBe('backup1@example.com');
    expect(cell('HG0002')).toBe('backup2@example.com');
    expect(cell('HG0003')).toBe('');
    expect(lines.flat()).not.toContain('main1@example.com');
  });

  it('字段权随 backupMail：无 backupMail 查看权该列缺席；只无 email 查看权该列仍在', async () => {
    const w = await fixture('ha-r2-mail-fields');
    const noBackup = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['backupMail'] } });
    const hidden = await w.rosterOk(ASOF, '', noBackup);
    expect(hidden.columns.map((column) => column.label)).not.toContain('个人邮箱');
    for (const item of hidden.items) expect(item).not.toHaveProperty('backupMail');
    const noEmail = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['email'] } });
    const shown = await w.rosterOk(ASOF, '', noEmail);
    expect(shown.columns.map((column) => column.label)).toContain('个人邮箱');
    expect(shown.items.find((item) => item.code === 'HG0001')).toMatchObject({ backupMail: 'backup1@example.com' });
  });
});

describe('P2-2 导出超限：10000 行允许，10001 行 422', () => {
  it('总数 10000 → 200 CSV；10001 → 422 且不输出任何行，错误体机器可读；列表不受影响', async () => {
    const w = await rosterWorld(database().db, 'ha-r2-limit');
    const dept = await w.org('超限部门');
    await w.hire('HH0001', '限额内', '2025-01-01', dept);
    try {
      forced.total = 10_000;
      const ok = await w.exported(ASOF);
      expect(ok.status, await ok.clone().text()).toBe(200);
      expect(parseCsv(stripBom(await ok.text()))).toHaveLength(2);

      forced.total = 10_001;
      const over = await w.exported(ASOF);
      expect(over.status).toBe(422);
      expect(over.headers.get('content-type')).toContain('application/json');
      const body = (await over.json()) as { error: { code: string; details: { reason: string; limit: number } } };
      expect(body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'EXPORT_ROW_LIMIT', limit: 10_000 },
      });
      expect((await w.roster(ASOF)).status).toBe(200);
    } finally {
      forced.total = undefined;
    }
  });
});

describe('P2-3 非法日期（年份 0000 等）一律 400，不是 500', () => {
  it.each(['asOf', 'workDateFrom', 'workDateTo'])('%s=0000-01-01：列表与导出都是 400', async (name) => {
    const w = await rosterWorld(database().db, `ha-r2-date-${name}`);
    const asOf = name === 'asOf' ? '0000-01-01' : ASOF;
    const extra = name === 'asOf' ? '' : `${name}=0000-01-01`;
    const list = await w.roster(asOf, extra);
    expect(list.status, await list.clone().text()).toBe(400);
    const exported = await w.exported(asOf, extra);
    expect(exported.status, await exported.clone().text()).toBe(400);
    for (const bad of ['0000-12-31', '10000-01-01', '2025-13-01'])
      expect((await w.roster(name === 'asOf' ? bad : ASOF, name === 'asOf' ? '' : `${name}=${bad}`)).status, bad).toBe(
        400,
      );
  });
});
