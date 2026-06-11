export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly takers: Array<(value: IteratorResult<T>) => void> = [];
  private readonly pushWaiters: Array<() => void> = [];
  private closed = false;
  private iteratorStarted = false;

  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error("Queue capacity must be at least 1");
    }
  }

  async push(item: T): Promise<void> {
    this.ensureOpen();

    while (this.items.length >= this.capacity) {
      // Result-only callers never iterate, so a full queue would park the
      // producer (and the backend turn loop behind it) forever: without a
      // consumer, evict the oldest event instead of blocking.
      if (!this.iteratorStarted) {
        this.items.shift();
        break;
      }
      await new Promise<void>((resolve) => this.pushWaiters.push(resolve));
      this.ensureOpen();
    }

    const taker = this.takers.shift();
    if (taker) {
      taker({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const resolve of this.pushWaiters) {
      resolve();
    }
    this.pushWaiters.length = 0;
    for (const taker of this.takers) {
      taker({ value: undefined, done: true });
    }
    this.takers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iteratorStarted) {
      throw new Error("Queue supports a single consumer");
    }

    this.iteratorStarted = true;

    return {
      next: () => this.next()
    };
  }

  private async next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      const waiter = this.pushWaiters.shift();
      waiter?.();
      return { value: item, done: false };
    }

    if (this.closed) {
      return { value: undefined, done: true };
    }

    return new Promise<IteratorResult<T>>((resolve) => this.takers.push(resolve));
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("Queue is closed");
    }
  }
}
