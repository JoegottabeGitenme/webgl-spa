/**
 * Tile Compositor
 * 
 * Stitches multiple weather data tiles into a single canvas/image.
 * Uses actual tile bboxes from server responses for accurate positioning.
 */

import type { CachedTile } from './TileCache';
import {
  type TileCoord,
  type BBox,
  type MercatorBBox,
  tileKey,
  lngToMercatorX,
  latToMercatorY,
} from './tile-utils';

export interface CompositeResult {
  /** Composited grayscale RGBA data */
  data: Uint8ClampedArray;
  /** Output width in pixels */
  width: number;
  /** Output height in pixels */
  height: number;
  /** Combined bounding box in WGS84 degrees */
  bbox: BBox;
}

export interface CompositorOptions {
  /** Maximum output dimension (width or height) - default 2048 */
  maxDimension?: number;
}

export class TileCompositor {
  private maxDimension: number;

  constructor(options: CompositorOptions = {}) {
    this.maxDimension = options.maxDimension ?? 2048;
  }

  /**
   * Composite multiple tiles into a single image.
   * Uses actual tile bboxes from server responses for accurate positioning.
   * 
   * @param tiles - Map of tile keys to cached tile data
   * @param tileCoords - List of tile coordinates being composited
   * @returns Composited result with grayscale data and metadata
   */
  composite(
    tiles: Map<string, CachedTile>,
    tileCoords: TileCoord[],
    collection: string,
    parameter: string,
    datetime?: string
  ): CompositeResult | null {
    if (tileCoords.length === 0 || tiles.size === 0) {
      return null;
    }

    // Collect actual tile data with their bboxes
    const tileDataList: Array<{ coord: TileCoord; tile: CachedTile; key: string }> = [];
    for (const coord of tileCoords) {
      const key = tileKey(coord, datetime, parameter, collection);
      const tile = tiles.get(key);
      if (tile) {
        tileDataList.push({ coord, tile, key });
      }
    }

    if (tileDataList.length === 0) {
      console.warn('TileCompositor: No tiles with data');
      return null;
    }

    // Calculate combined bbox from ACTUAL tile bboxes (from server responses)
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const { tile } of tileDataList) {
      const [tileWest, tileSouth, tileEast, tileNorth] = tile.bbox;
      west = Math.min(west, tileWest);
      south = Math.min(south, tileSouth);
      east = Math.max(east, tileEast);
      north = Math.max(north, tileNorth);
    }
    const combinedBbox: BBox = { west, south, east, north };

    console.log(`TileCompositor: Combined bbox from ${tileDataList.length} tiles: [${west.toFixed(4)}, ${south.toFixed(4)}, ${east.toFixed(4)}, ${north.toFixed(4)}]`);

    // Calculate output dimensions based on total geographic coverage and tile resolution
    // Use the first tile to estimate pixels per degree
    const sampleTile = tileDataList[0].tile;
    const [sampleWest, sampleSouth, sampleEast, sampleNorth] = sampleTile.bbox;
    const sampleDegWidth = sampleEast - sampleWest;
    const sampleDegHeight = sampleNorth - sampleSouth;
    
    // Pixels per degree (approximate, using geographic width)
    const pxPerDegX = sampleTile.width / sampleDegWidth;
    const pxPerDegY = sampleTile.height / sampleDegHeight;

    // Calculate output dimensions
    const totalDegWidth = east - west;
    const totalDegHeight = north - south;
    let outputWidth = Math.round(totalDegWidth * pxPerDegX);
    let outputHeight = Math.round(totalDegHeight * pxPerDegY);

    // Apply max dimension limit
    const maxDim = Math.max(outputWidth, outputHeight);
    if (maxDim > this.maxDimension) {
      const scale = this.maxDimension / maxDim;
      outputWidth = Math.round(outputWidth * scale);
      outputHeight = Math.round(outputHeight * scale);
    }

    // Ensure minimum dimensions
    outputWidth = Math.max(1, outputWidth);
    outputHeight = Math.max(1, outputHeight);

