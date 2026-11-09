import { EventEmitter } from 'events';

export class LruCache<V> {
  private items: Map<string, V> = new Map();
  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const v = this.items.get(key);
    if (v !== undefined) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    if (this.items.size >= this.capacity && !this.items.has(key)) {
      const oldest = this.items.keys().next().value;
      this.items.delete(oldest as string);
    }
    this.items.set(key, value);
  }
}

export const fetchAll = async (urls: string[]): Promise<number> => {
  let total = 0;
  for (let i = 0; i < urls.length; i++) {
    total += await fetchOne(urls[i]);
  }
  return total;
};

function fetchOne(u: string): Promise<number> {
  return Promise.resolve(u.length);
}
