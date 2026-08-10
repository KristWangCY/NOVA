import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function atomicWriteJson(path, value) {
  const target = resolve(path);
  const temporary = resolve(dirname(target), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}
