import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { configWorld } from './AC-SC-config-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export const levelKinds = ['risk', 'health'] as const;
export type LevelKind = (typeof levelKinds)[number];
export const levelBody = (kind: LevelKind, populationId?: string) => ({
  code: randomUUID(),
  name: randomUUID(),
  color: '#aAbBcC',
  description: '合成等级',
  enabled: true,
  rules: {
    expression: '1',
    rows: [
      {
        rowNo: 1,
        fieldCode: kind === 'risk' ? 'age' : 'readiness_code',
        filterOperator: 'eq',
        filterValues: kind === 'risk' ? [30] : ['READY'],
        measure: kind === 'risk' ? 'count_over_incumbents' : 'successor_count',
        comparator: 'ge',
        threshold: 0.3,
        thresholdHigh: null,
        isPercent: true,
        ...(kind === 'risk'
          ? { subject: 'incumbent' }
          : {
              population: populationId ? 'custom' : 'all',
              populationId: populationId ?? null,
              fieldSource: 'succession',
            }),
      },
    ],
  },
});
export interface Level {
  id: string;
  code: string;
  name: string;
  color: string;
  revision: number;
  displayOrder: number;
  rules: ReturnType<typeof levelBody>['rules'] | null;
}
export async function levelsWorld(db: Db) {
  const w = await configWorld(db);
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    w.request(method, path, { ...(method === 'POST' ? { ifMatch: 0 } : {}), ...options });
  const createLevel = async (kind: LevelKind, body: unknown = levelBody(kind)) => {
    const response = await request('POST', `/${kind}-levels`, { body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Level;
  };
  const list = async (kind: LevelKind) => {
    const response = await request('GET', `/${kind}-levels`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: Level[]; total: number; collectionRevision: number };
  };
  return { ...w, request, createLevel, list };
}
