-- Protected identity candidate index: values are tenant-bound digests, never public search keys.
CREATE TABLE r1_identity_keys (
 tenant_id TEXT NOT NULL,person_id TEXT NOT NULL,identifier_type TEXT NOT NULL,
 value_digest TEXT NOT NULL,verified_by TEXT NOT NULL,verified_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,person_id,identifier_type,value_digest),
 FOREIGN KEY(tenant_id,person_id) REFERENCES r1_m01_entities(tenant_id,id)
);
CREATE INDEX r1_identity_candidates ON r1_identity_keys(tenant_id,identifier_type,value_digest,person_id);

DROP INDEX r1_m01_code;
CREATE UNIQUE INDEX r1_m01_code ON r1_m01_entities(tenant_id,kind,code) WHERE code IS NOT NULL AND kind<>'contract_field';
CREATE UNIQUE INDEX r1_contract_field_code ON r1_m01_entities(tenant_id,org_id,code COLLATE NOCASE) WHERE kind='contract_field';
