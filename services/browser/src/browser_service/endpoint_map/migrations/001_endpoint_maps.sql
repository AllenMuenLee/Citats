CREATE TABLE endpoint_map_sites (
    site_id text PRIMARY KEY,
    canonical_origin text NOT NULL,
    created_at timestamptz NOT NULL
);

CREATE TABLE endpoint_map_versions (
    version_id text PRIMARY KEY,
    site_id text NOT NULL REFERENCES endpoint_map_sites(site_id),
    created_at timestamptz NOT NULL,
    operations jsonb NOT NULL,
    approval_state text NOT NULL CHECK (approval_state IN ('pending', 'active', 'superseded')),
    activated_at timestamptz,
    activated_by text,
    activation_reason text
);

CREATE UNIQUE INDEX endpoint_map_one_active_per_site
    ON endpoint_map_versions(site_id) WHERE approval_state = 'active';

CREATE TABLE endpoint_map_operations (
    version_id text NOT NULL REFERENCES endpoint_map_versions(version_id),
    operation_index integer NOT NULL,
    method text NOT NULL,
    origin text NOT NULL,
    path_template text NOT NULL,
    parameter_schema jsonb NOT NULL,
    response_schema jsonb NOT NULL,
    confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    stale boolean NOT NULL DEFAULT false,
    stale_reason text,
    last_seen timestamptz NOT NULL,
    PRIMARY KEY (version_id, operation_index),
    UNIQUE (version_id, method, origin, path_template)
);

CREATE TABLE endpoint_map_observation_provenance (
    version_id text NOT NULL,
    operation_index integer NOT NULL,
    observation_id text NOT NULL,
    PRIMARY KEY (version_id, operation_index, observation_id),
    FOREIGN KEY (version_id, operation_index)
        REFERENCES endpoint_map_operations(version_id, operation_index)
);

CREATE TABLE endpoint_map_activations (
    activation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id text NOT NULL REFERENCES endpoint_map_sites(site_id),
    version_id text NOT NULL REFERENCES endpoint_map_versions(version_id),
    activated_at timestamptz NOT NULL,
    actor text NOT NULL,
    reason text NOT NULL
);
