import { generateVapidKeys } from '../src/runtime/web-push.js';

/**
 * A VAPID key pair for push notifications. Run once per deployment and put
 * the two values in the environment; the public one is handed to browsers,
 * the private one signs every message. Changing them later invalidates every
 * subscription, so keep them.
 *
 *   npm run push:keys
 */
const keys = generateVapidKeys();
console.log('\nAdd these to the environment of the API and the worker:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com   # who the push service may contact\n');
