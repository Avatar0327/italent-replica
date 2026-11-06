-- F-351 / DEC-714：撤销退休不收原因，撤销记录的原因列放开为可空；撤销离职仍由路由必填（CHECK 对 NULL 放行）。
ALTER TABLE "exit_cancellations" ALTER COLUMN "reason" DROP NOT NULL;