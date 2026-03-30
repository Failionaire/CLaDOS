import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { ContextArtifact } from './types.js';
import type { Logger } from './logger.js';

// Model names used for utility calls — set once at startup from the registry.
let _tokenCounterModel = 'claude-sonnet-4-6';
let _summarizerModel = 'claude-haiku-4-5';

/** Called by Conductor.init() after the registry is loaded. */
export function initContextModels(tokenCounter: string, summarizer: string): void {
  _tokenCounterModel = tokenCounter;
  _summarizerModel = summarizer;
}

// ─── Tree-sitter AST extraction ───────────────────────────────────────────────

// Lazily initialised — tree-sitter requires a native addon compile; skip gracefully if unavailable.
let _tsParser: TsParser | null = null;
let _tsParserAttempted = false;

function getTypeScriptParser(): TsParser | null {
  if (_tsParserAttempted) return _tsParser;
  _tsParserAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Parser = require('tree-sitter') as { new(): TsParser };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TypeScript = (require('tree-sitter-typescript') as { typescript: unknown }).typescript;
    const parser = new Parser();
    parser.setLanguage(TypeScript);
    _tsParser = parser;
    return _tsParser;
  } catch {
    return null;
  }
}

interface TsNode {
  type: string;
  text: string;
  children: TsNode[];
  startPosition: { row: number; column: number };
}

interface TsParser {
  setLanguage(l: unknown): void;
  parse(s: string): { rootNode: TsNode };
}

/**
 * Extract exported declarations from a TypeScript file using tree-sitter.
 * Returns a compact string listing exports with their signatures.
 * Falls back to empty string if tree-sitter is unavailable or parsing fails.
 */
export function extractTypeScriptExports(content: string): string {
  const parser = getTypeScriptParser();
  if (!parser) return '';
  try {
    const tree = parser.parse(content);
    const exports: string[] = [];

    function walk(node: TsNode): void {
      // export_statement wraps: export function/class/const/type/interface
      if (node.type === 'export_statement') {
        // Take the first non-empty line (the signature)
        const firstLine = node.text.split('\n')[0]?.trim() ?? '';
        if (firstLine) exports.push(firstLine.slice(0, 140));
        return; // don't recurse into the export body
      }
      for (const child of node.children) walk(child);
    }

    walk(tree.rootNode);
    return exports.slice(0, 30).join('\n');
  } catch {
    return '';
  }
}

const TOKEN_FALLBACK_CHARS_PER_TOKEN = 3.5;
const CONTEXT_TOKEN_LIMIT = 80_000;
const CHARS_PREVIEW = 300;
// Compressed previews are ~300 chars of content + header; ~86 tokens at 3.5 chars/token, rounded up.
const COMPRESSED_TOKEN_ESTIMATE = 100;

export interface ResolvedArtifact {
  key: string;
  content: string;
  tokenCount: number;
  compressed: boolean;
}

/**
 * Estimate token count for a string. Uses Anthropic's countTokens if available,
 * falls back to char-based approximation.
 */
const TOKEN_COUNT_TIMEOUT_MS = 15_000;

export async function estimateTokens(
  text: string,
  anthropic: Anthropic,
  logger: Logger,
): Promise<number> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('countTokens timeout')), TOKEN_COUNT_TIMEOUT_MS),
    );
    const result = await Promise.race([
      anthropic.beta.messages.countTokens({
        model: _tokenCounterModel,
        messages: [{ role: 'user', content: text }],
      }),
      timeout,
    ]);
    return result.input_tokens;
  } catch {
    logger.warn('context.token_count_fallback', 'countTokens unavailable — using char estimate');
    return Math.ceil(text.length / TOKEN_FALLBACK_CHARS_PER_TOKEN);
  }
}

/**
 * Generate a one-line summary of a file's content using the Haiku summarizer.
 * Used by the Two-Tier AST/LSP context strategy.
 */
