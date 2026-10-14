/**
 * F-141 字典新建（DEC-500）：预置的评定管理员（人才评定）带活动类型 / 活动周期 / 通用评分项三个字典的“看全部”，
 * 开箱就能在评定向导里新建这些字典；其他身份不预置。dictionary-service 的新建条件不变——新建只认看全部，
 * 只有管理单元（组织）范围、没有看全部的人仍然新建不了（与不存在同一个 404）。
 */
import { randomUUID } from 'node:crypto';
import { EVALUATION_OBJECTS, presetSeeAllTargets, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { operator } from './AC-EV-support.js';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { provisionWorld } from './support/f061.js';
import { holderOfProfile } from './support/ql-presets.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const EV_ADMIN = 'standard_evaluation_admin';
const BASE = '/api/tenant/evaluation';
const DICTIONARIES = [
  ['activity-types', EVALUATION_OBJECTS.activityType.code],
  ['activity-cycles', EVALUATION_OBJECTS.activityCycle.code],
  ['general-score-items', EVALUATION_OBJECTS.generalScoreItem.code],
] as const;

describe('AC-F141-dictionary-see-all 评定管理员预置字典看全部（DEC-500）', () => {
  it('预置清单：只有评定管理员有这三个字典的看全部，其他标准身份都没有', () => {
    const targets = (code: string) =>
      presetSeeAllTargets(STANDARD_PROFILES.find((p) => p.code === code)!)
        .filter((t) => t.appCode === 'TEvaluation')
        .map((t) => t.targetCode)
        .sort();
    expect(targets(EV_ADMIN)).toEqual(DICTIONARIES.map(([, code]) => code).sort());
    for (const profile of STANDARD_PROFILES.filter((p) => p.code !== EV_ADMIN))
      expect(targets(profile.code), profile.code).toEqual([]);
  });

  it('新开通租户里，被授予评定管理员的人开箱就能新建三个字典', async () => {
    const w = await provisionWorld(testDb().db, 'f141-dict-open');
    const holder = await holderOfProfile(w, EV_ADMIN, 'f141-ev-admin');
    for (const [path] of DICTIONARIES) {
      const res = await w.api.request('POST', `${BASE}/${path}`, {
        ...holder,
        ifMatch: 0,
        body: { name: `字典${randomUUID()}` },
      });
      expect(res.status, `${path}: ${await res.clone().text()}`).toBe(201);
    }
  });

  it('评定专员不预置：有流程对象权限，但新建字典拿不到看全部', async () => {
    const w = await provisionWorld(testDb().db, 'f141-dict-specialist');
    const holder = await holderOfProfile(w, 'standard_evaluation_specialist', 'f141-ev-specialist');
    const res = await w.api.request('POST', `${BASE}/activity-types`, {
      ...holder,
      ifMatch: 0,
      body: { name: `字典${randomUUID()}` },
    });
    expect([403, 404]).toContain(res.status);
  });

  it('仅管理单元范围的管理员（有字典新建权限但没有看全部）仍新建不了：404', async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    const world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined }) };
    const scoped = await operator(world, { seeAll: false });
    for (const [path] of DICTIONARIES) {
      const res = await scoped.request('POST', `/${path}`, { ifMatch: 0, body: { name: `字典${randomUUID()}` } });
      expect(res.status, path).toBe(404);
    }
    const full = await operator(world, { seeAll: true });
    expect((await full.request('POST', '/activity-types', { ifMatch: 0, body: { name: `字典${randomUUID()}` } })).status).toBe(201);
  });
});
