// .only 会让同文件其他用例被标为 skip，统计失真：应列为问题。
import { it } from 'vitest';

it.only('AC-DEMO-01 只跑这条', () => {});
it('同文件的其他用例', () => {});
