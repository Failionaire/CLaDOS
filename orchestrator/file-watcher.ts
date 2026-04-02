/**
 * IDE Bridge — File Watcher
 *
 * Watches `.clados/wip/` and the project `src/` directory for external changes.
 * Debounces events and emits a notification via the broadcast callback.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileChangeEvent {
  type: 'external_file_change';
  files: string[];
  timestamp: string;
}

export interface FileWatcherOptions {
  projectDir: string;
  onExternalChange: (event: FileChangeEvent) => void;
  debounceMs?: number;
}

export class FileWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pendingFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private onExternalChange: (event: FileChangeEvent) => void;

  constructor(options: FileWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.onExternalChange = options.onExternalChange;

    const watchDirs = [
      path.join(options.projectDir, '.clados', 'wip'),
      path.join(options.projectDir, 'src'),
    ];

    for (const dir of watchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
          if (filename) {
            this.handleChange(path.join(dir, filename));
          }
        });
        this.watchers.push(watcher);
      } catch {
        // Directory may not be watchable on all platforms
      }
    }
  }

  private handleChange(filePath: string): void {
    this.pendingFiles.add(filePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      const files = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      this.debounceTimer = null;

      this.onExternalChange({
        type: 'external_file_change',
        files,
        timestamp: new Date().toISOString(),
      });
    }, this.debounceMs);
  }

  close(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

/**
 * Build a deep-link URI for opening a file at a specific line in the IDE.
 *
 * @param filePath - Absolute file path
 * @param line - Line number (1-based)
 * @param scheme - URI scheme, e.g. 'vscode' or 'cursor'
 */
export function buildEditorDeepLink(filePath: string, line?: number, scheme = 'vscode'): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (line != null) {
    return `${scheme}://file/${normalizedPath}:${line}`;
  }
  return `${scheme}://file/${normalizedPath}`;
}
