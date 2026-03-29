/**
 * Semaphore for limiting concurrent Claude API calls.
 * Default: 3 slots. Dynamically reduces to 1 when TPM threshold is hit.
 */
export class Semaphore {
  private slots: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(slots: number) {
    this.slots = slots;
  }

  setSlots(n: number): void {
    this.slots = n;
    // If capacity increased, drain the queue
    while (this.active < this.slots && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.active++;
        next();
      }
    }
  }

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.active < this.slots) {
          this.active++;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.active--;
    if (this.queue.length > 0 && this.active < this.slots) {
      const next = this.queue.shift();
      if (next) {
        this.active++;
        next();
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
    this.events.push({ time: Date.now(), tokens });
  }

  currentTpm(): number {
    const cutoff = Date.now() - this.windowMs;
    this.events = this.events.filter((e) => e.time >= cutoff);
    return this.events.reduce((sum, e) => sum + e.tokens, 0);
  }
}
