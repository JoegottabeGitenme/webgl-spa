/**
 * Wind Data Fetching and Processing
 *
 * Fetches U (east-west) and V (north-south) wind components from the EDR API
 * and combines them into a format suitable for particle animation.
 */

import { fetchDataTile, type TileMetadata, type FetchTileOptions } from '../data/edr-client';

export interface WindData {
  /** U-component (east-west) velocity field as ImageData */
  uField: ImageData;
  /** V-component (north-south) velocity field as ImageData */
  vField: ImageData;
  /** Metadata for U-component (includes min/max for decoding) */
  uMetadata: TileMetadata;
  /** Metadata for V-component (includes min/max for decoding) */
  vMetadata: TileMetadata;
  /** Image dimensions */
  width: number;
  height: number;
}

export interface WindFieldOptions extends Omit<FetchTileOptions, 'parameter'> {
  /** Resolution for wind field (default: 512x256 for performance) */
  width?: number;
  height?: number;
}

/**
 * Extract ImageData from an HTMLImageElement using canvas
 */
function imageToImageData(image: HTMLImageElement): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Fetch wind data (UGRD and VGRD) from the EDR API
 *
 * @param options - Fetch options (dimensions, bbox, etc.)
 * @returns WindData with U and V velocity fields
 */
export async function fetchWindData(options: WindFieldOptions = {}): Promise<WindData> {
  const width = options.width ?? 512;
  const height = options.height ?? 256;

  // Fetch U and V components in parallel
  const [uTile, vTile] = await Promise.all([
    fetchDataTile({ ...options, parameter: 'UGRD', width, height }),
    fetchDataTile({ ...options, parameter: 'VGRD', width, height }),
  ]);

  // Convert images to ImageData for pixel access
  const uField = imageToImageData(uTile.image);
  const vField = imageToImageData(vTile.image);

  return {
    uField,
    vField,
    uMetadata: uTile.metadata,
    vMetadata: vTile.metadata,
    width,
    height,
  };
}

/**
 * Decode a pixel value to actual wind velocity (m/s)
 */
export function decodeWindValue(pixelValue: number, min: number, max: number): number {
  return (pixelValue / 255) * (max - min) + min;
}

/**
 * Sample wind velocity at a normalized position (0-1, 0-1)
 * Uses bilinear interpolation for smooth particle movement
 *
 * @param windData - Wind field data
 * @param nx - Normalized x position (0-1, where 0=west, 1=east)
 * @param ny - Normalized y position (0-1, where 0=north, 1=south)
 * @returns [u, v] velocity in m/s
 */
export function sampleWind(
  windData: WindData,
  nx: number,
  ny: number
): [number, number] {
  const { uField, vField, uMetadata, vMetadata, width, height } = windData;

  // Clamp to valid range
  nx = Math.max(0, Math.min(1, nx));
  ny = Math.max(0, Math.min(1, ny));

  // Convert to pixel coordinates
  const x = nx * (width - 1);
  const y = ny * (height - 1);

  // Get integer and fractional parts for bilinear interpolation
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  // Sample U component at 4 corners
  const u00 = uField.data[(y0 * width + x0) * 4];
  const u10 = uField.data[(y0 * width + x1) * 4];
  const u01 = uField.data[(y1 * width + x0) * 4];
  const u11 = uField.data[(y1 * width + x1) * 4];

  // Sample V component at 4 corners
  const v00 = vField.data[(y0 * width + x0) * 4];
  const v10 = vField.data[(y0 * width + x1) * 4];
  const v01 = vField.data[(y1 * width + x0) * 4];
  const v11 = vField.data[(y1 * width + x1) * 4];

  // Bilinear interpolation
  const uPixel = (u00 * (1 - fx) * (1 - fy) +
                  u10 * fx * (1 - fy) +
                  u01 * (1 - fx) * fy +
                  u11 * fx * fy);

  const vPixel = (v00 * (1 - fx) * (1 - fy) +
                  v10 * fx * (1 - fy) +
                  v01 * (1 - fx) * fy +
                  v11 * fx * fy);

  // Decode to actual velocities
  const u = decodeWindValue(uPixel, uMetadata.min, uMetadata.max);
  const v = decodeWindValue(vPixel, vMetadata.min, vMetadata.max);

  return [u, v];
}

/**
 * Calculate wind magnitude from U and V components
 */
export function windMagnitude(u: number, v: number): number {
  return Math.sqrt(u * u + v * v);
}

/**
 * Calculate wind direction in degrees (meteorological convention: 0=N, 90=E)
 */
export function windDirection(u: number, v: number): number {
  // Math.atan2 gives angle from positive x-axis, counter-clockwise
  // We want meteorological direction (where wind comes FROM)
  const rad = Math.atan2(-u, -v);
  let deg = (rad * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}
