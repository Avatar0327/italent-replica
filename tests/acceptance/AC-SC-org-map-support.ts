/** C2 真实权限夹具：Map / Record / HealthResult 各自授权，不用 allowAll 验证裁剪。 */
import { expect } from 'vitest';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { setObjectPermission, BASE } from './AC-PRM-support.js';
import { permissionWorldOf, recordOperator, type OperatorOptions } from './AC-SC-permission-support.js';
import type { SuccessionWorld, RecordView } from './AC-SC-support.js';

export interface MapCard {
  id: string;
  name: string;
  parentId: string | null;
  personInCharge?: { employeeId: string; label: string } | null;
  incumbents?: { employeeId: string; label: string }[];
  successors?: RecordView[];
  successorCount?: number;
  keyPositions?: MapCard[];
  health?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  stats?: { onDutyCount: number | null; greenRate: number | null; capacity: string; statDate: string };
}
export interface OrgMap {
  asOf: string;
  rootId: string | null;
  depth: number;
  hasDataPermission: boolean;
  items: MapCard[];
}
export const queryOf = (input: Record<string, unknown>) =>
  `?${new URLSearchParams(
    Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)]),
  )}`;
export async function mapView(w: SuccessionWorld, input: Record<string, unknown>) {
  const response = await w.request('GET', `/maps/org${queryOf(input)}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as OrgMap;
}
const permissionWorlds = new WeakMap<SuccessionWorld, ReturnType<typeof permissionWorldOf>>();
export async function mapOperator(
  w: SuccessionWorld,
  options: OperatorOptions & {
    mapHidden?: string[];
    health?: boolean;
    healthHidden?: string[];
    risk?: boolean;
    riskHidden?: string[];
  } = {},
) {
  if (!permissionWorlds.has(w)) permissionWorlds.set(w, permissionWorldOf(w));
  const world = await permissionWorlds.get(w)!;
  const viewer = await recordOperator(world, options);
  const scoped = new Set<string>();
  async function permit(kind: 'map' | 'healthResult' | 'riskResult', hidden: readonly string[] = []) {
    const object = SUCCESSION_OBJECTS[kind];
    const response = await setObjectPermission(
      world,
      viewer.profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        buttons: [],
        fields: object.fields.map((f) => ({ fieldCode: f.code, view: !hidden.includes(f.code), edit: false })),
      },
      object.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    if (options.seeAll && !scoped.has(kind)) {
      const scope = await world.api.request(
        'PUT',
        `${BASE}/profiles/${viewer.profile.id}/data-scopes/SuccessionAndDevelopment`,
        { ...world.asAdmin, ifMatch: 0, body: { targetKind: 'entity', targetCode: object.code, seeAll: true } },
      );
      expect(scope.status, await scope.clone().text()).toBe(200);
      scoped.add(kind);
    }
  }
  await permit('map', options.mapHidden);
  if (options.health) await permit('healthResult', options.healthHidden);
  if (options.risk) await permit('riskResult', options.riskHidden);
  const read = async (input: Record<string, unknown>) => {
    const response = await viewer.request('GET', `/maps/org${queryOf(input)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OrgMap;
  };
  return { ...viewer, world, permit, read };
}
export async function mapSetting(w: SuccessionWorld, key: string, value: boolean | number) {
  const current = await w.call('GET', `settings/succession.${key}`);
  const { revision } = (await current.json()) as { revision: number };
  const response = await w.call('PUT', `settings/succession.${key}`, { ifMatch: revision, body: { value } });
  expect(response.status, await response.clone().text()).toBe(200);
}
