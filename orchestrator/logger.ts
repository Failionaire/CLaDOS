import fs from 'fs';
import path from 'path';
import type { LogLevel, LogEntry } from './types.js';

const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Narrow interface returned by Logger.child() — safe for concurrent use. */
export type ChildLogger = Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;

export class Logger {
  private logPath: string;
  private phase: number | null = null;
  private agent: string | null = null;

  constructor(projectDir: string) {
    const logDir = path.join(projectDir, '.clados');
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, 'run.log');
  }

  /** Sets context for subsequent calls on this root logger. Not safe for concurrent use — prefer child(). */
  setContext(phase: number | null, agent: string | null): void {
    this.phase = phase;
    this.agent = agent;
  }

  /**
   * Returns a bound logger with fixed phase and agent context.
   * Each parallel agent should use its own child — never share setContext across concurrent tasks.
   */
  child(phase: number, agent: string): ChildLogger {
    return {
      info: (event, message, data?) => this.writeEntry('info', event, message, data, phase, agent),
      warn: (event, message, data?) => this.writeEntry('warn', event, message, data, phase, agent),
      error: (event, message, data?) => this.writeEntry('error', event, message, data, phase, agent),
      debug: (event, message, data?) => this.writeEntry('debug', event, message, data, phase, agent),
    };
  }

  info(event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry('info', event, message, data, this.phase, this.agent);
  }

  warn(event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry('warn', event, message, data, this.phase, this.agent);
  }

  error(event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry('error', event, message, data, this.phase, this.agent);
  }

  debug(event: string, message: string, data?: Record<string, unknown>): void {
    this.writeEntry('debug', event, message, data, this.phase, this.agent);
  }

  private writeEntry(level: LogLevel, event: string, message: string, data: Record<string, unknown> | undefined, phase: number | null, agent: string | null): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      phase,
      agent,
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
        const ts = Date.now();
        let dest = this.logPath.replace(/\.log$/, `.${ts}.log`);
        let counter = 0;
        while (fs.existsSync(dest)) {
          dest = this.logPath.replace(/\.log$/, `.${ts}.${++counter}.log`);
        }
        fs.renameSync(this.logPath, dest);
      }
    } catch {
      // File may not exist yet — that's fine
    }
  }
}
