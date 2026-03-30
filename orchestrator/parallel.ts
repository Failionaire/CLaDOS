/**
 * Semaphore for limiting concurrent Claude API calls.
 * Default: 3 slots. Dynamically reduces to 1 when TPM threshold is hit.
 */
export class Semaphore {
  private slots: number;
  private active = 0;
  private queue: Array<{ tryAcquire: () => void; reject: (e: Error) => void }> = [];

  constructor(slots = 3) {
    this.slots = slots;
  }

  setSlots(n: number): void {
    if (n < 1) throw new RangeError(`Semaphore slots must be >= 1, got ${n}`);
    this.slots = n;
    // If capacity increased, drain the queue
    while (this.active < this.slots && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next.tryAcquire();
      }
    }
  }

  async acquire(): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const tryAcquire = () => {
        if (this.active < this.slots) {
          this.active++;
          resolve(() => this.release());
        } else {
          this.queue.push({ tryAcquire, reject });
        }
      };
      tryAcquire();
    });
  }

  /** Acquire the lock and release it automatically when fn resolves or throws. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Reject all queued acquires with the given reason (e.g. on pipeline abort). */
  drain(reason: Error): void {
    const pending = this.queue.splice(0);
    for (const { reject } of pending) {
      reject(reason);
    }
  }

  private release(): void {
    if (this.active <= 0) return; // guard against double-release
    this.active--;
    if (this.queue.length > 0 && this.active < this.slots) {
      const next = this.queue.shift();
      if (next) {
        next.tryAcquire();
      }
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }
}

/**
 * Rolling window token-per-minute tracker.
 * The Conductor uses this to throttle before hitting 429s.
 */
export class RollingTpmTracker {
  private events: Array<{ time: number; tokens: number }> = [];
  private readonly windowMs = 60_000;

  record(tokens: number): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.events = this.events.filter((e) => e.time >= cutoff);
    this.events.push({ time: now, tokens });
  }

  currentTpm(): number {
    const cutoff = Date.now() - this.windowMs;
    this.events = this.events.filter((e) => e.time >= cutoff);
    return this.events.reduce((sum, e) => sum + e.tokens, 0);
  }
}
