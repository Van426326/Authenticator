const permitBrand: unique symbol = Symbol("AsyncMutexPermit");

export interface AsyncMutexPermit {
  readonly [permitBrand]: true;
}

function createPermit(): AsyncMutexPermit {
  return { [permitBrand]: true };
}

export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();
  private activePermit?: AsyncMutexPermit;

  runExclusive<T>(
    operation: (permit: AsyncMutexPermit) => Promise<T>,
    permit?: AsyncMutexPermit
  ): Promise<T> {
    if (permit && permit === this.activePermit) {
      return operation(permit);
    }

    const execute = async () => {
      const nextPermit = createPermit();
      this.activePermit = nextPermit;
      try {
        return await operation(nextPermit);
      } finally {
        this.activePermit = undefined;
      }
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export const accountWriteMutex = new AsyncMutex();
