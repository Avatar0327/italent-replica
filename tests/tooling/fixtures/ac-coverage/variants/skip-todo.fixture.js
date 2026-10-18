// skip / todo 的各种写法（#91 第 5 轮 P2-8）。
import { it } from 'vitest';

const fn = () => {};

it.skip('AC-DEMO-40', fn);
it.todo('AC-DEMO-41');
it('AC-DEMO-42');
it('AC-DEMO-43', { skip: true }, fn);
it('AC-DEMO-44', { todo: true }, fn);
it.skipIf(true)('AC-DEMO-45', fn);
it('AC-DEMO-46 运行', fn);
it.skip('AC-DEMO-46 跳过', fn);
