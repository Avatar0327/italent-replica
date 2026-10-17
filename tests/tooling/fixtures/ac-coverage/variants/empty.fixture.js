// 空参数表与从未执行的回调不注册用例（#91 第 5 轮 P2-6、P2-7）。
import { describe, it } from 'vitest';

const fn = () => {};

it.each([])('AC-DEMO-50', fn);
describe.each([])('AC-DEMO-51', () => it('child', fn));
function ignore(_cb) {}
ignore(() => it('AC-DEMO-52', fn));
[].forEach(() => it('AC-DEMO-53', fn));
it('empty 控制用例', fn);
