import { API_VERSION } from './public.js';

/**
 * §11.1: *"Versioned REST API with OpenAPI documentation and stable resource
 * identifiers."*
 *
 * Served by the API rather than checked in beside it, so it cannot describe a
 * deployment other than the one answering. A specification in a repository
 * describes what somebody meant; one served from `/openapi.json` describes what
 * is running, and the difference is the whole value of publishing it.
 *
 * It is written by hand rather than generated from the route table. Generating
 * it would keep the paths in step automatically and would have nothing to say
 * about *why* `omitted_fields` exists or what a cursor promises — and those are
 * the parts an integrator needs. The paths are few enough that drift is
 * visible; the prose is not derivable at all.
 */
export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Patform API',
    version: API_VERSION,
    description: [
      'Records, metrics and imports for a Patform workspace.',
      '',
      '**Authentication.** A scoped API key as `Authorization: Bearer pat_live_…`.',
      'A key carries a subset of its creator\'s capabilities and is checked against',
      'them on every request, so a key cannot outlive the authority it came from.',
      '',
      '**Permissions.** Field-level permissions are reflected in responses. A field',
      'your key\'s roles may not see is **omitted** from `data` and named in',
      '`omitted_fields` — never returned as a placeholder string, because a',
      'consumer would store it.',
      '',
      '**Pagination** is by cursor, not offset. Pass `next_cursor` back as `cursor`.',
      'Offsets skip and repeat rows when records are being created underneath you,',
      'which is the normal case during business hours.',
      '',
      '**Idempotency.** Send `Idempotency-Key` on any POST. The first response is',
      'stored and replayed for that key. Reusing a key with a different body is a',
      '409 rather than a silent replay, because that combination is a caller bug.',
      '',
      '**Rate limits** are per key and per workspace, reported on every response in',
      '`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.',
      '',
      'Every response carries `X-Request-Id`. Quote it in support.',
    ].join('\n'),
  },
  servers: [{ url: `/${API_VERSION}` }],
  components: {
    securitySchemes: {
      apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'pat_live_…' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['type', 'message', 'request_id'],
            properties: {
              type: {
                type: 'string',
                enum: ['unauthorized', 'forbidden', 'not_found', 'validation_error', 'conflict', 'rate_limited', 'internal_error'],
              },
              message: { type: 'string' },
              request_id: { type: 'string' },
            },
          },
        },
      },
      Record: {
        type: 'object',
        required: ['id', 'reference', 'process_key', 'state', 'data', 'omitted_fields'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          reference: { type: 'string', description: 'Short form shown to people.' },
          process_key: { type: 'string' },
          process_version: { type: 'integer', description: 'The published version governing this record.' },
          state: { type: 'string' },
          state_name: { type: 'string' },
          outcome: { type: ['string', 'null'] },
          created_at: { type: 'string', format: 'date-time' },
          state_entered_at: { type: 'string', format: 'date-time' },
          completed_at: { type: ['string', 'null'], format: 'date-time' },
          data: { type: 'object', additionalProperties: true, description: 'Answers your key may read. Fields it may not are absent.' },
          omitted_fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Field keys withheld from `data` because your roles may not see them.',
          },
        },
      },
      Page: {
        type: 'object',
        required: ['data', 'has_more'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Record' } },
          next_cursor: { type: ['string', 'null'] },
          has_more: { type: 'boolean' },
        },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    '/processes': {
      get: {
        summary: 'Published processes in this workspace',
        description: 'Scope: `view`.',
        responses: { 200: { description: 'The processes your key may see.' } },
      },
    },
    '/records': {
      get: {
        summary: 'Records, newest first',
        description:
          'Scope: `view`. An unrecognised filter is a 422 rather than being ignored — returning everything when a caller asked for a subset is how an integration leaks.',
        parameters: [
          { name: 'process', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', schema: { type: 'string' } },
          { name: 'completed', in: 'query', schema: { type: 'boolean' } },
          { name: 'updated_since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'A page.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } },
          422: { description: 'Unknown filter, or a state this process does not have.' },
        },
      },
      post: {
        summary: 'Create a record',
        description:
          'Scope: `edit`. Answers are validated by the same rules as the public form — there is one implementation, so an API caller cannot create a record a respondent could not.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 255 } }],
        responses: {
          201: { description: 'Created.' },
          409: { description: 'This Idempotency-Key was used with a different body.' },
          422: { description: 'Answers were refused; `problems` names each field.' },
        },
      },
    },
    '/records/{id}': {
      get: {
        summary: 'One record',
        description: 'Scope: `view`. A record in another workspace is a 404, not a 403 — confirming it exists would itself disclose something.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'The record.' }, 404: { description: 'No such record.' } },
      },
    },
    '/metrics': {
      get: {
        summary: 'Operational metrics',
        description:
          'Scope: `report`. Each measurement carries the definition that produced it. Rates over fewer than five records are withheld with a reason rather than shown — a percentage over a handful of people identifies them.',
        parameters: [
          { name: 'process', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'days', in: 'query', schema: { type: 'integer', default: 30 } },
        ],
        responses: { 200: { description: 'Measurements, definitions, and the versions they span.' } },
      },
    },
    '/imports': {
      post: {
        summary: 'Import records from CSV',
        description:
          'Scope: `edit`. Refuses the whole file if any row is invalid, unless `partial` is true. A hundred-row file with four bad rows should not become ninety-six records and a puzzle.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 255 } }],
        responses: {
          201: { description: 'Imported. `created` lists each record and its source line.' },
          422: { description: 'Not applied. `rows` names the problem on each line.' },
        },
      },
    },
  },
} as const;