export async function summarizeFile(
  filePath: string,
  content: string,
  anthropic: Anthropic,
  logger: Logger,
): Promise<string> {
  // Two-tier strategy: AST exports (structural) + Haiku prose (intent)
  const astExports = path.extname(filePath) === '.ts' ? extractTypeScriptExports(content) : '';
  const astSection = astExports
    ? `Exported declarations:\n${astExports}\n\n`
    : '';

  try {
    const msg = await anthropic.messages.create({
      model: _summarizerModel,
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content:
            `Summarize this file in one concise sentence describing what it exports and does.\n` +
            `File: ${path.basename(filePath)}\n\n` +
            `${astSection}` +
            `Source (first 1500 chars):\n${content.slice(0, 1500)}`,
        },
      ],
    });
    const text = msg.content.find((b) => b.type === 'text');
    const prose = text ? text.text.trim() : `${path.basename(filePath)}: (summary unavailable)`;
    // Return combined AST + prose so downstream agents get both types and intent
    return astExports ? `${path.basename(filePath)}: ${prose}\n  exports: ${astExports.split('\n').slice(0, 5).join('; ')}` : prose;
  } catch (err) {
    logger.warn('context.summarize_failed', `Failed to summarize ${filePath}`, {
      error: String(err),
    });
    // Fall back to AST-only context if Haiku is unavailable
    return astExports
      ? `${path.basename(filePath)}: (prose summary unavailable)\n  exports: ${astExports.split('\n').slice(0, 5).join('; ')}`
      : `${path.basename(filePath)}: (summary unavailable)`;
  }
}

/**
 * Compress content to a short summary preview for context downgrade.
 */
export function compressToPreview(key: string, content: string): string {
  const preview = content.slice(0, CHARS_PREVIEW);
  return `[COMPRESSED: ${key}]\n${preview}${content.length > CHARS_PREVIEW ? '\n...(use read_file to access full content)' : ''}`;
}

/**
 * Resolve context artifacts for an agent dispatch.
 *
 * Strategy:
 * 1. Inject all existing artifacts
 * 2. If total > 80K tokens, downgrade `reference` → summaries first
 * 3. If still over, downgrade `required` → summaries, grant read_file access
 * 4. Log all downgrades to session state
 */
