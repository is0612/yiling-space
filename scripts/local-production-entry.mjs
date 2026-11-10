// Nitro's generated chunks can evaluate before index.mjs sets its import-meta shim.
// On Windows the fallback file:///_entry.js is not an absolute drive path.
// Initialize the shim before dynamically loading the compiled server.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const entry = path.resolve('.output/server/index.mjs');
globalThis._importMeta_ = { url: pathToFileURL(entry).href, env: process.env };
await import(pathToFileURL(entry).href);
