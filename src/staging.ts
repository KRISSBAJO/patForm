/**
 * Render Free can run one web service, but not a separate background worker.
 * Run both while the service is awake for a disposable staging environment.
 * Timers and delivery stop during Render's idle suspension.
 */
if (process.env.STAGING_COMBINED_SERVICE !== 'true') {
  throw new Error('STAGING_COMBINED_SERVICE=true is required for the combined staging service');
}

await Promise.all([import('./api/server.js'), import('./worker.js')]);

export {};
