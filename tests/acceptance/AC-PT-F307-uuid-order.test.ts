import { describe, expect, it, vi } from 'vitest';
import { orderedEmployeePair } from './support/ordered-employee-pair.js';

const low = { employeeId: '00000000-0000-4000-8000-000000000001', userId: '合成账号甲' };
const high = { employeeId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', userId: '合成账号乙' };

describe('AC-PT-F307 UUID 顺序夹具不依赖随机重试', () => {
  for (const order of ['below', 'above'] as const) {
    for (const [first, second] of [
      [low, high],
      [high, low],
    ] as const) {
      it(`${order} / 首人 ${first === low ? '最小端' : '最大端'}：只补建一人，完整身份随角色分配`, async () => {
        const makePerson = vi.fn(async () => second);
        const pair = await orderedEmployeePair(first, makePerson, (person) => person.employeeId, order);
        expect(makePerson).toHaveBeenCalledTimes(1);
        expect(pair.worker).toBe(order === 'below' ? high : low);
        expect(pair.subordinate).toBe(order === 'below' ? low : high);
        expect(pair.subordinate.employeeId < pair.worker.employeeId).toBe(order === 'below');
      });
    }
  }
});
