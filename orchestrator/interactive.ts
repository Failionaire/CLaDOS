/**
 * Interactive Mode — post-completion chat agent.
 *
 * After the pipeline reaches `complete`, the user can chat directly
 * with an interactive agent that has full project context.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { SessionState } from './types.js';
import type { Logger } from './logger.js';

export interface InteractiveConfig {
  apiKey: string;
  model: string;
  projectDir: string;
  state: SessionState;
  logger: Logger;
}

export interface InteractiveMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingDiff {
  id: string;
  file: string;
  diff: string;
  newContent: string;
}

export class InteractiveSession {
  private anthropic: Anthropic;
  private messages: InteractiveMessage[] = [];
  private systemPrompt: string;
  private model: string;
  private projectDir: string;
  private logger: Logger;
  pendingDiff: PendingDiff | null = null;

  constructor(config: InteractiveConfig) {
    this.anthropic = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model;
    this.projectDir = config.projectDir;
    this.logger = config.logger;

    // Load the interactive agent prompt
    const promptPath = path.join(__dirname, '..', 'agents', 'interactive.md');
    const basePrompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf-8') : '';

    // Build context from pipeline artifacts
    const contextParts: string[] = [basePrompt];

    const artifactDir = path.join(config.projectDir, '.clados');
    const artifactFiles = ['01-prd.md', '01-architecture.md', '02-build/validator.json'];
    for (const file of artifactFiles) {
      const fullPath = path.join(artifactDir, file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        contextParts.push(`\n\n--- ${file} ---\n${content.slice(0, 8000)}`);
      }
    }

    this.systemPrompt = contextParts.join('\n');
  }

  async sendMessage(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    const apiMessages = this.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: apiMessages,
      });

      const assistantContent = response.content
        .filter(block => block.type === 'text')
        .map(block => ('text' in block ? block.text : ''))
        .join('\n');

      this.messages.push({ role: 'assistant', content: assistantContent });
      this.logger.info('interactive.response', `Response: ${assistantContent.length} chars`);

      return assistantContent;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('interactive.error', errorMsg);
      throw err;
    }
  }

  proposeDiff(file: string, diff: string, newContent: string): PendingDiff {
    const id = `diff-${Date.now()}`;
    this.pendingDiff = { id, file, diff, newContent };
    return this.pendingDiff;
  }

  approveDiff(): boolean {
    if (!this.pendingDiff) return false;
    const fullPath = path.join(this.projectDir, this.pendingDiff.file);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, this.pendingDiff.newContent);
    this.logger.info('interactive.diff_approved', `Applied diff to ${this.pendingDiff.file}`);
    this.pendingDiff = null;
    return true;
  }

  rejectDiff(): boolean {
    if (!this.pendingDiff) return false;
    this.logger.info('interactive.diff_rejected', `Rejected diff for ${this.pendingDiff.file}`);
    this.pendingDiff = null;
    return true;
  }

  getHistory(): InteractiveMessage[] {
    return [...this.messages];
  }
}
