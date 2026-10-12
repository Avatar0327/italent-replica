/** C1 / F-039：个人偏好与统计的源码闭包必须分别反映各自授权要求。 */
import { describe, expect, it } from 'vitest';
import { scanPrimitives } from './support/route-policy/primitives.js';
import {
  closureText,
  indexSources,
  matchRegistrations,
  moduleDirs,
  scanRegistrations,
} from './support/route-policy/scan.js';

const index = indexSources();
const registrations = scanRegistrations(index);
function facts(method: string, path: string) {
  const { module, dirs } = moduleDirs(path);
  const hits = matchRegistrations(registrations, method, path, dirs);
  expect(hits).toHaveLength(1);
  return scanPrimitives(
    {
      deep: hits.map((hit) => closureText(index, hit, 6)).join('\n'),
      near: hits.map((hit) => closureText(index, hit, 3)).join('\n'),
    },
    method,
    module,
    path,
  );
}

describe('AC-SC-map-route-policy 独立授权入口', () => {
  it('个人偏好源码不引入 computeStats 的按钮事实', () => {
    expect(facts('PUT', '/api/tenant/succession/maps/:kind/preferences').button ?? []).toEqual([]);
  });
  it('统计源码仍包含按钮校验与命令台账', () => {
    const observed = facts('POST', '/api/tenant/succession/maps/org/compute-stats');
    expect(observed.button).toContain('button()');
    expect(observed.command).toContain('runCommand / runWrite');
  });
});
