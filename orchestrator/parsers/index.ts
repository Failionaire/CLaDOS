/**
 * Route Parser Registry
 *
 * Selects the appropriate RouteParser based on the stack manifest's
 * backend_framework field.
 */

import type { RouteParser } from './route-parser.js';
import { ExpressParser } from './express-parser.js';
import { FastAPIParser } from './fastapi-parser.js';
import { GinParser } from './gin-parser.js';

const parsers: Record<string, () => RouteParser> = {
  express: () => new ExpressParser(),
  fastapi: () => new FastAPIParser(),
  gin: () => new GinParser(),
  chi: () => new GinParser(), // Chi uses same Go pattern
};

/**
 * Get a RouteParser for the given backend framework.
 * Returns null if no parser exists (triggers LLM fallback).
 */
export function getRouteParser(backendFramework: string): RouteParser | null {
  const factory = parsers[backendFramework.toLowerCase()];
  return factory ? factory() : null;
}
