import { writeFileSync, mkdirSync } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Blueprint } from './blueprint/index.js';

/**
 * The JSON Schema is what an AI provider's structured-output mode is given, so
 * a proposed blueprint is constrained at generation time as well as validated
 * after it (section 7.3).
 */
const schema = zodToJsonSchema(Blueprint, {
  name: 'ProcessBlueprint',
  $refStrategy: 'root',
});

mkdirSync('schema', { recursive: true });
writeFileSync('schema/blueprint-0.1.json', JSON.stringify(schema, null, 2) + '\n');
console.log('wrote schema/blueprint-0.1.json');
