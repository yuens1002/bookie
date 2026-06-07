import { randomUUID } from "node:crypto";

/** Short, prefixed, grep-friendly id, e.g. `acc_1a2b3c4d`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
