export const PROJECT_NAME = "Argus";

export const DOMAIN_NAME = "argusdb.app";
export const HOSTED_ZONE_ID = "Z0157620NK45JFH3SPGW";
export const RELEASES_SUBDOMAIN = `releases.${DOMAIN_NAME}`;
export const RELEASES_PUBLIC_URL = `https://${RELEASES_SUBDOMAIN}`;

export const LANDING_DOMAIN = DOMAIN_NAME;
export const LANDING_WWW_SUBDOMAIN = `www.${DOMAIN_NAME}`;
export const LANDING_PUBLIC_URL = `https://${DOMAIN_NAME}`;

// ── Analytics ──────────────────────────────────────────────────────────────
export const ANALYTICS_LOG_BUCKET_SSM = "/Argus/analytics/log-bucket-name";
export const LANDING_LOG_PREFIX = "landing/";
export const RELEASES_LOG_PREFIX = "releases/";
export const ANALYTICS_GLUE_DATABASE = "argus_analytics";
export const ANALYTICS_WORKGROUP = "argus-analytics";
export const ANALYTICS_LOG_RETENTION_DAYS = 90;
