/** True when `err` is a Prisma known-request error with the given code. */
export function isPrismaCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === code
  );
}
