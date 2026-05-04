export type QueuePriority = "now" | "next" | "later";

export type QueuedCommand<T> = {
  id: string;
  value: T;
  priority: QueuePriority;
  created_at: string;
};

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2
};

export class CommandQueue<T> {
  private readonly items: QueuedCommand<T>[] = [];

  enqueue(input: { id: string; value: T; priority?: QueuePriority }): QueuedCommand<T> {
    const command: QueuedCommand<T> = {
      id: input.id,
      value: input.value,
      priority: input.priority ?? "next",
      created_at: new Date().toISOString()
    };
    this.items.push(command);
    return command;
  }

  dequeue(filter?: (command: QueuedCommand<T>) => boolean): QueuedCommand<T> | undefined {
    let bestIndex = -1;
    let bestPriority = Infinity;
    for (let index = 0; index < this.items.length; index += 1) {
      const item = this.items[index];
      if (!item || (filter && !filter(item))) {
        continue;
      }
      const priority = PRIORITY_ORDER[item.priority];
      if (priority < bestPriority) {
        bestPriority = priority;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) {
      return undefined;
    }
    const [item] = this.items.splice(bestIndex, 1);
    return item;
  }

  snapshot(): readonly QueuedCommand<T>[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }
}
