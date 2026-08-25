/**
 * Bounds enforced on every `PageUnderstanding` graph (P03-F02 step 6).
 * Kept in one place so the Python observation adapter
 * (`services/browser/src/browser_service/page_observation/`) and this
 * schema cannot drift on what "bounded" means.
 */

export const MAX_PAGE_NODES = 400;
export const MAX_PAGE_RELATIONSHIPS = 800;
export const MAX_PAGE_REGIONS = 60;
export const MAX_PAGE_COLLECTIONS = 20;
export const MAX_COLLECTION_RECORD_HANDLES = 200;
export const MAX_INTERACTION_CAPABILITIES = 150;
export const MAX_SOURCE_CANDIDATES = 40;
export const MAX_SOURCE_CANDIDATE_FIELDS = 24;
export const MAX_PAGE_WARNINGS = 100;
export const MAX_PAGE_TRUNCATIONS = 50;
export const MAX_COVERAGE_NOTES = 20;
export const MAX_CAPABILITY_EVIDENCE = 5;
export const MAX_CAPABILITY_REQUIRED_INPUTS = 20;
export const MAX_REGION_CHILD_HANDLES = 500;

export const PAGE_NODE_TEXT_MAX_LENGTH = 2_000;
export const PAGE_NODE_LABEL_MAX_LENGTH = 300;
export const OBSERVATION_DEPTH_LIMIT = 40;
