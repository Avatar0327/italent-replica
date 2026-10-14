import { expect } from 'vitest';
import { KNOWN_GAPS } from '../probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS } from '../probe-redundant.js';
import { registration, registrationGate } from '../registration.js';
import { type Obligation, type RequiredTable } from '../required/types.js';
import { type ManifestRoute } from '@italent/api';
import { declaredPerms } from '../perms.js';
import { GUARD_INNER_ALTS } from '../required/guard-inner.js';
import { checkStored } from '../evidence.js';
import { type Finding } from '../compare.js';
import { checkRequired } from '../required.js';
import { expectDeclared, knownGapPairIds } from '../module-declared.js';
import type { LocalCheckContext } from './types.js';

// F-095：原局部用例与入口专项共用实际断言；登记副本从 context.table 注入。
export function survey360Checks(context: LocalCheckContext) {
  const REQUIRED = context.table;
  const manifest = { declared: context.routes };
  const frozen = context.contract;

  const BASE = '/api/tenant/survey360';
  const VIEW = 'obj:Survey360.Activity:view';
  const VIEW_ALL = 'btn:Survey360.Activity#viewAll@list';
  const route = (key: string): ManifestRoute => {
    const found = manifest.declared.find((r) => `${r.method} ${r.path}` === key);
    if (!found) throw new Error(`没有声明 ${key}`);
    return found;
  };
  const show = (findings: readonly Finding[]) => findings.map((f) => `${f.route} ${f.code}: ${f.detail}`).join('\n');
  const entry = (key: string): readonly Obligation[] => REQUIRED[key] ?? [];
  const inners = (key: string, carrier: string) => entry(key).filter((o) => o.purpose === `guard:${carrier}`);
  const ACTIVITY_ENDPOINTS = () =>
    manifest.declared
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => k.split(' ')[1]!.startsWith(`${BASE}/activities/:id`))
      .sort();
  const PEOPLE_ALL_CARRIERS = [
    'survey360.personVisible',
    'survey360.unrestricted',
    'survey360.personCreatable',
  ] as const;
  const PEOPLE_ALL_ANCHOR = 'return { userId: tenant.userId, allActivities, people: scope.all ? null : scope };';
  return [
    {
      id: 'knownGaps',
      label:
        '账本里不再有 survey360 组；其余模块的缺口对与各自声明逐项相等（任职资格由 F-074 补完）；冗余观测账本已清空（F-075 / F-075b）',
      wrapped: true,
      verify: () => {
        expect(KNOWN_GAPS.filter((g) => g.id.startsWith('survey360'))).toEqual([]);
        expectDeclared('已知缺口登记对', 'knownGapPairs', knownGapPairIds());
        expect(REDUNDANT_OBSERVATIONS.flatMap((g) => g.pairs)).toHaveLength(0);
      },
    },
    {
      id: 'activityCarrier',
      label:
        '端点集合：38 个（F-073 的 36 个 + F-060 两个下载），全部有承载者 guard:survey360.activityScope（声明与表一致）',
      wrapped: false,
      verify: () => {
        const endpoints = ACTIVITY_ENDPOINTS();
        expect(endpoints).toHaveLength(38);
        registration('survey360 静态登记', () => {
          for (const key of endpoints) {
            expect(
              entry(key).some((o) => o.perm === 'guard:survey360.activityScope' && !o.purpose),
              key,
            ).toBe(true);
            expect(JSON.stringify(route(key).policy), key).toContain('survey360.activityScope');
          }
        });
      },
    },
    {
      id: 'activityAlternatives',
      label: 'allActivities 的两个请求登记为守卫内部“或”备选（不整体 optional）：obj 查看 + 全部活动按钮',
      wrapped: true,
      verify: () => {
        for (const key of ACTIVITY_ENDPOINTS()) {
          const found = inners(key, 'survey360.activityScope');
          expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
          for (const o of found) {
            expect(o.inner, `${key} ${o.perm}`).toEqual({ role: 'or', group: 'activityVisible', alt: 'allActivities' });
          }
          expect(declaredPerms(route(key).policy).optional.has('allActivities'), `${key} 不得整体 optional`).toBe(
            false,
          );
        }
      },
    },
    {
      id: 'alternativeEvidence',
      label: 'GUARD_INNER_ALTS 登记两支：allActivities（权限，含两个键）与 本人创建 / 被授权（数据态，不经授权器）',
      wrapped: false,
      verify: () => {
        registration('survey360 静态登记', () => {
          const registered = GUARD_INNER_ALTS['survey360.activityScope'];
          expect(registered?.group).toBe('activityVisible');
          expect(registered?.alts['allActivities']).toEqual([VIEW, VIEW_ALL]);
          expect(registered?.alts['ownerOrGranted']).toBe('data:survey360.activityOwnerOrGrant');
        });
        const synthetic: RequiredTable = Object.fromEntries(
          Object.entries(GUARD_INNER_ALTS).map(([carrier, one]) => [
            `inner ${carrier}`,
            [{ perm: `guard:${carrier}`, at: one.at }],
          ]),
        );
        const found = registrationGate(checkStored(synthetic), '360 守卫内部备选证据');
        expect(found, show(found)).toEqual([]);
      },
    },
    {
      id: 'personVisible',
      label:
        '人员资源守卫：GET / PUT /people/:id → personVisible，内部“或”：全部活动 / 精细化关闭 / 人员数据范围为全部 / 人员在范围内',
      wrapped: false,
      verify: () => {
        registration('survey360 静态登记', () => {
          for (const key of [`GET ${BASE}/people/:id`, `PUT ${BASE}/people/:id`]) {
            const found = inners(key, 'survey360.personVisible');
            expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
            for (const o of found)
              expect(o.inner).toEqual({ role: 'or', group: 'personVisible', alt: 'allActivities' });
          }
          const registered = GUARD_INNER_ALTS['survey360.personVisible'];
          expect(Object.keys(registered?.alts ?? {}).sort()).toEqual([
            'allActivities',
            'finePermissionOff',
            'personInScope',
            'personScopeAll',
          ]);
        });
      },
    },
    {
      id: 'unrestricted',
      label:
        '精细化条件守卫：关联日志 / 同步冲突清单 / 冲突处理 → unrestricted；新建人员 → personCreatable（全部活动 / 精细化关闭 / 人员数据范围为全部）',
      wrapped: true,
      verify: () => {
        for (const key of [
          `GET ${BASE}/people/:id/link-logs`,
          `GET ${BASE}/people/sync-conflicts`,
          `POST ${BASE}/people/sync-conflicts/:id/resolve`,
        ]) {
          const found = inners(key, 'survey360.unrestricted');
          expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
          for (const o of found) expect(o.inner).toEqual({ role: 'or', group: 'unrestricted', alt: 'allActivities' });
        }
        const created = inners(`POST ${BASE}/people`, 'survey360.personCreatable');
        expect(created.map((o) => o.perm).sort()).toEqual([VIEW_ALL, VIEW].sort());
        for (const carrier of ['survey360.unrestricted', 'survey360.personCreatable']) {
          expect(Object.keys(GUARD_INNER_ALTS[carrier]?.alts ?? {}).sort(), carrier).toEqual([
            'allActivities',
            'finePermissionOff',
            'personScopeAll',
          ]);
        }
      },
    },
    {
      id: 'listDisclosure',
      label:
        '列表 / 写范围披露：GET /activities、GET /people、POST /people/sync → disclosure:allActivities（两个键，need none）',
      wrapped: true,
      verify: () => {
        for (const key of [`GET ${BASE}/activities`, `GET ${BASE}/people`, `POST ${BASE}/people/sync`]) {
          const found = entry(key).filter((o) => o.purpose === 'disclosure:allActivities');
          expect(found.map((o) => o.perm).sort(), key).toEqual([VIEW_ALL, VIEW].sort());
          for (const o of found) expect(o.need, `${key} ${o.perm}`).toEqual({ scope: 'none' });
          expect(declaredPerms(route(key).policy).optional.has('allActivities'), key).toBe(true);
        }
      },
    },
    {
      id: 'declarations',
      label: '真实声明 × 真实表零发现',
      wrapped: false,
      verify: () => {
        const survey = manifest.declared.filter((r) => r.path.startsWith(BASE));
        expect(survey.length).toBeGreaterThan(40);
        const findings = registrationGate(
          checkRequired(REQUIRED, frozen, survey),
          '360 声明 × 静态义务登记（DEC-416③）',
        );
        expect(findings, show(findings)).toEqual([]);
      },
    },
    {
      id: 'personScopeAll',
      label:
        'GUARD_INNER_ALTS 三个守卫都登记 personScopeAll（数据态，不经授权器），证据指向 loadAdmin 的 scope.all 分支',
      wrapped: true,
      verify: () => {
        for (const carrier of PEOPLE_ALL_CARRIERS) {
          const registered = GUARD_INNER_ALTS[carrier];
          expect(registered?.alts['personScopeAll'], carrier).toBe('data:survey360.personScopeAll');
          expect(
            registered?.at.some((e) => e.unit.endsWith('context.ts#loadAdmin') && e.anchor === PEOPLE_ALL_ANCHOR),
            `${carrier} 登记证据`,
          ).toBe(true);
        }
      },
    },
    {
      id: 'scopeEvidence',
      label:
        '表里这三个守卫的内部义务（allActivities 的两个授权请求）也带 scope.all 证据（人员可见 / 受限管理员 403 / 新建人员）',
      wrapped: true,
      verify: () => {
        const keys = [
          `GET ${BASE}/people/:id`,
          `PUT ${BASE}/people/:id`,
          `GET ${BASE}/people/:id/link-logs`,
          `GET ${BASE}/people/sync-conflicts`,
          `POST ${BASE}/people`,
        ];
        for (const key of keys) {
          const found = entry(key).filter((o) => PEOPLE_ALL_CARRIERS.some((c) => o.purpose === `guard:${c}`));
          expect(found.length, key).toBeGreaterThan(0);
          for (const o of found) {
            expect(
              o.at.some((e) => e.unit.endsWith('context.ts#loadAdmin') && e.anchor === PEOPLE_ALL_ANCHOR),
              `${key} ${o.perm}`,
            ).toBe(true);
          }
        }
      },
    },
  ];
}
