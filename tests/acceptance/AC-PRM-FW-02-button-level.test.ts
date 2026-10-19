/** DEC-442①：共享按钮契约与领域目录一致；类型断言由 pnpm typecheck 执行。 */
import { createApp, routeManifest } from '@italent/api';
import type { Db } from '@italent/db';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { catalogButtonMismatches } from './support/route-policy/catalog-buttons.js';
import type { ButtonLevel, ButtonRef, ManifestRoute, TenantRouteDeps } from '@italent/api';
import { BUTTON_LEVELS, type ButtonLevel as DomainButtonLevel, EVALUATION_OBJECTS } from '@italent/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { button as requireButton } from '../../apps/api/src/modules/permission/module-route-access.js';
import { button, buttonOnly, FORBIDDEN } from '../../apps/api/src/route-policy/presets.js';
import { checkDiscovery, discoverRoute } from './support/route-policy/discovery.js';
import { createAuthorizerDouble } from './support/route-policy/double.js';
import { checkEvidence, currentRegistry, repoSource } from './support/route-policy/evidence.js';
import { declaredPerms } from './support/route-policy/perms.js';
import { mapRequest, permClaims } from './support/route-policy/request-perms.js';
import { checkRoute } from './support/route-policy/required.js';
import type { RequiredTable } from './support/route-policy/required/types.js';

const OBJECT = EVALUATION_OBJECTS.evaluationActivity.code;
const KEY = 'POST /api/tenant/fixture/publish';
const CTX = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  timezone: 'Asia/Shanghai',
  commandId: 'button-level-fixture',
  expectedRevision: 0,
  now: new Date('2026-10-11T00:00:00Z'),
};
const perm = (level: string) => `btn:${OBJECT}#publish@${level}`;
const route = (ref: ButtonRef): ManifestRoute => ({
  key: KEY,
  method: 'POST',
  path: '/api/tenant/fixture/publish',
  module: 'fixture',
  policy: buttonOnly(OBJECT, ref, FORBIDDEN),
});
const depsOf = (authorize: TenantRouteDeps['authorize']): TenantRouteDeps => ({
  authorize,
  clock: () => CTX.now,
  get db(): never {
    throw new Error('按钮校验夹具不应访问数据库');
  },
});
const obligation = (level: string) => ({ perm: perm(level), at: [] });

