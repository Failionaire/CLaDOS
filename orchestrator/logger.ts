import fs from 'fs';
import path from 'path';
import type { LogLevel, LogEntry } from './types.js';

const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

export class Logger {
  private logPath: string;
  private phase: number | null = null;
  private agent: string | null = null;

  constructor(projectDir: string) {
    this.logPath = path.join(projectDir, '.clados', 'run.log');
  }

  setContext(phase: number | null, agent: string | null): void {
    this.phase = phase;
    this.agent = agent;
  }

  info(event: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', event, message, data);
  }

  warn(event: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', event, message, data);
  }

  error(event: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', event, message, data);
  }

  debug(event: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', event, message, data);
  }

  private write(level: LogLevel, event: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      phase: this.phase,
      agent: this.agent,
      event,
      message,
      ...(data !== undefined && { data }),
    };

    const line = JSON.stringify(entry) + '\n';

    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logPath, line, 'utf-8');
    } catch {
      // Log write failures must never crash the pipeline
    }

    if (level === 'error' || level === 'warn') {
      process.stderr.write(`[CLaDOS ${level.toUpperCase()}] ${message}\n`);
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size >= LOG_ROTATE_BYTES) {
        const rotatedPath = this.logPath.replace('.log', `.${Date.now()}.log`);
        fs.renameSync(this.logPath, rotatedPath);
      }
    } catch {
      // File may not exist yet — that's fine
    }
  }
}
