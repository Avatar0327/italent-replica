/**
 * F-400 第 2 轮（DEC-725）：新增兼职（part_time_add）固定终止，不可取消勾选。
 * 两层配置写入口拒绝 false（400 SETTING_VALUE_INVALID）；绕过写入口直接在库里存 false，离职生效时仍终止在途新增兼职申请。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import { EXIT_TERMINATION_KEY } from './support/exit-termination.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const SETTING = `/api/tenant/settings/${EXIT_TERMINATION_KEY}`;

describe('F-400 r2 新增兼职固定终止', () => {
  it('PUT part_time_add=false → 400 SETTING_VALUE_INVALID，配置不变', async () => {
    const w = await requestWorld(database().db, `f400r2-fixed-put-${uniqueSuffix()}`);
    const current = await w.json<{ value: Record<string, boolean>; revision: number }>(
      await w.request(w.hr.id, 'GET', SETTING),
    );
    const rejected = await w.request(w.hr.id, 'PUT', SETTING, {
      ifMatch: current.revision,
      body: { value: { ...current.value, part_time_add: false } },
    });
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { details: { reason: 'SETTING_VALUE_INVALID' } } });
    const after = await w.json<{ value: Record<string, boolean> }>(await w.request(w.hr.id, 'GET', SETTING));
    expect(after.value.part_time_add).toBe(true);
  });

  it('库里直接存了 false：离职生效时仍作废在途新增兼职申请', async () => {
    const w = await requestWorld(database().db, `f400r2-fixed-db-${uniqueSuffix()}`);
    const value = JSON.stringify({ part_time_add: false });
    await w.run((tx) =>
      tx.execute(sql`INSERT INTO tenant_setting_overrides (tenant_id, key, value, updated_by, updated_at)
        VALUES (${w.tenant.id}, ${EXIT_TERMINATION_KEY}, ${value}::jsonb, ${w.hr.id}, now())`),
    );
    const reviewing = await w.create({ startDate: '2026-09-02' });
    await w.send(reviewing.id, 1);
    await w.leave('2026-09-15');
    expect((await w.states(reviewing.id)).at(-1)).toMatchObject({ state: 'voided', reason: 'exit' });
  });
});
