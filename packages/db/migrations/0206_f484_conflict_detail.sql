-- F-484 第 2 轮 P2-1：复制失败的冲突信息结构化存储，名称在读取时按读取人 / 接收人权限重新生成。
-- 只加可空列；既有行不回填（DEC-402），其失败原因文本本就不带结构化信息，读取时按原文本原样返回。
ALTER TABLE "establishment_copy_job_versions" ADD COLUMN "failure_detail" jsonb;--> statement-breakpoint
ALTER TABLE "establishment_notifications" ADD COLUMN "reason_detail" jsonb;
