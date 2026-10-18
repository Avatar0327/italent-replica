// 对照组：身份稳定（每档都注册、且同一档内“文件 + 名称路径 + 位置”唯一）的用例正常跨档合并。
// 夹具 14：被导入的 helper 在不同调用行注册同名用例，Vitest 记录的位置是调用行，身份可区分。
import { it } from 'vitest';
import { marker } from '../marker.js';
import { register } from './register.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

it.runIf(pg)('AC-ID-20 仅真 PG', () => mark('20'));
it('AC-ID-21 两档都跑', () => mark('21'));
register(mark, 'AC-ID-22 helper 同名用例', '22-first'); // @call-first
register(mark, 'AC-ID-22 helper 同名用例', '22-second'); // @call-second