export async function resolveContextArtifacts(
  claDosDir: string,
  artifacts: ContextArtifact[],
  anthropic: Anthropic,
  logger: Logger,
  summarizerBudgetCheck?: (projectedCost: number) => boolean,
  onSummarizerCost?: (cost: number) => void,
): Promise<{
  resolved: ResolvedArtifact[];
  compressionNeeded: boolean;
  fullFetchPaths: string[];
}> {
  type LoadedArtifact = ContextArtifact & { content: string; tokenCount: number };

  const loadResults = await Promise.all(
    artifacts.map(async (artifact): Promise<LoadedArtifact | null> => {
      const fullPath = path.join(claDosDir, artifact.artifact);
      let content: string;
      try {
        content = await fs.promises.readFile(fullPath, 'utf-8');
      } catch (e) {
        // M-10: Required artifacts must exist; missing ones indicate a pipeline logic error
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        if (artifact.type === 'required') {
          throw new Error(`Required artifact missing: ${artifact.artifact} (expected at ${fullPath})`);
        }
        return null;
      }
      const tokenCount = await estimateTokens(content, anthropic, logger);
      return { ...artifact, content, tokenCount };
    })
  );

  const loaded = loadResults.filter((r): r is LoadedArtifact => r !== null);

  let totalTokens = loaded.reduce((s, a) => s + a.tokenCount, 0);

  if (totalTokens <= CONTEXT_TOKEN_LIMIT) {
    return {
      resolved: loaded.map((a) => ({
        key: a.artifact,
        content: a.content,
        tokenCount: a.tokenCount,
        compressed: false,
      })),
      compressionNeeded: false,
      fullFetchPaths: [],
    };
  }

  logger.warn('context.over_limit', `Context ${totalTokens} tokens > ${CONTEXT_TOKEN_LIMIT} — downgrading references`);

  // Pass 1: downgrade reference → Haiku summary (or compressed preview if budget cap hit)
  const resolved: ResolvedArtifact[] = [];
  totalTokens = 0;

  // Haiku prices for budget estimation: $0.80 input / $4.00 output per 1M tokens
  const HAIKU_INPUT_PRICE_PER_M = 0.80;
  const HAIKU_OUTPUT_PRICE_PER_M = 4.00;
  const SUMMARIZER_OUTPUT_TOKENS = 120;

  for (const a of loaded) {
    if (a.type === 'reference' && totalTokens + a.tokenCount > CONTEXT_TOKEN_LIMIT) {
      // Estimate cost: input is first 1500 chars at ~3.5 chars/token, output is ~120 tokens
      const estimatedInputTokens = Math.ceil(Math.min(a.content.length, 1500) / TOKEN_FALLBACK_CHARS_PER_TOKEN);
      const projectedCost =
        (estimatedInputTokens / 1_000_000) * HAIKU_INPUT_PRICE_PER_M +
        (SUMMARIZER_OUTPUT_TOKENS / 1_000_000) * HAIKU_OUTPUT_PRICE_PER_M;

      const canSummarize = !summarizerBudgetCheck || summarizerBudgetCheck(projectedCost);
      if (canSummarize) {
        const summary = await summarizeFile(a.artifact, a.content, anthropic, logger);
        onSummarizerCost?.(projectedCost);
        const summaryTokens = Math.ceil(summary.length / TOKEN_FALLBACK_CHARS_PER_TOKEN);
        resolved.push({ key: a.artifact, content: summary, tokenCount: summaryTokens, compressed: true });
        totalTokens += summaryTokens;
      } else {
        logger.warn('context.summarizer_cap', `Summarizer budget cap reached for ${a.artifact} — using truncation`);
        const compressed = compressToPreview(a.artifact, a.content);
        resolved.push({ key: a.artifact, content: compressed, tokenCount: COMPRESSED_TOKEN_ESTIMATE, compressed: true });
        totalTokens += COMPRESSED_TOKEN_ESTIMATE;
      }
    } else {
      resolved.push({ key: a.artifact, content: a.content, tokenCount: a.tokenCount, compressed: false });
      totalTokens += a.tokenCount;
    }
  }

  if (totalTokens <= CONTEXT_TOKEN_LIMIT) {
    return { resolved, compressionNeeded: true, fullFetchPaths: [] };
  }

  // Pass 2: downgrade required → compressed, grant read_file access
  logger.warn('context.over_limit_pass2', `Still ${totalTokens} tokens — downgrading required artifacts`);
  const fullFetchPaths: string[] = [];
  const resolved2: ResolvedArtifact[] = [];
  totalTokens = 0;

  for (const a of resolved) {
    if (!a.compressed && totalTokens + a.tokenCount > CONTEXT_TOKEN_LIMIT) {
      const originalContent = loaded.find((l) => l.artifact === a.key)?.content ?? a.content;
      const compressed = compressToPreview(a.key, originalContent);
      resolved2.push({ key: a.key, content: compressed, tokenCount: COMPRESSED_TOKEN_ESTIMATE, compressed: true });
      fullFetchPaths.push(a.key);
      totalTokens += COMPRESSED_TOKEN_ESTIMATE;
    } else {
      resolved2.push(a);
      totalTokens += a.tokenCount;
    }
  }

  return { resolved: resolved2, compressionNeeded: true, fullFetchPaths };
}

/**
 * Inject {{ variable_name }} placeholders into a system prompt string.
 */
export function injectVariables(
  promptText: string,
  variables: Record<string, string>,
): string {
  let result = promptText;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  // H-13: Remove only unreplaced placeholders (keys absent from variables) so models don't
  // misinterpret {{...}} syntax. Scans the original template rather than the substituted result
  // to avoid stripping {{...}} patterns that arrived via injected variable values.
  for (const match of promptText.matchAll(/\{\{([^}]+)\}\}/g)) {
    const key = match[1]!;
    if (!(key in variables)) {
      result = result.replaceAll(`{{${key}}}`, '');
    }
  }
  return result;
}

/**
 * Validate that an agent system prompt contains all required sections.
 * Returns the list of missing section headers.
 */
export function validateSystemPromptSections(promptText: string): string[] {
  const required = ['## Identity', '## Inputs', '## Task', '## Output schema', '## Constraints'];
  return required.filter((section) => !promptText.includes(section));
}

/**
 * Run the structural marker test on a partial artifact to determine
 * whether crash recovery can resume from it or must restart clean.
 */
export function passesStructuralMarkerTest(content: string, ext: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;

  switch (ext) {
    case '.md':
      return /^##\s+.+/m.test(normalized);
    case '.json': {
      if (!/^\s*\{/.test(normalized)) return false;
      try {
        return Object.keys(JSON.parse(normalized)).length > 0;
      } catch {
        return false;
      }
    }
    case '.yaml':
    case '.yml':
      return /^[a-zA-Z][\w-]*:/m.test(normalized);
    default:
      return normalized.length > 50;
  }
}
