ALTER TABLE r1_workflow_roots ADD COLUMN org_id TEXT;
-- Earlier isolated increment roots without scope remain unavailable until explicitly republished from their verified source scope.
