# GPT 旧版代码参考快照（只读）

- 来源：`Avatar0327/italent-gpt-legacy`（14 分支完整历史），2026-09-30 快照。
- `r1-in-progress/`：分支 `impl/r1-p3-20260910` 的 lib/app/drizzle/tests/db/worker/docs/delivery。
- `main/`：分支 `main` 的 lib/app/drizzle/tests/db/worker。
- 依据 DEC-047：只作参考。**禁止修改本目录，禁止从产品代码 import**；规则与 `docs/` 规格冲突时一律以规格为准。
- 禁止照搬的反模式：组织单一 `parent_id`、数据范围以 JSON 存在授权行、实体头行原地 UPSERT 并与旧表双写、`chatgpt-auth.ts` 平台身份头、超长单行代码。
- 审计结论见 `docs/云端并行开发指引_v2_20260930.md` §0.2。