    console.log(`TileCompositor: Output dimensions ${outputWidth}x${outputHeight}, px/deg: ${pxPerDegX.toFixed(2)} x ${pxPerDegY.toFixed(2)}`);

    // Create output buffer
    const outputData = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    outputData.fill(0);

    // Place each tile into the output based on its ACTUAL bbox
    for (const { tile, key } of tileDataList) {
      const [tileWest, tileSouth, tileEast, tileNorth] = tile.bbox;

      // Calculate where this tile should be placed in the output
      // Position is based on geographic coordinates relative to combined bbox
      const destXStart = Math.round(((tileWest - west) / totalDegWidth) * outputWidth);
      const destYStart = Math.round(((north - tileNorth) / totalDegHeight) * outputHeight); // Y is flipped (north at top)
      const destXEnd = Math.round(((tileEast - west) / totalDegWidth) * outputWidth);
      const destYEnd = Math.round(((north - tileSouth) / totalDegHeight) * outputHeight);

      const destWidth = destXEnd - destXStart;
      const destHeight = destYEnd - destYStart;

      console.log(`TileCompositor: Placing tile ${key} at (${destXStart}, ${destYStart}) size ${destWidth}x${destHeight}`);

      // Blit tile data to output, scaling if necessary
      this.blitTile(
        tile.grayscaleData,
        tile.width,
        tile.height,
        outputData,
        outputWidth,
        outputHeight,
        destXStart,
        destYStart,
        destWidth,
        destHeight
      );
    }

    return {
      data: outputData,
      width: outputWidth,
      height: outputHeight,
      bbox: combinedBbox,
    };
  }

  /**
   * Copy tile data to the output buffer.
   * Handles scaling if tile dimensions don't match target slot size.
   */
  private blitTile(
    srcData: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    dstData: Uint8ClampedArray,
    dstTotalWidth: number,
    dstTotalHeight: number,
    dstX: number,
    dstY: number,
    slotWidth: number,
    slotHeight: number
  ): void {
    // Clamp slot to output bounds
    const startX = Math.max(0, dstX);
    const startY = Math.max(0, dstY);
    const endX = Math.min(dstTotalWidth, dstX + slotWidth);
    const endY = Math.min(dstTotalHeight, dstY + slotHeight);

    if (startX >= endX || startY >= endY) {
      return; // No overlap with output
    }

    for (let y = startY; y < endY; y++) {
      // Map output Y to source Y
      const srcYf = ((y - dstY) / slotHeight) * srcHeight;
      const srcY0 = Math.floor(srcYf);
      const srcY1 = Math.min(srcY0 + 1, srcHeight - 1);
      const yFrac = srcYf - srcY0;

      for (let x = startX; x < endX; x++) {
        // Map output X to source X
        const srcXf = ((x - dstX) / slotWidth) * srcWidth;
        const srcX0 = Math.floor(srcXf);
        const srcX1 = Math.min(srcX0 + 1, srcWidth - 1);
        const xFrac = srcXf - srcX0;

        // Bilinear interpolation
        const idx00 = (srcY0 * srcWidth + srcX0) * 4;
        const idx01 = (srcY0 * srcWidth + srcX1) * 4;
        const idx10 = (srcY1 * srcWidth + srcX0) * 4;
        const idx11 = (srcY1 * srcWidth + srcX1) * 4;

        const dstIdx = (y * dstTotalWidth + x) * 4;

        for (let c = 0; c < 4; c++) {
          const v00 = srcData[idx00 + c];
          const v01 = srcData[idx01 + c];
          const v10 = srcData[idx10 + c];
          const v11 = srcData[idx11 + c];

          const v0 = v00 * (1 - xFrac) + v01 * xFrac;
          const v1 = v10 * (1 - xFrac) + v11 * xFrac;
          const v = v0 * (1 - yFrac) + v1 * yFrac;

          dstData[dstIdx + c] = Math.round(v);
        }
      }
    }
  }
}

// Singleton compositor
let globalCompositor: TileCompositor | null = null;

export function getTileCompositor(): TileCompositor {
  if (!globalCompositor) {
    globalCompositor = new TileCompositor();
  }
  return globalCompositor;
}
