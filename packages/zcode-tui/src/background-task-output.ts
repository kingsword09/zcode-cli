import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface BackgroundTaskOutput {
  text: string;
  truncated: boolean;
}

const defaultMaximumBytes = 64 * 1024;

export function readBackgroundTaskOutput(
  path: string,
  maximumBytes = defaultMaximumBytes
): BackgroundTaskOutput | undefined {
  if (!path || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0) return undefined;
    const byteCount = Math.min(metadata.size, maximumBytes);
    const position = metadata.size - byteCount;
    const buffer = Buffer.allocUnsafe(byteCount);
    let bytesRead = 0;
    while (bytesRead < byteCount) {
      const count = readSync(descriptor, buffer, bytesRead, byteCount - bytesRead, position + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    let start = 0;
    while (start < Math.min(bytesRead, 3) && (buffer[start]! & 0xc0) === 0x80) start += 1;
    const text = buffer.subarray(start, bytesRead).toString("utf8").trim();
    return text ? { text, truncated: position > 0 } : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
