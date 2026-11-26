import { WELCOME_VARIABLES, type HandbookBlock, type WelcomeVariable } from '@italent/db';
import { z } from 'zod';
import { AppError } from '../../errors.js';

/** R2-T01 §9.2：预览只用管理员提供的合成样例做纯渲染，转义后输出，不读真实员工，不写任何数据。 */
// 先识别完整的双花括号占位（内容不限字符），再按白名单判名称；若先按字符集筛，{{employee_name}} 会漏过白名单。
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const WHITELIST: ReadonlySet<string> = new Set(WELCOME_VARIABLES);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 抽取文本中的变量；白名单外的变量保存时即拒绝，避免模板带入未登记的数据。 */
export function usedVariables(...texts: readonly string[]): WelcomeVariable[] {
  const found = new Set<string>();
  for (const text of texts) for (const [, name] of text.matchAll(PLACEHOLDER)) found.add(name!.trim());
  const unknown = [...found].filter((name) => !WHITELIST.has(name));
  if (unknown.length > 0)
    throw new AppError('VALIDATION_FAILED', '模板含未登记的通知变量', {
      reason: 'WELCOME_VARIABLE_UNKNOWN',
      variables: unknown,
    });
  return WELCOME_VARIABLES.filter((name) => found.has(name));
}

const sampleValue = z.string().trim().min(1).max(200);
export const previewBody = z.strictObject({
  samples: z.strictObject(Object.fromEntries(WELCOME_VARIABLES.map((name) => [name, sampleValue.optional()]))),
});
export type PreviewSamples = z.output<typeof previewBody>['samples'];

function fill(text: string, samples: PreviewSamples): string {
  return escapeHtml(
    text.replace(PLACEHOLDER, (_, raw: string) => {
      const name = raw.trim() as WelcomeVariable;
      const value = samples[name];
      if (value === undefined)
        throw new AppError('VALIDATION_FAILED', `预览缺少样例：${name}`, {
          reason: 'PREVIEW_SAMPLE_MISSING',
          variable: name,
        });
      return value;
    }),
  );
}

export function renderWelcomePreview(letter: { title: string; body: string }, samples: PreviewSamples) {
  return {
    title: fill(letter.title, samples),
    bodyHtml: fill(letter.body, samples)
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
      .join(''),
  };
}

export function renderHandbookPreview(
  handbook: { title: string; blocks: readonly HandbookBlock[] },
  samples: PreviewSamples,
) {
  return {
    title: fill(handbook.title, samples),
    blocks: handbook.blocks.map((block) =>
      block.type === 'list'
        ? { type: block.type, items: block.items.map((item) => fill(item, samples)) }
        : { type: block.type, html: fill(block.text, samples) },
    ),
  };
}
