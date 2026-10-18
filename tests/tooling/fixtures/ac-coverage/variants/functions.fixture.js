// 用例函数的各种引用方式：是否注册只由运行时决定（#91 第 5 轮 P2-5）。
import { it, test } from 'vitest';

const fn = () => {};

it.concurrent('AC-DEMO-30', fn);
const check = it.concurrent;
check('AC-DEMO-31', fn);
it.concurrent.each(['AC-DEMO-32'])('%s', fn);
test.describe('AC-DEMO-33 suite', () => it('child', fn));
test.suite('AC-DEMO-34 suite', () => it('child', fn));
const object = { check: it };
object.check('AC-DEMO-35', fn);
const vt = await import('vitest');
vt.it('AC-DEMO-36', fn);
const register = (cb) => cb('AC-DEMO-37', fn);
register(it.concurrent);
const skipper = it.skip;
skipper('AC-DEMO-38', fn);
