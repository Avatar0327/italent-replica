import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_SRC,
  closureText,
  indexSources,
  scanRegistrations,
  type StaticRegistration,
} from './support/route-policy/scan.js';
import { missingCycleGuards } from './AC-EV-cycle-route-support.js';

describe('AC-EV-cycle-routes：评定写命令漏调检查', () => {
  it('从实际路由注册扫描，不以手工空列表代替；配置入口之外必须调用周期守卫', () => {
    const index = indexSources(path.join(API_SRC, 'modules/evaluation'));
    const routes = scanRegistrations(index);
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
      route('/api/tenant/evaluation/staff-evaluations/:id/edit', 'assertCycleActive(tx, ctx, cycle); save()'),
    ];
    expect(missingCycleGuards(routes, (r) => r.handlerText)).toHaveLength(5);
    expect(
      missingCycleGuards(
        [route('/api/tenant/evaluation/staff-evaluations', 'await assertCycleActive(tx, ctx, cycle); save()')],
        (r) => r.handlerText,
      ),
    ).toEqual([]);
  });
});
