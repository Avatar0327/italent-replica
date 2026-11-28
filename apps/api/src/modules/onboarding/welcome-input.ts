import { z } from 'zod';
import { usedVariables } from './welcome-preview.js';

const name = z.string().trim().min(1).max(100);
const title = z.string().trim().min(1).max(200);
const atLeastOne = (input: object) => Object.keys(input).length > 0;

export const welcomeCreateBody = z.strictObject({
  name,
  title,
  body: z.string().trim().min(1).max(5000),
  enabled: z.boolean().optional(),
});
export const welcomePatchBody = welcomeCreateBody.partial().refine(atLeastOne, '至少指定一项修改');
export type WelcomeCreateInput = z.output<typeof welcomeCreateBody>;
export type WelcomePatchInput = z.output<typeof welcomePatchBody>;

const text = z.string().trim().min(1).max(1000);
const blockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('heading'), text: z.string().trim().min(1).max(200) }),
  z.strictObject({ type: z.literal('paragraph'), text }),
  z.strictObject({ type: z.literal('list'), items: z.array(text).min(1).max(30) }),
]);
export type HandbookBlockInput = z.output<typeof blockSchema>;

export const handbookCreateBody = z.strictObject({
  name,
  title,
  blocks: z.array(blockSchema).min(1).max(50),
  enabled: z.boolean().optional(),
});
export const handbookPatchBody = handbookCreateBody.partial().refine(atLeastOne, '至少指定一项修改');
export type HandbookCreateInput = z.output<typeof handbookCreateBody>;
export type HandbookPatchInput = z.output<typeof handbookPatchBody>;

export function welcomeVariables(input: { title: string; body: string }) {
  return usedVariables(input.title, input.body);
}

/** 手册展示块里的变量与欢迎信同一白名单；块里不放链接和报到入口，只有三种文本块。 */
export function handbookTexts(title: string, blocks: readonly HandbookBlockInput[]): string[] {
  return [title, ...blocks.flatMap((block) => (block.type === 'list' ? block.items : [block.text]))];
}

export function checkHandbook(title: string, blocks: readonly HandbookBlockInput[]) {
  usedVariables(...handbookTexts(title, blocks));
}
