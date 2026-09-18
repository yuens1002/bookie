import crypto from "node:crypto";

/** Constant-time string comparison — hashes both inputs first so the comparison
 *  itself never leaks timing information proportional to a matching prefix. */
export function timingSafeEqual(a: string, b: string): boolean {
  const aDigest = crypto.createHash("sha256").update(a).digest();
  const bDigest = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(aDigest, bDigest);
}
