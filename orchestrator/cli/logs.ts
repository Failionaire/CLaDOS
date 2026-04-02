/**
 * clados logs — filtered views of run.log
 *
 * Flags:
 *   --agent <name>    Filter by agent name
 *   --phase <n>       Filter by phase number
 *   --event <pattern> Filter by event name (substring match)
 *   --since <iso>     Only entries after this ISO timestamp
 *   --errors          Only error-level entries
 *   --raw             Output raw JSON lines instead of formatted
 */

import fs from 'fs';
import path from 'path';
import type { LogEntry } from '../types.js';

interface LogsOptions {
  agent?: string;
  phase?: number;
  event?: string;
  since?: string;
  errors?: boolean;
  raw?: boolean;
}

function parseArgs(args: string[]): { projectDir: string; opts: LogsOptions } {
  const opts: LogsOptions = {};
  let projectDir = process.cwd();
  let i = 0;

  while (i < args.length) {
    switch (args[i]) {
      case '--agent':
        opts.agent = args[++i];
        break;
      case '--phase':
        opts.phase = parseInt(args[++i] ?? '0', 10);
        break;
      case '--event':
        opts.event = args[++i];
        break;
      case '--since':
        opts.since = args[++i];
        break;
      case '--errors':
        opts.errors = true;
        break;
      case '--raw':
        opts.raw = true;
        break;
      default: {
        const arg = args[i];
        if (arg && !arg.startsWith('--')) projectDir = arg;
        break;
      }
    }
    i++;
  }

  return { projectDir, opts };
}

function formatEntry(entry: LogEntry): string {
  const ts = entry.timestamp.substring(11, 23); // HH:MM:SS.mmm
  const phase = entry.phase !== null ? `P${entry.phase}` : '  ';
  const agent = (entry.agent ?? '').padEnd(12);
  const level = entry.level.toUpperCase().padEnd(5);
  return `${ts} ${level} ${phase} ${agent} ${entry.event}: ${entry.message}`;
}

export async function logsCommand(args: string[]): Promise<void> {
  const { projectDir, opts } = parseArgs(args);
  const logPath = path.join(projectDir, '.clados', 'run.log');

  if (!fs.existsSync(logPath)) {
    console.error(`No log file found at ${logPath}`);
    process.exit(1);
  }

  const content = await fs.promises.readFile(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    let entry: LogEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (opts.agent && entry.agent !== opts.agent) continue;
    if (opts.phase !== undefined && entry.phase !== opts.phase) continue;
    if (opts.event && !entry.event.includes(opts.event)) continue;
    if (opts.since && entry.timestamp < opts.since) continue;
    if (opts.errors && entry.level !== 'error') continue;

    if (opts.raw) {
      console.log(line);
    } else {
      console.log(formatEntry(entry));
    }
  }
}
