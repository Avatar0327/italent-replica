import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import type { SuccessionLevelRow } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_BASE, type SuccessionWorld } from './AC-SC-support.js';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';

import { commandHash } from '../../apps/api/src/commands.js';
import { levelSchemas } from '../../apps/api/src/modules/succession/levels-input.js';

const db = useHealthDb();
const combinations = ['org', 'review', 'succession'].flatMap((fieldSource) =>
  ['count', 'ratio'].map((measure) => ({ fieldSource, measure })),
);
const supported = {
  rowNo: 1,
  population: 'incumbents',
  fieldSource: 'org',
  fieldCode: null,
  measure: 'count',
  comparator: 'eq',
  threshold: 1,
} as const;
function snapshot(w: SuccessionWorld) {
  return w.asTenant(async (tx) => ({
    levels: rowsOf(await tx.execute(sql`SELECT * FROM succession_health_levels ORDER BY id`)),
    rules: rowsOf(await tx.execute(sql`SELECT * FROM succession_health_level_rows ORDER BY id`)),
    settings: rowsOf(await tx.execute(sql`SELECT * FROM succession_rule_settings WHERE kind='org_health'`)),
  }));
}
describe('AC-SC-07 DEC-460 L2 保存边界', () => {
  it.each(combinations)(
    '$fieldSource × $measure：创建 / 更新拒绝，数据库保持原样',
    async (test) => {
      const w = await successionWorld(db().db, 'health-l2-save');
      const good = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'SUPPORTED',
          name: '负责人人口计数',
          color: '#336699',
          rules: { expression: '1', rows: [supported] },
        },
      });
      expect(good.status).toBe(201);
      const level = await good.json();
      const unsupported = { ...supported, ...test, population: 'all' };
      // 无字段既可能显式为 null，也可能由服务端默认值补齐；未引用行不能成为保存旁路。
      const { fieldCode: _fieldCode, ...omitted } = unsupported;
      const bodies = [
        { code: 'REJECTED', name: '不支持的全部人口', color: '#669933', rules: { expression: '1', rows: [omitted] } },
        { name: '不应改名', rules: { expression: '1', rows: [supported, { ...unsupported, rowNo: 2 }] } },
      ];
      for (const [index, body] of bodies.entries()) {
        const before = await snapshot(w);
        const response = await w.request(
          index === 0 ? 'POST' : 'PUT',
          index === 0 ? '/health-levels' : `/health-levels/${level.id}`,
          {
            ifMatch: index === 0 ? 0 : level.revision,
            body,
          },
        );
        expect(response.status, await response.clone().text()).toBe(400);
        const payload = await response.json();
        expect(payload).toMatchObject({
          error: {
            code: 'VALIDATION_FAILED',
            details: { reason: 'HEALTH_RULE_COMBINATION_UNSUPPORTED', rowNo: index + 1 },
          },
        });
        expect(payload.error.message).toContain('暂不支持');
        expect(await snapshot(w)).toEqual(before);
      }
    },
    120_000,
  );

  it('已存在禁用行原样保存也拒绝，不能被无变化优化绕过；清空规则仍可修复', async () => {
    const w = await successionWorld(db().db, 'health-l2-noop');
    const created = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        code: 'LEGACY',
        name: '旧配置',
        color: '#336699',
        rules: { expression: '1', rows: [supported] },
      },
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    await w.asTenant(async (tx) => {
      await tx.execute(sql`UPDATE succession_health_level_rows SET population='all'
        WHERE level_id=${id}::uuid`);
    });
    const current = await (await w.request('GET', `/health-levels/${id}`)).json();
    const before = await snapshot(w);
    const response = await w.request('PUT', `/health-levels/${id}`, {
      ifMatch: current.revision,
      body: { rules: current.rules },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.details.reason).toBe('HEALTH_RULE_COMBINATION_UNSUPPORTED');
    expect(await snapshot(w)).toEqual(before);
    const cleared = await w.request('PUT', `/health-levels/${id}`, {
      ifMatch: current.revision,
      body: { rules: null },
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).rules).toBeNull();
  }, 120_000);

  it.each(['POST', 'PUT'] as const)(
    '%s 旧成功台账重放也拒绝禁用组合',
    async (method) => {
      const w = await successionWorld(db().db, 'health-l2-replay');
      const created = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: 'LEGACY',
          name: '旧台账等级',
          color: '#336699',
          rules: { expression: '1', rows: [supported] },
        },
      });
      expect(created.status).toBe(201);
      const { id } = await created.json();
      const rules = { expression: '1', rows: [{ ...supported, population: 'all' }] };
      const create = method === 'POST';
      const body = create
        ? levelSchemas('health').create.parse({ code: 'LEGACY', name: '旧台账等级', color: '#336699', rules })
        : levelSchemas('health').patch.parse({ rules });
      const path = create ? '/health-levels' : `/health-levels/${id}`;
      const expectedRevision = create ? 0 : 1;
      const commandId = randomUUID();
      const hash = commandHash(w.user.id, {
        method,
        path: `${SC_BASE}${path}`,
        expectedRevision,
        input: create ? body : { id, body },
      });
      // 直接准备旧版本留下的合法成功台账；不在测试里绕过当前业务 guard 制造“成功”。
      await w.asTenant(async (tx) => {
        await tx.execute(sql`UPDATE succession_health_level_rows SET population='all' WHERE level_id=${id}::uuid`);
        await tx.execute(sql`INSERT INTO command_ledger
        (tenant_id,command_id,request_hash,response_status,response_body)
        VALUES (${w.tenant.id}::uuid,${commandId},${hash},${create ? 201 : 200},
          ${JSON.stringify({ kind: 'record', ids: [id], commandId })}::jsonb)`);
      });
      const before = await snapshot(w);
      const response = await w.request(method, path, { ifMatch: expectedRevision, idempotencyKey: commandId, body });
      expect(response.status).toBe(400);
      expect((await response.json()).error.details.reason).toBe('HEALTH_RULE_COMBINATION_UNSUPPORTED');
      expect(await snapshot(w)).toEqual(before);
    },
    120_000,
  );

  it('已支持的负责人取值 / 人口 / 分母组合继续接受', async () => {
    const w = await successionWorld(db().db, 'health-l2-supported');
    const rows: Partial<SuccessionLevelRow>[] = [
      { ...supported, population: 'all', fieldCode: 'person_in_charge_id' },
      { ...supported, measure: 'ratio' },
      { ...supported, population: 'all', fieldSource: 'review', measure: 'count_over_incumbents' },
    ];
    for (const [index, row] of rows.entries()) {
      const response = await w.request('POST', '/health-levels', {
        ifMatch: 0,
        body: {
          code: `SUPPORTED_${index}`,
          name: `已支持组合${index}`,
          color: '#336699',
          rules: { expression: '1', rows: [row] },
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
    }
  }, 120_000);
});
