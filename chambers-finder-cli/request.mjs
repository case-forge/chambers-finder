/**
 * The Chambers Finder CLI's request: what a JSON request may contain, and how it is checked.
 *
 * Pure: no file access, so it can be tested and reused anywhere. Every limit is stated in README.md and
 * request.schema.json; where the page would quietly fall back, the CLI reports.
 */
import { RequestError } from '../scripts/cli-contract.mjs';

export { RequestError };
export const SCHEMA_VERSION = 1;
export const REQUEST_KEYS = ['schemaVersion', '_comment', 'postcode', 'courts', 'chambers', 'radiusMiles', 'courtId', 'measureFrom'];
export const LIMITS = { courts: { min: 1, max: 20, default: 3 }, chambers: { min: 1, max: 50, default: 5 }, radiusMiles: { min: 1, max: 500 } };
export const MEASURE_FROM = ['court', 'postcode'];
export const MAX_BATCH = 500;
export const MAX_POSTCODE_LENGTH = 20;

const fail = (code, message, path) => { throw new RequestError(code, message, path); };

function whole(value, name, { min, max, default: dflt }) {
  if (value === undefined || value === null) return dflt;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('invalid_field_type', `${name} must be a whole number.`, name);
  if (value < min || value > max) fail('invalid_field_value', `${name} must be from ${min} to ${max}.`, name);
  return value;
}

/**
 * Checks one request object and returns the settled values. `defaultRadius` is the data file's own default
 * travel radius in miles. radiusMiles is a number, or "all" (no limit), which comes back as null.
 * Throws RequestError.
 */
export function checkRequest(raw, defaultRadius) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_request', 'A request must be a JSON object.');
  for (const key of Object.keys(raw)) {
    if (!REQUEST_KEYS.includes(key)) fail('unknown_key', `The request has a key this version does not know: ${JSON.stringify(key.slice(0, 40))}.`, key);
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
    fail('unsupported_schema_version', `The request's schemaVersion is ${JSON.stringify(raw.schemaVersion)}; this version reads schemaVersion ${SCHEMA_VERSION}.`, 'schemaVersion');
  }
  if (raw.postcode === undefined || raw.postcode === null) fail('missing_postcode', 'The request needs a postcode.', 'postcode');
  if (typeof raw.postcode !== 'string') fail('invalid_field_type', 'postcode must be text.', 'postcode');
  if (raw.postcode.length > MAX_POSTCODE_LENGTH) fail('postcode_invalid', 'That does not look like a UK postcode.', 'postcode');
  const courts = whole(raw.courts, 'courts', LIMITS.courts);
  const chambers = whole(raw.chambers, 'chambers', LIMITS.chambers);
  let radiusMiles;
  if (raw.radiusMiles === undefined || raw.radiusMiles === null) radiusMiles = defaultRadius ?? null;
  else if (raw.radiusMiles === 'all') radiusMiles = null;
  else if (typeof raw.radiusMiles !== 'number' || !Number.isFinite(raw.radiusMiles)) fail('invalid_field_type', 'radiusMiles must be a number or "all".', 'radiusMiles');
  else if (raw.radiusMiles < LIMITS.radiusMiles.min || raw.radiusMiles > LIMITS.radiusMiles.max) fail('invalid_field_value', `radiusMiles must be from ${LIMITS.radiusMiles.min} to ${LIMITS.radiusMiles.max}, or "all".`, 'radiusMiles');
  else radiusMiles = raw.radiusMiles;
  let courtId = null;
  if (raw.courtId !== undefined && raw.courtId !== null) {
    if (typeof raw.courtId !== 'string' || !raw.courtId || raw.courtId.length > 100) fail('invalid_field_type', 'courtId must be the id of a court, as text.', 'courtId');
    courtId = raw.courtId;
  }
  let measureFrom = 'court';
  if (raw.measureFrom !== undefined && raw.measureFrom !== null) {
    if (!MEASURE_FROM.includes(raw.measureFrom)) fail('invalid_field_value', `measureFrom must be one of ${MEASURE_FROM.join(', ')}.`, 'measureFrom');
    measureFrom = raw.measureFrom;
  }
  return { postcode: raw.postcode, courts, chambers, radiusMiles, courtId, measureFrom };
}
