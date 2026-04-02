/**
 * Delta Detector — determines which phase to re-enter for a project change.
 *
 * Uses a utility LLM call (Haiku) to classify the change description
 * against the project's current artifacts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { SessionState } from './types.js';
import type { Logger } from './logger.js';

export interface DeltaDetectionResult {
  entry_phase: number;
  reasoning: string;
}

const DETECTION_PROMPT = `You are a project change classifier. Given a project's current state and a change description, determine which pipeline phase should be re-entered.

Phase numbers:
  0 = Concept — the change redefines what the project is (new idea, major pivot)
  1 = Architecture — the change affects system design, database schema, API structure, or tech stack
  2 = Build — the change is a code-level modification (new feature, bug fix, refactor)
  3 = Document — the change only affects documentation (README, API docs, comments)
  4 = Infrastructure — the change only affects deployment, CI/CD, or Dockerfile

Rules:
- Pick the EARLIEST phase that is affected. If the change touches architecture AND code, pick phase 1 (architecture).
- If uncertain, pick the earlier phase. It's safer to re-run more than to miss something.
- A "small feature" is typically phase 2. A "new endpoint" that requires schema changes is phase 1.

Output ONLY a JSON object: { "entry_phase": <number>, "reasoning": "<one sentence>" }`;

export async function detectDelta(
  apiKey: string,
  model: string,
  projectDir: string,
  changeDescription: string,
  state: SessionState,
  logger: Logger,
): Promise<DeltaDetectionResult> {
  const anthropic = new Anthropic({ apiKey });

  // Build context summary from artifacts
  const artifactDir = path.join(projectDir, '.clados');
  const contextParts: string[] = [];

  const summaryFiles = ['00-concept.md', '01-prd.md', '01-architecture.md'];
  for (const file of summaryFiles) {
    const fullPath = path.join(artifactDir, file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      contextParts.push(`--- ${file} (first 2000 chars) ---\n${content.slice(0, 2000)}`);
    }
  }

  // List source files
  const srcDir = path.join(projectDir, 'src');
  if (fs.existsSync(srcDir)) {
    const files = listFilesRecursive(srcDir, 50);
    contextParts.push(`--- Source files ---\n${files.join('\n')}`);
  }

  const userMessage = `Current project artifacts:\n${contextParts.join('\n\n')}\n\nChange description:\n${changeDescription}`;

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 256,
      system: DETECTION_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => ('text' in b ? b.text : ''))
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const entry_phase = typeof parsed.entry_phase === 'number' ? parsed.entry_phase : 2;
      const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : 'Could not determine reasoning';
      logger.info('delta.detected', `Entry phase: ${entry_phase} — ${reasoning}`);
      return { entry_phase, reasoning };
    }
  } catch (err) {
    logger.error('delta.detection_error', (err as Error).message);
  }

  // Default to phase 2 (build) if detection fails
  return { entry_phase: 2, reasoning: 'Detection failed — defaulting to build phase' };
}

function listFilesRecursive(dir: string, limit: number): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(full, limit - results.length));
      } else {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}
