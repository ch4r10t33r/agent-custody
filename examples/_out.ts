// Shared by the examples: a clean output directory under examples-out/<name>/ (gitignored).
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export function out(name: string): string {
  const dir = resolve(import.meta.dirname, "..", "examples-out", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);
