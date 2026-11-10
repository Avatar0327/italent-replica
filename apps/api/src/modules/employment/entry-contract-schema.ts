/**
 * 办理入职 / 新增实习生 / 退休返聘三个入口共用的合同请求模式（叶模块，F-512）：entryContractSchema / EntryContract 原在
 * entry-contract.ts。retirement-rehire、intern-create、entry-routes 在顶层 entryContractSchema.optional() / .extend(...)
 * 派生自己的模式；entry-contract 位于“审批引擎 ↔ 任职上下文”的导入环上，以它为首个入口时 retirement-rehire 先于它求值，
 * 顶层读到 undefined。本文件只依赖 zod 与合同模块的 input（不在环上），不在环上。entry-contract 对原名再导出。
 */
import type { z } from 'zod';
import { fieldsSchema } from '../contracts/input.js';

/**
 * 合同字段沿用合同模块的白名单；employmentRecordId 由系统关联，不接受请求指定。
 * 生效日固定取业务日（办理入职 / 新增实习生 = 入职日，退休同时返聘 = 返聘日 R），请求带 effectiveDate 一律 400
 * （F-423，DEC-735；DEC-402 不留兼容）。三个入口共用这一个 schema，不各自 omit。
 */
export const entryContractSchema = fieldsSchema.omit({ employmentRecordId: true, effectiveDate: true });
export type EntryContract = z.infer<typeof entryContractSchema>;
