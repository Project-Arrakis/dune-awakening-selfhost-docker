import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function verifyPassword(password, stored) {
  if (String(stored).startsWith("scrypt$")) {
    const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored);
    if (!match) return false;
    const key = await derive(String(password || ""), match[1], 64, options);
    return timingSafeEqual(key, Buffer.from(match[2], "hex"));
  }

  const left = Buffer.from(String(password || ""));
  const right = Buffer.from(String(stored || ""));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
