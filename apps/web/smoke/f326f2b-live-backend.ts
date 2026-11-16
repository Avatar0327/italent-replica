/**
 * F-326 F2b 浏览器集成专用：复用 F2a 的隔离库后端（真实 Hono、真实授权引擎、合成数据），只换预置。
 * 预置：合成 HR 持 matrix_admin 身份；一条启用矩阵「合成结构矩阵」，部门条件列「条件」+ 多人角色列「角色」、三行，
 * 矩阵经真实 HTTP 入口创建（同 S4 夹具）。冲突一例由冒烟以同一合成 HR 直接写本后端，模拟他人先改。
 */
import { MATRICES, matrix, type S4World } from '../../../tests/acceptance/AC-APV-F326-S4-support.js';
import { grantMatrixAdmin, startMatrixBackend as start } from './f326f2a-live-backend.js';

async function seed(w: S4World) {
  await grantMatrixAdmin(w);
  const made = await matrix(w, {
    rows: [
      { cond: [w.root], role: [w.head.userId] },
      { cond: [w.child], role: [w.near.userId] },
      { cond: [w.staff], role: [w.head.userId, w.near.userId] },
    ],
  });
  await w.json(
    await w.request(w.hr.id, 'PATCH', `${MATRICES}/${made.id}`, {
      body: { name: '合成结构矩阵', revision: made.revision },
    }),
  );
  return { matrix: made.id };
}

export const startMatrixBackend = () => start(seed, 'f2b-browser');
