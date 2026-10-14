import path from 'node:path';
import type { Db } from '@italent/db';
import { createApp, routeManifest } from '@italent/api';
import { describe, expect, it } from 'vitest';
import {
  API_SRC,
  closureText,
  indexSources,
  scanRegistrations,
  matchRegistrations,
  type StaticRegistration,
} from './support/route-policy/scan.js';
import { missingCycleGuards } from './AC-EV-cycle-route-support.js';

describe('AC-EV-cycle-routes：评定写命令漏调检查', () => {
  it('从实际路由注册扫描，不以手工空列表代替；配置入口之外必须调用周期守卫', () => {
    const index = indexSources(path.join(API_SRC, 'modules/evaluation'));
    const registrations = scanRegistrations(index);
    // 只装配真实路由，不发送请求；若装配误做 IO，空 DB 会立即报错。
    const manifest = routeManifest(createApp({ db: {} as Db })).declared.filter((route) =>
      route.path.startsWith('/api/tenant/evaluation/'),
    );
    const routes = manifest.flatMap((route) => {
      const hits = matchRegistrations(registrations, route.method, route.key.slice(route.method.length + 1));
      expect(hits.length, route.key).toBeGreaterThan(0);
      return hits.map((hit) => ({ ...hit, exactPath: route.path, methods: [route.method] }));
    });
    expect(routes.length).toBeGreaterThan(0);
    expect(missingCycleGuards(routes, (route) => closureText(index, route))).toEqual([]);
  });
  it('遗漏守卫、只有名称 / 未等待、未知路径和活动下新增提名都判红，真正调用通过', () => {
    const route = (exactPath: string | null, handlerText: string): StaticRegistration => ({
      file: '',
      line: 1,
      methods: ['POST'],
      exactPath,
      pattern: null,
      wildcards: 0,
      handlerText,
      extraRoots: [],
    });
    const routes = [
      route('/api/tenant/evaluation/staff-evaluations/:id/score', 'save()'),
      route('/api/tenant/evaluation/staff-evaluations/:id/submit', 'assertCycleActive; save()'),
      route('/api/tenant/evaluation/activities/:id/nominate', 'save()'),
      route(null, 'save()'),
      route('/api/tenant/evaluation/comment-only', '// await assertCycleActive(tx, ctx, cycle);\nsave()'),
      route('/api/tenant/evaluation/string-only', '"await assertCycleActive(tx, ctx, cycle)"; save()'),
      route('/api/tenant/evaluation/staff-evaluations/:id/edit', 'assertCycleActive(tx, ctx, cycle); save()'),
    ];
    expect(missingCycleGuards(routes, (r) => r.handlerText)).toHaveLength(7);
    expect(
      missingCycleGuards(
        [route('/api/tenant/evaluation/staff-evaluations', 'await assertCycleActive(tx, ctx, cycle); save()')],
        (r) => r.handlerText,
      ),
    ).toEqual([]);
  });
});
