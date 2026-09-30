import { z } from 'zod';
import type { State } from './model.ts';
export const grantSchema=z.object({email:z.string().trim().email().max(254).transform(s=>s.toLowerCase()),name:z.string().trim().min(1).max(100),role:z.enum(['admin','hr','manager','approver','employee','payroll_editor','payroll_reviewer']),employeeId:z.string().max(100).nullable(),active:z.boolean(),orgScope:z.array(z.string().min(1)).max(100).default([]),viewEmail:z.boolean().default(false),viewLevel:z.boolean().default(false),revision:z.number().int().nonnegative()});
export function validateGrant(input:z.infer<typeof grantSchema>,state:State,selfEmail:string){
 if(input.email===selfEmail.toLowerCase()&&(!input.active||input.role!=='admin'))throw Error('不能停用自己或移除自己的管理员权限');
 if(input.active&&['hr','manager','approver','payroll_editor','payroll_reviewer'].includes(input.role)&&!input.orgScope.length)throw Error('请配置至少一个授权组织');
 if(input.orgScope.some(id=>!state.orgs.some(o=>o.id===id&&o.status==='启用')))throw Error('授权组织不存在或已停用');
 if(input.role==='employee'&&!input.employeeId)throw Error('员工角色必须关联员工档案');
 if(input.employeeId&&!state.employees.some(e=>e.id===input.employeeId&&(!input.active||e.status!=='离职')))throw Error('请选择有效的在职员工档案');
}
