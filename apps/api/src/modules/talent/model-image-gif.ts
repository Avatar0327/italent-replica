/** GIF 解码器会补齐缺失像素；先验证 LZW 字典、像素数量与终止码，再交给图像库解码。 */
export function completeGifPixels(data: Buffer, minimum: number, expected: number, colors: number): boolean {
  const clear = 1 << minimum;
  const end = clear + 1;
  const lengths = new Uint32Array(4096);
  lengths.fill(1, 0, clear);
  let next = end + 1;
  let size = minimum + 1;
  let previous = -1;
  let count = 0;
  let bit = 0;
  while (bit + size <= data.length * 8) {
    let code = 0;
    for (let index = 0; index < size; index += 1) {
      code |= ((data[(bit + index) >>> 3]! >>> ((bit + index) & 7)) & 1) << index;
    }
    bit += size;
    if (code === clear) {
      next = end + 1;
      size = minimum + 1;
      previous = -1;
      continue;
    }
    if (code === end) return count === expected;
    let length: number;
    if (code < clear) {
      if (code >= colors) return false;
      length = 1;
    } else if (previous >= 0 && code < next) {
      length = lengths[code]!;
    } else if (previous >= 0 && code === next) {
      length = lengths[previous]! + 1;
    } else return false;
    count += length;
    if (!length || count > expected) return false;
    if (previous >= 0 && next < 4096) {
      lengths[next++] = lengths[previous]! + 1;
      if (next === 1 << size && size < 12) size += 1;
    }
    previous = code;
  }
  return false;
}
