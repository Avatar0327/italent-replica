// 人工映射歧义：标题层级拼接后相同、或只写末级同名标题时不能任选一个用例当证据（#102 第 1 轮 P2-4）。
import { describe, it } from 'vitest';

const fn = () => {};

describe('intended > path', () => it.skip('leaf', fn));
describe('intended', () => it('path > leaf', fn));
describe('甲', () => it('同名末级', fn));
describe('乙', () => it('同名末级', fn));
