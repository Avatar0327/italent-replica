-- F-036 S5 第 6 轮（DEC-991 方案 B）：墓碑记下删除时记录在时间轴上的生效日；不在轴上（已被摘下）为空。
-- 字段来源“是否已落地”据此判断删除前是否已实际生效。旧墓碑不回填（DEC-402），保持为空。
-- 墓碑表只增不改（employment_record_tombstones_append_only），新列只在插入时写；app_user 的 INSERT 授权是表级，自动覆盖新列。
ALTER TABLE "employment_record_tombstones" ADD COLUMN "timeline_start_date" date;
