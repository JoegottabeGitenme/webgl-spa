/**
 * XYZ Tile Math Utilities
 * 
 * Standard Web Mercator (EPSG:3857) tile scheme calculations.
 * Compatible with OSM/MapLibre tile coordinates.
 */

export interface TileCoord {
  x: number;
  y: number;
  z: number;
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MercatorBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Web Mercator constants
const EARTH_RADIUS = 6378137; // meters
const MAX_LATITUDE = 85.051129; // Max latitude for Web Mercator
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS; // ~20037508.34 meters

/**
 * Convert longitude to Web Mercator X (meters)
 */
export function lngToMercatorX(lng: number): number {
  return (lng * ORIGIN_SHIFT) / 180;
}

/**
 * Convert latitude to Web Mercator Y (meters)
 */
export function latToMercatorY(lat: number): number {
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const y = Math.log(Math.tan((90 + clampedLat) * Math.PI / 360)) / (Math.PI / 180);
  return (y * ORIGIN_SHIFT) / 180;
}

/**
 * Convert Web Mercator X (meters) to longitude
 */
export function mercatorXToLng(x: number): number {
  return (x * 180) / ORIGIN_SHIFT;
}

/**
 * Convert Web Mercator Y (meters) to latitude
 */
export function mercatorYToLat(y: number): number {
  const lat = (y * 180) / ORIGIN_SHIFT;
  return (Math.atan(Math.exp(lat * Math.PI / 180)) * 360) / Math.PI - 90;
}

/**
 * Convert tile coordinates to bounding box in WGS84 degrees.
 * Used for constructing the POLYGON in EDR AREA requests.
 */
export function tileToBboxWGS84(tile: TileCoord): BBox {
  const n = Math.pow(2, tile.z);
  
  // X: longitude is linear
  const west = (tile.x / n) * 360 - 180;
  const east = ((tile.x + 1) / n) * 360 - 180;
  
  // Y: latitude uses Mercator projection (Y=0 is north)
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * tile.y / n))) * 180 / Math.PI;
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 1) / n))) * 180 / Math.PI;
  
  return { west, south, east, north };
}

/**
 * Convert tile coordinates to bounding box in Web Mercator meters (EPSG:3857).
 * Used for pixel position calculations in compositor.
 */
export function tileToBboxMercator(tile: TileCoord): MercatorBBox {
  const bbox = tileToBboxWGS84(tile);
  return {
    minX: lngToMercatorX(bbox.west),
    minY: latToMercatorY(bbox.south),
    maxX: lngToMercatorX(bbox.east),
    maxY: latToMercatorY(bbox.north),
  };
}

/**
 * Get the tile coordinate containing a given lng/lat point at zoom level z.
 */
export function lngLatToTile(lng: number, lat: number, z: number): TileCoord {
  const n = Math.pow(2, z);
  
  // X from longitude
  const x = Math.floor(((lng + 180) / 360) * n);
  
  // Y from latitude (Mercator)
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
    z,
  };
}

/**
 * Get all tile coordinates that intersect with the given bounding box at zoom level z.
 */
export function getVisibleTiles(bbox: BBox, z: number): TileCoord[] {
  const n = Math.pow(2, z);
  
  // Clamp bbox to valid ranges
  const west = Math.max(-180, bbox.west);
  const east = Math.min(180, bbox.east);
  const south = Math.max(-MAX_LATITUDE, bbox.south);
  const north = Math.min(MAX_LATITUDE, bbox.north);
  
  // Get corner tiles
  const topLeft = lngLatToTile(west, north, z);
  const bottomRight = lngLatToTile(east, south, z);
  
  const tiles: TileCoord[] = [];
  
  // Iterate over tile grid
  for (let y = topLeft.y; y <= bottomRight.y; y++) {
    for (let x = topLeft.x; x <= bottomRight.x; x++) {
      // Handle wrap-around for x (longitude)
      const wrappedX = ((x % n) + n) % n;
      tiles.push({ x: wrappedX, y, z });
    }
  }
  
  return tiles;
}

/**
 * Convert map zoom to tile zoom level with offset.
 * Weather data doesn't need pixel-perfect detail, so we use coarser tiles.
 * 
 * @param mapZoom - Current map zoom level
 * @param offset - Zoom level offset (default 3, meaning tile zoom = map zoom - 3)
 * @param minZoom - Minimum tile zoom (default 0)
 * @param maxZoom - Maximum tile zoom (default 10)
 */
export function mapZoomToTileZoom(
  mapZoom: number,
  offset: number = 3,
  minZoom: number = 0,
  maxZoom: number = 10
): number {
  const tileZoom = Math.floor(mapZoom) - offset;
  return Math.max(minZoom, Math.min(maxZoom, tileZoom));
}

/**
 * Generate a unique cache key for a tile.
 */
export function tileKey(
  tile: TileCoord,
  datetime?: string,
  parameter?: string,
  collection?: string
): string {
  const parts = [`${tile.z}/${tile.x}/${tile.y}`];
  if (collection) parts.push(collection);
  if (parameter) parts.push(parameter);
  if (datetime) parts.push(datetime);
  return parts.join('/');
}

/**
 * Calculate the combined bounding box of multiple tiles in WGS84.
 */
export function tilesCombinedBbox(tiles: TileCoord[]): BBox {
  if (tiles.length === 0) {
    throw new Error('Cannot calculate bbox of empty tile list');
  }
  
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  
  for (const tile of tiles) {
    const bbox = tileToBboxWGS84(tile);
    west = Math.min(west, bbox.west);
    south = Math.min(south, bbox.south);
    east = Math.max(east, bbox.east);
    north = Math.max(north, bbox.north);
  }
  
  return { west, south, east, north };
}

/**
 * Calculate the combined bounding box of multiple tiles in Mercator meters.
 */
export function tilesCombinedBboxMercator(tiles: TileCoord[]): MercatorBBox {
  if (tiles.length === 0) {
    throw new Error('Cannot calculate bbox of empty tile list');
  }
  
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  
  for (const tile of tiles) {
    const bbox = tileToBboxMercator(tile);
    minX = Math.min(minX, bbox.minX);
    minY = Math.min(minY, bbox.minY);
    maxX = Math.max(maxX, bbox.maxX);
    maxY = Math.max(maxY, bbox.maxY);
  }
  
  return { minX, minY, maxX, maxY };
}

/**
 * Get tile dimensions at a given zoom level.
 * All tiles at the same zoom have the same Mercator dimensions.
 */
export function getTileMercatorSize(z: number): number {
  // Full Mercator extent is 2 * ORIGIN_SHIFT in each dimension
  // At zoom z, there are 2^z tiles in each dimension
  return (2 * ORIGIN_SHIFT) / Math.pow(2, z);
}
