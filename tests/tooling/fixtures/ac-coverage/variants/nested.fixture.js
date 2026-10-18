// 多层 skip / todo：叶子自身是 run，但任一祖先 suite 为 skip / todo 时用例不执行（#102 第 1 轮 P2-1）。
import { describe, it } from 'vitest';

const fn = () => {
  throw new Error('夹具：被跳过的用例不应执行');
};

describe.skip('外层 skip', () => describe.skip('内层 skip', () => it('AC-DEMO-110 skip→skip', fn)));
describe.skip('外层 skip', () => describe.todo('内层 todo', () => it('AC-DEMO-111 skip→todo', fn)));
describe.todo('外层 todo', () => describe.skip('内层 skip', () => it('AC-DEMO-112 todo→skip', fn)));
describe.todo('外层 todo', () => describe.todo('内层 todo', () => it('AC-DEMO-113 todo→todo', fn)));
describe.skip('外层 skip', () => describe('内层普通', () => it('AC-DEMO-114 skip→run', fn)));
describe('外层普通', () => describe('内层普通', () => it('AC-DEMO-115 普通嵌套', () => {})));
