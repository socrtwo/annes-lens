/**
 * Size checks for RAW sensor data, made before anything is allocated or looped over. A header can claim any size; what
 * the file actually holds bounds it.
 */

/** The most samples read from one file. The largest sensors made are about 150 megapixels; a larger size comes from a damaged or crafted header. */
export const MAX_RAW_SAMPLES = 400_000_000;

/**
 * Checks a sensor size from a header: whole and positive, within MAX_RAW_SAMPLES, and, when `bytes` is given, no more
 * samples than that much data can hold at `minBits` bits each (the coding's lowest cost per sample: the bit depth when
 * uncompressed, one bit for the Huffman codings). Returns the number of samples.
 */
export function checkSensor(what: string, width: number, height: number, samples = 1, bytes?: number, minBits = 1): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`${what}: the sensor size ${width}×${height} is not valid`);
  const count = width * height * samples;
  if (count > MAX_RAW_SAMPLES) throw new Error(`${what}: a ${width}×${height} sensor is larger than this module reads`);
  if (bytes !== undefined && bytes * 8 < count * minBits) throw new Error(`${what}: ${bytes} bytes of sensor data are too few for ${width}×${height} (the file is cut short, or its header is wrong)`);
  return count;
}
