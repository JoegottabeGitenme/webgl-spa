/**
 * In-Memory Tile Cache
 * 
 * Caches fetched weather data tiles with LRU eviction.
 * Tiles are keyed by z/x/y/collection/parameter/datetime.
 */

import { tileKey, type TileCoord } from './tile-utils';

export interface CachedTile {
  /** Grayscale RGBA data (R=G=B=value, A=255) */
  grayscaleData: Uint8ClampedArray;
  /** Image width in pixels */
  width: number;
  /** Image height in pixels */
  height: number;
  /** Actual bounding box from server response (WGS84 degrees) */
  bbox: [number, number, number, number]; // [west, south, east, north]
  /** Data min value from server */
  dataMin: number;
  /** Data max value from server */
  dataMax: number;
  /** Data units from server */
  units: string;
  /** Timestamp when tile was fetched */
  fetchedAt: number;
  /** Last access timestamp (for LRU) */
  lastAccess: number;
}

export interface TileCacheStats {
  size: number;
  maxSize: number;
  hitRate: number;
  keys: string[];
}

export class TileCache {
  private cache = new Map<string, CachedTile>();
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize: number = 200) {
    this.maxSize = maxSize;
  }

  /**
   * Get a tile from the cache.
   * Updates last access time for LRU.
   */
  get(key: string): CachedTile | undefined {
    const tile = this.cache.get(key);
    if (tile) {
      this.hits++;
      tile.lastAccess = Date.now();
      return tile;
    }
    this.misses++;
    return undefined;
  }

  /**
   * Get a tile by coordinates and metadata.
   */
  getByCoord(
    tile: TileCoord,
    collection: string,
    parameter: string,
    datetime?: string
  ): CachedTile | undefined {
    const key = tileKey(tile, datetime, parameter, collection);
    return this.get(key);
  }

  /**
   * Check if a tile is in the cache.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Check if a tile is in the cache by coordinates.
   */
  hasByCoord(
    tile: TileCoord,
    collection: string,
    parameter: string,
    datetime?: string
  ): boolean {
    const key = tileKey(tile, datetime, parameter, collection);
    return this.has(key);
  }

  /**
   * Add a tile to the cache.
   * Evicts oldest tiles if cache is full.
   */
  set(key: string, tile: CachedTile): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    tile.lastAccess = Date.now();
    this.cache.set(key, tile);
  }

  /**
   * Add a tile to the cache by coordinates.
   */
  setByCoord(
    tileCoord: TileCoord,
    collection: string,
    parameter: string,
    datetime: string | undefined,
    tile: CachedTile
  ): void {
    const key = tileKey(tileCoord, datetime, parameter, collection);
    this.set(key, tile);
  }

  /**
   * Remove a tile from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all tiles for a specific datetime.
   * Useful for animation frame cleanup.
   */
  clearDatetime(datetime: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(datetime)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Clear all tiles for a specific parameter.
   */
  clearParameter(parameter: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(`/${parameter}/`) || key.endsWith(`/${parameter}`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Evict the least recently used tile.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, tile] of this.cache.entries()) {
      if (tile.lastAccess < oldestTime) {
        oldestTime = tile.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): TileCacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Get all cached tiles matching a filter.
   */
  getMatchingTiles(
    filter: {
      collection?: string;
      parameter?: string;
      datetime?: string;
      z?: number;
    }
  ): Map<string, CachedTile> {
    const result = new Map<string, CachedTile>();

    for (const [key, tile] of this.cache.entries()) {
      let matches = true;

      if (filter.collection && !key.includes(filter.collection)) {
        matches = false;
      }
      if (filter.parameter && !key.includes(filter.parameter)) {
        matches = false;
      }
      if (filter.datetime && !key.includes(filter.datetime)) {
        matches = false;
      }
      if (filter.z !== undefined) {
        const zMatch = key.match(/^(\d+)\//);
        if (!zMatch || parseInt(zMatch[1]) !== filter.z) {
          matches = false;
        }
      }

      if (matches) {
        result.set(key, tile);
      }
    }

    return result;
  }
}

// Singleton instance for the application
let globalTileCache: TileCache | null = null;

export function getTileCache(): TileCache {
  if (!globalTileCache) {
    globalTileCache = new TileCache(200);
  }
  return globalTileCache;
}