describe('AC-PRM-FW-02 / AC-PRM-FW-08 DEC-442① 按钮层级契约', () => {
  it('类型精确复用领域层级，非法层级不可传入声明或共享 helper', () => {
    expectTypeOf<ButtonLevel>().toEqualTypeOf<DomainButtonLevel>();
    expectTypeOf<Parameters<typeof button>[1]>().toEqualTypeOf<DomainButtonLevel>();
    expectTypeOf<Parameters<typeof requireButton>[4]>().toEqualTypeOf<DomainButtonLevel>();
    expectTypeOf<'list-row'>().not.toExtend<ButtonLevel>();
    expectTypeOf<'list-row'>().not.toExtend<Parameters<typeof requireButton>[4]>();
  });

  it.each(BUTTON_LEVELS)('%s：声明解析、必需项校验与发现探测保留精确层级', async (level) => {
    const ref = button('publish', level);
    const declared = route(ref);
    const table: RequiredTable = { [KEY]: [obligation(level)] };
    expect(declaredPerms(declared.policy).alternatives.map((alt) => [...alt.keys()])).toEqual([[perm(level)]]);
    expect(checkRoute(KEY, table[KEY]!, declared, undefined)).toEqual([]);
    const double = createAuthorizerDouble();
    const discovered = await discoverRoute(
      {
        double,
        sent: 0,
        send: async () => {
          await requireButton(depsOf(double.authorize), CTX, OBJECT, 'publish', level);
          return Response.json({ ok: true });
        },
      },
      declared,
      table,
    );
    expect(discovered).toEqual({ all: { status: 200 }, trace: [perm(level)], scopeQueries: [], fieldQueries: [] });
    expect(double.requests).toMatchObject([{ action: 'object.button', resource: `${OBJECT}#publish@${level}` }]);
    expect(checkDiscovery({ [KEY]: discovered }, table, [declared])).toEqual([]);

    const other = level === 'list_row' ? 'list' : 'list_row';
    expect(checkRoute(KEY, [obligation(other)], declared, undefined).map((f) => f.code)).toContain('REQUIRED_MISSING');
    expect(
      checkDiscovery({ [KEY]: discovered }, { [KEY]: [obligation(other)] }, [declared]).map((f) => f.code),
    ).toContain('PROBE_ADMISSION_UNCLAIMED');
    expect(permClaims(perm(other), perm(level))).toBe(false);
    double.configure({ grants: [perm(other)] });
    await expect(requireButton(depsOf(double.authorize), CTX, OBJECT, 'publish', level)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('静态与动态声明均保留 list_row，错误层级不满足行按钮义务', () => {
    const policy = buttonOnly(
      OBJECT,
      { from: 'body', path: 'action', map: { publish: button('publish', 'list_row'), open: button('open', 'detail') } },
      FORBIDDEN,
    );
    expect(declaredPerms(policy).alternatives.map((alt) => [...alt.keys()])).toEqual([
      [`btn:${OBJECT}#{open@detail,publish@list_row}`],
    ]);
    // @ts-expect-error DEC-442①：声明的层级必须来自领域目录。
    const invalid: ButtonRef = { code: 'publish', level: 'list-row' };
    expect(checkRoute(KEY, [obligation('list_row')], route(invalid), undefined).map((f) => f.code)).toContain(
      'REQUIRED_MISSING',
    );
  });

  it.each(['', 'row', 'list-row', 'LIST_ROW', 'list_row_extra', 'list_row@detail'])(
    '非法层级 %j：发现映射报 unmapped，授权替身拒绝',
    async (level) => {
      const request = { ...CTX, action: 'object.button', resource: `${OBJECT}#publish@${level}` };
      const mapped = mapRequest(request);
      expect(mapped.kind).toBe('unmapped');
      const double = createAuthorizerDouble({ grants: [perm(level)] });
      expect(await double.authorize(request)).toBe(false);
      const found = {
        all: { status: 403 },
        trace: [],
        scopeQueries: [],
        fieldQueries: [],
        unmapped: double.unmapped(),
      };
      expect(
        checkDiscovery({ [KEY]: found }, { [KEY]: [] }, [route(button('publish', 'list_row'))]).map((f) => f.code),
      ).toContain('PROBE_ACTION_UNMAPPED');
    },
  );

  it.each(['publish', 'unpublish'])('P0 的 %s 编码和 list_row 层级保持不变', async (code) => {
    expect(EVALUATION_OBJECTS.evaluationActivity.buttons.find((ref) => ref.code === code)).toEqual({
      code,
      level: 'list_row',
      requires: 'update',
    });
    const key = `btn:${OBJECT}#${code}@list_row`;
    const double = createAuthorizerDouble({ grants: [key] });
    await requireButton(depsOf(double.authorize), CTX, OBJECT, code, 'list_row');
    expect(double.permKeys()).toEqual([key]);
    double.revoke(key);
    await expect(requireButton(depsOf(double.authorize), CTX, OBJECT, code, 'list_row')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('list_row 调用证据和共享 helper 闭包可登记；层级被改坏后锚点与摘要校验报错', () => {
    const file = 'apps/api/src/modules/fixture/button-level.ts';
    const source = [
      "import { button } from '../permission/module-route-access.js';",
      'export async function publish(deps, ctx) {',
      `  await button(deps, ctx, '${OBJECT}', 'publish', 'list_row');`,
      '}',
    ].join('\n');
    const read = (path: string) => (path === file ? source : repoSource(path));
    const table: RequiredTable = {
      [KEY]: [
        { perm: perm('list_row'), at: [{ role: 'call', unit: `${file}#publish`, anchor: "'publish', 'list_row'" }] },
      ],
    };
    const registry = currentRegistry(table, read, false);
    expect(Object.keys(registry.nodes)).toContain('apps/api/src/modules/permission/module-route-access.ts#button');
    expect(checkEvidence(table, { read, registry, branch: false })).toEqual([]);
    const broken = (path: string) => read(path).replace("'list_row'", "'list-row'");
    expect(checkEvidence(table, { read: broken, registry, branch: false }).map((f) => f.code)).toEqual(
      expect.arrayContaining(['EVIDENCE_ANCHOR', 'EVIDENCE_STALE']),
    );
  });
});

// DEC-642：运行时、声明、冻结基准可以同时写错；另与真实按钮目录核对，不能以三者一致代替目录授权。
describe('DEC-642 策略按钮层级与真实目录一致', () => {
  it('全部已挂载路由（含动态按钮、逐行与可选分支）都按目录层级声明', () => {
    const routes = routeManifest(createApp({ db: {} as Db, authorize: async () => false })).declared;
    const findings = routes.flatMap((entry) => catalogButtonMismatches(entry.policy).map((f) => `${entry.key}: ${f}`));
    expect(findings).toEqual([]);
  });

  it('能判红 #447 的错位，正确的 list 声明通过', () => {
    const object = 'TenantBase.EmploymentRecord';
    const code = 'Employment.PartTimeBatchEnd';
    expect(objectCatalog.get(object)?.buttons.find((b) => b.code === code)?.level).toBe('list');
    expect(catalogButtonMismatches(buttonOnly(object, button(code, 'detail'), FORBIDDEN))).toEqual([
      `${object}#${code}: 声明 detail，目录 list`,
    ]);
    expect(catalogButtonMismatches(buttonOnly(object, button(code, 'list'), FORBIDDEN))).toEqual([]);
  });
});
