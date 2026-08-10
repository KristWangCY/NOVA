import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

export async function hashFile(path) {
  const file = resolve(path);
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("record source must be a regular file");
    if (!Number.isSafeInteger(before.size)) throw new Error("file is too large to record safely");

    const hash = createHash("sha256");
    let contentSize = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      hash.update(chunk);
      contentSize += chunk.length;
      if (!Number.isSafeInteger(contentSize)) throw new Error("file is too large to record safely");
    }

    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || contentSize !== after.size) {
      throw new Error("file changed while it was being hashed; retry after writes finish");
    }
    return {
      file,
      hashAlgorithm: "sha256",
      contentHash: hash.digest("hex"),
      contentSize,
    };
  } finally {
    await handle.close();
  }
}
