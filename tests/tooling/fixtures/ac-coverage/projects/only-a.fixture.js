// 对照：只属于 project A 的文件。多 project 配置本身照常统计，只有同一文件被多个 project 收集才报错。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);

it('AC-PJ-01 只在 project A', () => mark(process.env.AC_FIXTURE_PROJECT));
