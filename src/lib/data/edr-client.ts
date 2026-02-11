/**
 * EDR (Environmental Data Retrieval) API Client
 *
 * Fetches weather data PNG tiles from the folkweather.com EDR API.
 * PNG tiles encode weather values as grayscale pixels (0-255) that
 * map to a min/max range specified in response headers.
 */

import { getEdrBaseUrl, getAuthHeaders, getEdrDepth } from './edr-config';
import { 
  type TileCoord, 
  tileToBboxWGS84, 
  tileKey as makeTileKey 
} from '../tiles/tile-utils';
import { type CachedTile, type TileCache } from '../tiles/TileCache';
import { renormalizeToGlobalScale } from '../tiles/parameter-scales';

// Re-export config functions for convenience
export { getEdrBaseUrl, setEdrBaseUrl, getEdrApiKey, setEdrApiKey, getDefaultEdrUrl, getEdrDepth, setEdrDepth, getDefaultDepth } from './edr-config';

// TODO: Make bounding box configurable via parameters
const DEFAULT_BBOX = {
  west: -125,
  south: 24,
  east: -66,
  north: 50,
} as const;

// Dynamic getter for EDR base URL (for backward compatibility)
export const EDR_BASE_URL = "https://folkweather.com"; // Legacy, use getEdrBaseUrl() instead

/**
 * Helper to make authenticated fetch requests
 */
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = {
    ...getAuthHeaders(),
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

// Temporal interpolation configuration
// The EDR API now supports server-side interpolation with these parameters
export const INTERPOLATION_CONFIG = {
  stepMinutes: 10,  // Time step for interpolated data (PT10M)
  method: 'linear' as const,  // Interpolation method: 'linear' | 'nearest' | 'none'
  maxTimeSteps: 350,  // API limit for time steps per request
  chunkHours: 6,  // Hours per chunk (6 hours * 6 steps/hour = 36 steps, well under limit)
};

/**
 * CoverageJSON response type for EDR API.
 * Used for type-safe access to weather data responses.
 */
interface CoverageJSONResponse {
  type?: string;
  domain?: {
    type?: string;
    domainType?: string;
    axes?: {
      t?: { values?: string[] };
      x?: { values?: number[] };
      y?: { values?: number[] };
    };
  };
  ranges?: Record<string, {
    type?: string;
    dataType?: string;
    values?: number[];
    shape?: number[];
  }>;
}

/**
 * Split a time range into chunks to avoid exceeding API time step limits.
 * The API has a limit of 350 time steps per request. With 10-minute intervals,
 * that's about 58 hours. We use 6-hour chunks to be safe.
 * 
 * @param startTime - ISO 8601 start time
 * @param endTime - ISO 8601 end time
 * @returns Array of [chunkStart, chunkEnd] tuples
 */
function splitTimeRangeIntoChunks(startTime: string, endTime: string): [string, string][] {
  const chunks: [string, string][] = [];
  const start = new Date(startTime);
  const end = new Date(endTime);
  const chunkMs = INTERPOLATION_CONFIG.chunkHours * 60 * 60 * 1000;
  
  let chunkStart = start;
  while (chunkStart < end) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + chunkMs, end.getTime()));
    chunks.push([chunkStart.toISOString(), chunkEnd.toISOString()]);
    chunkStart = chunkEnd;
  }
  
  return chunks;
}

/**
 * Merge CoverageJSON responses from multiple chunks.
 * Concatenates timestamp arrays and value arrays from each chunk.
 * 
 * @param responses - Array of CoverageJSON response objects
 * @returns Merged response with all timestamps and values
 */
function mergeCoverageJSONResponses(responses: CoverageJSONResponse[]): CoverageJSONResponse {
  if (responses.length === 0) return {};
  if (responses.length === 1) return responses[0];
  
  // Start with a deep copy of the first response structure
  const merged: CoverageJSONResponse = JSON.parse(JSON.stringify(responses[0]));
  
  // Merge timestamps
  if (merged.domain?.axes?.t?.values) {
    for (let i = 1; i < responses.length; i++) {
      const respT = responses[i].domain?.axes?.t?.values;
      if (respT) {
        merged.domain.axes.t.values = merged.domain.axes.t.values.concat(respT);
      }
    }
  }
  
  // Merge range values for each parameter
  if (merged.ranges) {
    for (const paramName of Object.keys(merged.ranges)) {
      const param = merged.ranges[paramName];
      if (param?.values) {
        for (let i = 1; i < responses.length; i++) {
          const respParam = responses[i].ranges?.[paramName];
          if (respParam?.values) {
            param.values = param.values.concat(respParam.values);
          }
        }
        // Update shape if present
        if (param.shape) {
          param.shape = [param.values.length];
        }
      }
    }
  }
  
  return merged;
}

/**
 * Fetch CoverageJSON data with automatic chunking for large time ranges.
 * Splits requests into 6-hour chunks and merges responses.
 * 
 * @param url - Base URL for the EDR position endpoint
 * @param params - Query parameters (must include datetime as 'START/END' format)
 * @returns Merged CoverageJSON response
 */
async function fetchWithChunking(
  url: string,
  params: Record<string, string>
): Promise<CoverageJSONResponse> {
  const datetimeParam = params.datetime;
  if (!datetimeParam || !datetimeParam.includes('/')) {
    // No time range, just fetch directly
    const response = await authFetch(`${url}?` + new URLSearchParams(params));
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json() as Promise<CoverageJSONResponse>;
  }

  const [startTime, endTime] = datetimeParam.split('/');
  const chunks = splitTimeRangeIntoChunks(startTime, endTime);

  // If only one chunk, fetch directly
  if (chunks.length === 1) {
    const response = await authFetch(`${url}?` + new URLSearchParams(params));
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return response.json() as Promise<CoverageJSONResponse>;
  }

  // Fetch all chunks in parallel
  const chunkPromises = chunks.map(async ([chunkStart, chunkEnd]) => {
    const chunkParams = { ...params, datetime: `${chunkStart}/${chunkEnd}` };
    const response = await authFetch(`${url}?` + new URLSearchParams(chunkParams));
    if (!response.ok) {
      throw new Error(`Chunk request failed: ${response.status} for ${chunkStart}/${chunkEnd}`);
    }
    return response.json() as Promise<CoverageJSONResponse>;
  });

  const responses = await Promise.all(chunkPromises);
  return mergeCoverageJSONResponses(responses);
}

// ============================================================================
// Model Run Time Detection & Formatting
// ============================================================================

/**
 * Cache for model run times to avoid repeated API calls.
 * Key is the collection ID (e.g., 'hrrr-height-agl'), value is the ISO timestamp.
 * Cached for the session duration.
 */
const modelRunCache: Map<string, string | null> = new Map();

/**
 * Fetch the latest model run time for a collection.
 * Results are cached for the session.
 * 
 * @param collection - Collection ID (e.g., 'hrrr-height-agl', 'gfs-height-agl')
 * @returns ISO 8601 timestamp of the latest model run, or null if unavailable
 */
export async function getLatestModelRun(collection: string): Promise<string | null> {
  // Check cache first
  if (modelRunCache.has(collection)) {
    return modelRunCache.get(collection) ?? null;
  }
  
  try {
    const response = await authFetch(`${getEdrBaseUrl()}/edr/collections/${collection}/instances`);
    if (!response.ok) {
      console.warn(`Failed to fetch instances for ${collection}: ${response.status}`);
      modelRunCache.set(collection, null);
      return null;
    }
    
    const data = await response.json();
    // First instance in the list is the most recent
    const latestRun = data.instances?.[0]?.id ?? null;
    
    modelRunCache.set(collection, latestRun);
    return latestRun;
  } catch (error) {
    console.warn(`Failed to fetch latest run for ${collection}:`, error);
    modelRunCache.set(collection, null);
    return null;
  }
}

/**
 * Clear the model run cache (useful for forcing a refresh)
 */
export function clearModelRunCache(): void {
  modelRunCache.clear();
}

/**
 * Calculate forecast lead time in hours.
 * 
 * @param modelRunTime - ISO 8601 model initialization time
 * @param validTime - ISO 8601 forecast valid time
 * @returns Hours from model run to valid time
 */
export function calculateForecastLeadHours(modelRunTime: string, validTime: string): number {
  const runDate = new Date(modelRunTime);
  const validDate = new Date(validTime);
  return (validDate.getTime() - runDate.getTime()) / (1000 * 60 * 60);
}

/**
 * Format model run info compactly: "1/14 16Z • +22:20h • in 20h"
 * Returns null if model run time is not available.
 * 
 * @param modelRunTime - ISO 8601 model initialization time
 * @param validTime - ISO 8601 forecast valid time
 * @returns Formatted string or null
 */
export function formatModelRunInfo(
  modelRunTime: string | undefined,
  validTime: string
): string | null {
  if (!modelRunTime) return null;
  
  const runDate = new Date(modelRunTime);
  const validDate = new Date(validTime);
  const now = new Date();
  
  // Format date as M/D (e.g., "1/14")
  const month = runDate.getUTCMonth() + 1;
  const day = runDate.getUTCDate();
  const dateStr = `${month}/${day}`;
  
  // Model run cycle (e.g., "16Z")
  const cycle = `${runDate.getUTCHours().toString().padStart(2, '0')}Z`;
  
  // Forecast lead time
  const leadHours = (validDate.getTime() - runDate.getTime()) / (1000 * 60 * 60);
  const leadH = Math.floor(leadHours);
  const leadM = Math.round((leadHours - leadH) * 60);
  const leadStr = leadM > 0 ? `+${leadH}:${leadM.toString().padStart(2, '0')}h` : `+${leadH}h`;
  
  // Relative time from now
  const diffMs = validDate.getTime() - now.getTime();
  const diffHours = Math.abs(diffMs / (1000 * 60 * 60));
  let relativeStr: string;
  
  if (diffHours < 1) {
    const mins = Math.round(diffHours * 60);
    relativeStr = diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
  } else {
    const hours = Math.round(diffHours);
    relativeStr = diffMs > 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  
  return `${dateStr} ${cycle} • ${leadStr} • ${relativeStr}`;
}

// ============================================================================

export interface TileMetadata {
  encoding: string; // e.g., 'uint8'
  min: number; // minimum value in data units
  max: number; // maximum value in data units
  units: string; // e.g., 'K' for Kelvin
  bbox: [number, number, number, number]; // [west, south, east, north] in the CRS units
  width: number;
  height: number;
  parameter: string; // e.g., 'TMP'
  crs: string; // e.g., 'CRS:84' or 'EPSG:3857'
  datetime?: string; // ISO 8601 timestamp of the data
}

export interface ModelRunInfo {
  runTime: string;          // ISO 8601 model initialization time (e.g., "2026-02-06T12:00:00Z")
  validStart: string;       // First valid timestamp
  validEnd: string;         // Last valid timestamp
  forecastHours: number[];  // Available forecast hours
}

export interface CollectionMetadata {
  id: string;
  title: string;
  availableTimestamps: string[]; // ISO 8601 timestamps
  temporalExtent: {
    start: string;
    end: string;
  };
  parameters: string[];
  latestRun?: ModelRunInfo;      // Info about the latest model run (if instances available)
  runs?: ModelRunInfo[];         // All available model runs
}

/**
 * Vertical extent info for collections with pressure/height levels
 */
export interface VerticalExtent {
  values: number[];  // Available vertical levels (e.g., pressure in hPa)
  vrs?: string;      // Vertical reference system (e.g., "EPSG:5801" for pressure)
  units?: string;    // Units label (e.g., "hPa", "m")
}

/**
 * Summary info for a collection (from /edr/collections list)
 */
export interface CollectionSummary {
  id: string;
  title: string;
  description?: string;
  parameters: string[];
  verticalExtent?: VerticalExtent;
}

/**
 * Fetch list of all available collections from the EDR server
 */
export async function fetchCollections(): Promise<CollectionSummary[]> {
  const url = `${getEdrBaseUrl()}/edr/collections`;

  const response = await authFetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch collections: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  // OGC EDR collections response has a "collections" array
  const collections: CollectionSummary[] = (data.collections ?? []).map((c: any) => {
    // Extract vertical extent if present
    const vertical = c.extent?.vertical;
    let verticalExtent: VerticalExtent | undefined;

    if (vertical?.values && vertical.values.length > 0) {
      verticalExtent = {
        values: vertical.values.map((v: any) => typeof v === 'number' ? v : parseFloat(v)),
        vrs: vertical.vrs,
        units: vertical.vrs === 'EPSG:5801' ? 'hPa' : vertical.vrs === 'EPSG:5703' ? 'm' : undefined,
      };
    }

    return {
      id: c.id,
      title: c.title ?? c.id,
      description: c.description,
      parameters: Object.keys(c.parameter_names ?? {}),
      verticalExtent,
    };
  });

  return collections;
}

export interface DataTile {
  image: HTMLImageElement;
  metadata: TileMetadata;
}

export interface FetchTileOptions {
  collection?: string;
  parameter?: string;
  width?: number;
  height?: number;
  bbox?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  crs?: string;
  datetime?: string; // ISO 8601 timestamp, e.g., "2026-01-12T18:00:00Z"
  z?: number; // Vertical level (e.g., pressure in hPa for isobaric data)
}

/**
 * Parse EDR-specific headers from response
 */
function parseEdrHeaders(headers: Headers): TileMetadata {
  const getHeader = (name: string): string => {
    const value = headers.get(name);
    if (!value) {
      throw new Error(`Missing required header: ${name}`);
    }
    return value;
  };

  const getNumericHeader = (name: string): number => {
    const value = parseFloat(getHeader(name));
    if (isNaN(value)) {
      throw new Error(`Invalid numeric header: ${name}`);
    }
    return value;
  };

  const bboxStr = getHeader("x-edr-bbox");
  const bboxParts = bboxStr.split(",").map(Number);
  if (bboxParts.length !== 4 || bboxParts.some(isNaN)) {
    throw new Error(`Invalid bbox header: ${bboxStr}`);
  }

  const responseCrs = headers.get("x-edr-crs") ?? "CRS:84";

  // Parse bbox - server appears to always return [west, south, east, north] in degrees
  // regardless of requested CRS (CRS only affects image projection)
  let [west, south, east, north] = bboxParts;

  // Check if values look like meters (EPSG:3857) - if any coordinate > 360, it's meters
  const looksLikeMeters = bboxParts.some(v => Math.abs(v) > 360);
  if (looksLikeMeters) {
    // Convert from meters to degrees
    const [minX, minY, maxX, maxY] = bboxParts;
    [west, south] = mercatorToLngLat(minX, minY);
    [east, north] = mercatorToLngLat(maxX, maxY);
    console.log(`Converted bbox from meters: [${minX}, ${minY}, ${maxX}, ${maxY}] -> [${west}, ${south}, ${east}, ${north}]`);
  }

  // Normalize longitudes from 0-360 to -180 to 180 range for web map compatibility
  if (west > 180) west -= 360;
  if (east > 180) east -= 360;

  return {
    encoding: getHeader("x-edr-encoding"),
    min: getNumericHeader("x-edr-min"),
    max: getNumericHeader("x-edr-max"),
    units: getHeader("x-edr-units"),
    bbox: [west, south, east, north] as [number, number, number, number],
    width: getNumericHeader("x-edr-width"),
    height: getNumericHeader("x-edr-height"),
    parameter: getHeader("x-edr-parameter"),
    crs: responseCrs,
    datetime: headers.get("x-edr-datetime") ?? undefined,
  };
}

/**
 * Load image from blob
 */
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Set crossOrigin for WebGL texture usage
    img.crossOrigin = "anonymous";
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      console.log("EDR image loaded:", img.width, "x", img.height);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(img.src);
      console.error("Failed to load EDR image:", e);
      reject(new Error("Failed to load image"));
    };
    img.src = URL.createObjectURL(blob);
  });
}

// Internal type for resolved options (width, height, datetime, and z are optional)
interface ResolvedFetchOptions {
  collection: string;
  parameter: string;
  width?: number;  // If omitted, server returns native grid resolution
  height?: number; // If omitted, server returns native grid resolution
  bbox: { west: number; south: number; east: number; north: number };
  crs: string;
  datetime?: string;
  z?: number;
}

/**
 * Convert lat/lng to Web Mercator (EPSG:3857) coordinates in meters
 */
function lngLatToMercator(lng: number, lat: number): [number, number] {
  const x = lng * 20037508.34 / 180;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  return [x, y * 20037508.34 / 180];
}

/**
 * Convert Web Mercator (EPSG:3857) coordinates in meters to lat/lng
 */
function mercatorToLngLat(x: number, y: number): [number, number] {
  const lng = x * 180 / 20037508.34;
  const lat = Math.atan(Math.exp(y * Math.PI / 20037508.34)) * 360 / Math.PI - 90;
  return [lng, lat];
}

/**
 * Build the EDR area query URL with POLYGON coordinates
 * Note: The server expects coordinates in lng/lat degrees regardless of output CRS.
 * The CRS parameter only affects the output projection of the returned image.
 */
function buildEdrUrl(options: ResolvedFetchOptions): string {
  const { collection, parameter, width, height, bbox, crs, datetime, z } = options;

  // Always use lng/lat order (CRS:84 style) - server expects degrees for input
  const polygon = `POLYGON((${bbox.west} ${bbox.south},${bbox.east} ${bbox.south},${bbox.east} ${bbox.north},${bbox.west} ${bbox.north},${bbox.west} ${bbox.south}))`;

  const params = new URLSearchParams({
    coords: polygon,
    "parameter-name": parameter,
    f: "png",
    crs: crs,
  });

  // Add depth parameter if configured (some servers don't support it)
  const depth = getEdrDepth();
  if (depth !== null) {
    params.append("depth", depth);
  }

  // Only include width/height if specified - otherwise server returns native grid resolution
  if (width !== undefined) {
    params.append("width", width.toString());
  }
  if (height !== undefined) {
    params.append("height", height.toString());
  }

  // Add datetime if specified
  if (datetime) {
    params.append("datetime", datetime);
  }

  // Add vertical level if specified (e.g., pressure in hPa for isobaric data)
  if (z !== undefined) {
    params.append("z", z.toString());
  }

  return `${getEdrBaseUrl()}/edr/collections/${collection}/area?${params.toString()}`;
}

/**
 * Fetch a weather data tile from the EDR API
 *
 * @param options - Fetch options (collection, parameter, dimensions, bbox, datetime)
 * @returns DataTile with image and metadata
 * @throws Error if fetch fails or response is invalid
 */
export async function fetchDataTile(
  options: FetchTileOptions = {}
): Promise<DataTile> {
  const opts: ResolvedFetchOptions = {
    collection: options.collection ?? "gfs-height-agl",  // GFS is global, lat/lng native grid
    parameter: options.parameter ?? "TMP",
    width: options.width,   // If undefined, server returns native grid resolution
    height: options.height, // If undefined, server returns native grid resolution
    bbox: options.bbox ?? DEFAULT_BBOX,
    crs: options.crs ?? "CRS:84",  // Use WGS84 lat/lng for web map compatibility
    datetime: options.datetime,
    z: options.z,  // Vertical level for isobaric/height-level data
  };

  const url = buildEdrUrl(opts);

  const response = await authFetch(url);

  if (!response.ok) {
    throw new Error(
      `EDR request failed: ${response.status} ${response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("image/png")) {
    throw new Error(`Unexpected content type: ${contentType}`);
  }

  const metadata = parseEdrHeaders(response.headers);
  const blob = await response.blob();
  const image = await loadImage(blob);

  return { image, metadata };
}

// ============================================================================
// TILE-BASED FETCHING
// ============================================================================

export interface FetchTileByCoordOptions {
  collection: string;
  parameter: string;
  datetime?: string;
  z?: number;  // vertical level
  tileSize?: number;  // Pixel size of output tile (default: 512)
}

// Default tile size for consistent compositing (512 for better resolution)
const DEFAULT_TILE_SIZE = 512;

/**
 * Fetch a single weather data tile by XYZ coordinates.
 * Uses CRS:84 (geographic) projection - client handles reprojection to Mercator.
 * 
 * @param tile - Tile coordinates {x, y, z}
 * @param options - Collection, parameter, datetime, vertical level
 * @returns DataTile with image and metadata
 */
export async function fetchTileByCoord(
  tile: TileCoord,
  options: FetchTileByCoordOptions
): Promise<DataTile> {
  // Convert tile coords to WGS84 bbox for the POLYGON in the request
  const bbox = tileToBboxWGS84(tile);
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
  
  console.log(`Fetching tile ${tile.z}/${tile.x}/${tile.y} (${tileSize}x${tileSize}) bbox: [${bbox.west.toFixed(4)}, ${bbox.south.toFixed(4)}, ${bbox.east.toFixed(4)}, ${bbox.north.toFixed(4)}]`);
  
  // Request in CRS:84 (geographic projection)
  // Client will handle reprojection to Mercator for display
  return fetchDataTile({
    collection: options.collection,
    parameter: options.parameter,
    width: tileSize,
    height: tileSize,
    bbox: {
      west: bbox.west,
      south: bbox.south,
      east: bbox.east,
      north: bbox.north,
    },
    crs: "CRS:84",  // Geographic projection - client reprojects
    datetime: options.datetime,
    z: options.z,
  });
}

/**
 * Extract grayscale data from an HTMLImageElement.
 * Returns RGBA array where R=G=B=grayscale value.
 */
function extractGrayscaleData(image: HTMLImageElement): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, image.width, image.height).data);
}

/**
 * Convert a DataTile to a CachedTile for the tile cache.
 * Optionally renormalizes data to global fixed scale.
 */
function dataTileToCachedTile(
  dataTile: DataTile,
  parameter: string,
  useGlobalScale: boolean = true
): CachedTile {
  let grayscaleData = extractGrayscaleData(dataTile.image);
  
  // Renormalize to global fixed scale if requested
  if (useGlobalScale) {
    grayscaleData = renormalizeToGlobalScale(
      grayscaleData,
      dataTile.metadata.min,
      dataTile.metadata.max,
      parameter
    );
  }
  
  return {
    grayscaleData,
    width: dataTile.image.width,
    height: dataTile.image.height,
    bbox: dataTile.metadata.bbox,
    dataMin: dataTile.metadata.min,
    dataMax: dataTile.metadata.max,
    units: dataTile.metadata.units,
    fetchedAt: Date.now(),
    lastAccess: Date.now(),
  };
}

export interface FetchTilesOptions extends FetchTileByCoordOptions {
  useGlobalScale?: boolean;  // Renormalize to global fixed scale (default: true)
}

export interface FetchTilesResult {
  tiles: Map<string, CachedTile>;
  errors: Map<string, Error>;
}

/**
 * Fetch multiple tiles in parallel with caching.
 * Checks cache first, only fetches missing tiles.
 * 
 * @param tileCoords - Array of tile coordinates to fetch
 * @param cache - Tile cache instance
 * @param options - Fetch options
 * @returns Map of tile keys to cached tiles, plus any errors
 */
export async function fetchTiles(
  tileCoords: TileCoord[],
  cache: TileCache,
  options: FetchTilesOptions
): Promise<FetchTilesResult> {
  const { collection, parameter, datetime, z, tileSize, useGlobalScale = true } = options;
  
  const results = new Map<string, CachedTile>();
  const errors = new Map<string, Error>();
  const toFetch: TileCoord[] = [];
  
  // Check cache first
  for (const tile of tileCoords) {
    const key = makeTileKey(tile, datetime, parameter, collection);
    const cached = cache.get(key);
    if (cached) {
      results.set(key, cached);
    } else {
      toFetch.push(tile);
    }
  }
  
  console.log(`Tile fetch: ${results.size} cached, ${toFetch.length} to fetch`);
  
  if (toFetch.length === 0) {
    return { tiles: results, errors };
  }
  
  // Fetch missing tiles in parallel
  const fetchPromises = toFetch.map(async (tile) => {
    const key = makeTileKey(tile, datetime, parameter, collection);
    try {
      const dataTile = await fetchTileByCoord(tile, { collection, parameter, datetime, z, tileSize });
      const cachedTile = dataTileToCachedTile(dataTile, parameter, useGlobalScale);
      
      // Store in cache
      cache.set(key, cachedTile);
      
      return { key, tile: cachedTile, error: null };
    } catch (err) {
      console.error(`Failed to fetch tile ${key}:`, err);
      return { key, tile: null, error: err as Error };
    }
  });
  
  const fetchResults = await Promise.all(fetchPromises);
  
  // Collect results and errors
  for (const result of fetchResults) {
    if (result.tile) {
      results.set(result.key, result.tile);
    } else if (result.error) {
      errors.set(result.key, result.error);
    }
  }
  
  return { tiles: results, errors };
}

/**
 * Convert a raw pixel value (0-255) to the actual data value
 *
 * @param pixelValue - Raw pixel value from PNG (0-255)
 * @param min - Minimum value from metadata
 * @param max - Maximum value from metadata
 * @returns Actual data value in original units
 */
export function decodePixelValue(
  pixelValue: number,
  min: number,
  max: number
): number {
  return (pixelValue / 255) * (max - min) + min;
}

/**
 * Fetch collection metadata including available timestamps
 *
 * @param collection - Collection ID (e.g., 'mrms-single-level', 'gfs-height-agl')
 * @returns Collection metadata with available timestamps
 */
export async function fetchCollectionMetadata(
  collection: string
): Promise<CollectionMetadata> {
  const url = `${getEdrBaseUrl()}/edr/collections/${collection}`;
  
  const response = await authFetch(url);
  
  if (!response.ok) {
    throw new Error(
      `Failed to fetch collection metadata: ${response.status} ${response.statusText}`
    );
  }
  
  const data = await response.json();
  
  // Extract temporal extent
  const temporal = data.extent?.temporal;
  const interval = temporal?.interval?.[0] ?? [null, null];
  const timestamps = temporal?.values ?? [];
  
  // Extract parameter names
  const parameters = Object.keys(data.parameter_names ?? {});
  
  const result: CollectionMetadata = {
    id: data.id,
    title: data.title ?? data.id,
    availableTimestamps: timestamps,
    temporalExtent: {
      start: interval[0] ?? timestamps[0] ?? '',
      end: interval[1] ?? timestamps[timestamps.length - 1] ?? '',
    },
    parameters,
  };

  // Try to fetch instance data (model runs) for richer temporal info
  // This is non-critical, so we don't fail if it errors
  try {
    const runs = await fetchCollectionInstances(collection);
    if (runs.length > 0) {
      result.latestRun = runs[0]; // First is most recent
      result.runs = runs;
    }
  } catch (e) {
    console.warn(`Could not fetch instances for ${collection}:`, e);
  }

  return result;
}

/**
 * Fetch available model run instances for a collection
 * Returns runs sorted newest first
 */
export async function fetchCollectionInstances(
  collection: string
): Promise<ModelRunInfo[]> {
  const url = `${getEdrBaseUrl()}/edr/collections/${collection}/instances`;
  
  const response = await authFetch(url);
  
  if (!response.ok) {
    // Not all collections support instances (e.g., MRMS)
    if (response.status === 404) return [];
    throw new Error(
      `Failed to fetch collection instances: ${response.status} ${response.statusText}`
    );
  }
  
  const data = await response.json();
  const instances = data.instances ?? [];
  
  return instances.map((inst: any) => {
    const temporal = inst.extent?.temporal;
    const interval = temporal?.interval?.[0] ?? [null, null];
    const forecastHourExtent = inst.extent?.custom?.find((c: any) => c.id === 'forecast-hour');
    
    return {
      runTime: inst.id,  // Instance ID is the run time
      validStart: interval[0] ?? '',
      validEnd: interval[1] ?? '',
      forecastHours: forecastHourExtent?.values ?? [],
    } as ModelRunInfo;
  });
}

/**
 * Select timestamps for animation based on collection data
 * 
 * @param metadata - Collection metadata with available timestamps
 * @param frameCount - Number of frames to select
 * @param skipFactor - Use every Nth timestamp (e.g., 3 for every 3rd)
 * @param mode - 'recent' for most recent N, 'centered' for centered around now
 * @returns Array of selected timestamps
 */
export function selectAnimationTimestamps(
  metadata: CollectionMetadata,
  frameCount: number,
  skipFactor: number = 1,
  mode: 'recent' | 'centered' = 'recent'
): string[] {
  const { availableTimestamps } = metadata;

  if (availableTimestamps.length === 0) {
    return [];
  }

  // Apply skip factor to get effective timestamps
  const effectiveTimestamps: string[] = [];
  for (let i = 0; i < availableTimestamps.length; i += skipFactor) {
    effectiveTimestamps.push(availableTimestamps[i]);
  }

  // frameCount of -1 means "max" - return all available timestamps
  if (frameCount < 0 || effectiveTimestamps.length <= frameCount) {
    return effectiveTimestamps;
  }

  if (mode === 'recent') {
    // Take the most recent N timestamps
    return effectiveTimestamps.slice(-frameCount);
  } else {
    // Center around current time
    const now = new Date().toISOString();
    let centerIndex = effectiveTimestamps.findIndex(t => t > now);
    if (centerIndex === -1) centerIndex = effectiveTimestamps.length - 1;

    const halfCount = Math.floor(frameCount / 2);
    let startIndex = Math.max(0, centerIndex - halfCount);
    let endIndex = startIndex + frameCount;

    // Adjust if we hit the end
    if (endIndex > effectiveTimestamps.length) {
      endIndex = effectiveTimestamps.length;
      startIndex = Math.max(0, endIndex - frameCount);
    }

    return effectiveTimestamps.slice(startIndex, endIndex);
  }
}

// ============================================================
// POINT FORECAST QUERIES
// ============================================================

export interface PointForecast {
  datetime: string;
  // Temperature
  temperatureK: number;   // Kelvin (raw from API)
  temperatureF: number;   // Fahrenheit
  temperatureC: number;   // Celsius
  // Humidity & Dewpoint
  relativeHumidity: number;  // Percentage (0-100)
  dewpointF: number;         // Fahrenheit
  dewpointC: number;         // Celsius
  // Wind
  windSpeedMph: number;      // Miles per hour
  windSpeedKmh: number;      // Kilometers per hour
  windDirection: number;     // Degrees (0-360, meteorological)
  // Precipitation
  precipitationMm: number;   // Precipitation in mm
  precipitationIn: number;   // Precipitation in inches
  // Derived
  feelsLikeF: number;        // Heat index or wind chill
  feelsLikeC: number;
}

/**
 * Convert Kelvin to Fahrenheit
 */
export function kelvinToFahrenheit(k: number): number {
  return (k - 273.15) * 9/5 + 32;
}

/**
 * Convert Kelvin to Celsius
 */
export function kelvinToCelsius(k: number): number {
  return k - 273.15;
}

/**
 * Convert m/s to mph
 */
function msToMph(ms: number): number {
  return ms * 2.237;
}

/**
 * Convert m/s to km/h
 */
function msToKmh(ms: number): number {
  return ms * 3.6;
}

/**
 * Calculate wind direction from U and V components (meteorological convention)
 * Returns degrees (0-360) where 0=N, 90=E, 180=S, 270=W
 */
function calcWindDirection(u: number, v: number): number {
  // Meteorological convention: direction wind is coming FROM
  const radians = Math.atan2(-u, -v);
  let degrees = (radians * 180 / Math.PI + 360) % 360;
  return Math.round(degrees);
}

/**
 * Calculate wind speed from U and V components
 */
function calcWindSpeed(u: number, v: number): number {
  return Math.sqrt(u * u + v * v);
}

/**
 * Calculate "feels like" temperature (wind chill or heat index)
 */
function calcFeelsLike(tempF: number, humidity: number, windMph: number): number {
  // Wind chill for cold temps (< 50°F) with wind
  if (tempF <= 50 && windMph > 3) {
    return 35.74 + 0.6215 * tempF - 35.75 * Math.pow(windMph, 0.16) + 0.4275 * tempF * Math.pow(windMph, 0.16);
  }
  
  // Heat index for hot temps (> 80°F) with humidity
  if (tempF >= 80 && humidity > 40) {
    const hi = -42.379 + 2.04901523 * tempF + 10.14333127 * humidity
      - 0.22475541 * tempF * humidity - 0.00683783 * tempF * tempF
      - 0.05481717 * humidity * humidity + 0.00122874 * tempF * tempF * humidity
      + 0.00085282 * tempF * humidity * humidity - 0.00000199 * tempF * tempF * humidity * humidity;
    return hi;
  }
  
  // Otherwise just return actual temp
  return tempF;
}

/**
 * Fetch weather forecast at a specific point for multiple timestamps.
 * Fetches TMP, RH, DPT, UGRD, VGRD in a single request.
 * 
 * @param lat - Latitude
 * @param lng - Longitude  
 * @param count - Number of forecast points (default 8, covering 24 hours at 3-hour intervals)
 * @param intervalHours - Hours between each forecast point (default 3)
 * @returns Array of forecasts with all weather parameters
 */
export async function fetchPointForecast(
  lat: number,
  lng: number,
  count: number = 8,
  intervalHours: number = 3
): Promise<PointForecast[]> {
  // First get available timestamps from GFS
  const metadata = await fetchCollectionMetadata('gfs-height-agl');
  
  // Select timestamps starting from now
  const now = new Date();
  const availableTimestamps = metadata.availableTimestamps.filter(t => {
    return new Date(t) >= now;
  });
  
  // Take every Nth timestamp based on interval (GFS is hourly)
  const timestamps: string[] = [];
  for (let i = 0; i < availableTimestamps.length && timestamps.length < count; i += intervalHours) {
    timestamps.push(availableTimestamps[i]);
  }
  
  if (timestamps.length === 0) {
    throw new Error('No forecast timestamps available');
  }
  
  // Build single request with comma-separated timestamps and parameters
  const datetimeParam = timestamps.join(',');
  const parameters = 'TMP,RH,DPT,UGRD,VGRD';
  
  const params = new URLSearchParams({
    coords: `POINT(${lng} ${lat})`,
    'parameter-name': parameters,
    datetime: datetimeParam,
    f: 'CoverageJSON',
  });
  
  const url = `${getEdrBaseUrl()}/edr/collections/gfs-height-agl/position?${params.toString()}`;
  
  console.log(`Fetching ${timestamps.length}-point forecast (${parameters}) in single request`);
  
  const response = await authFetch(url);
  
  if (!response.ok) {
    throw new Error(`Point forecast failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Extract values for each parameter
  const tempValues: number[] = data?.ranges?.TMP?.values ?? [];
  const rhValues: number[] = data?.ranges?.RH?.values ?? [];
  const dptValues: number[] = data?.ranges?.DPT?.values ?? [];
  const ugrdValues: number[] = data?.ranges?.UGRD?.values ?? [];
  const vgrdValues: number[] = data?.ranges?.VGRD?.values ?? [];
  
  // Fetch precipitation from gfs-surface collection
  const surfaceParams = new URLSearchParams({
    coords: `POINT(${lng} ${lat})`,
    'parameter-name': 'APCP',
    datetime: datetimeParam,
    f: 'CoverageJSON',
  });
  
  const surfaceUrl = `${getEdrBaseUrl()}/edr/collections/gfs-surface/position?${surfaceParams.toString()}`;
  
  console.log(`Fetching precipitation data from gfs-surface`);
  
  const surfaceResponse = await authFetch(surfaceUrl);
  let apcpValues: number[] = [];
  
  if (surfaceResponse.ok) {
    const surfaceData = await surfaceResponse.json();
    apcpValues = surfaceData?.ranges?.APCP?.values ?? [];
  } else {
    console.warn('Failed to fetch precipitation data, continuing without it');
  }
  
  // Get the timestamps from the response
  const responseTimestamps: string[] = data?.domain?.axes?.t?.values ?? timestamps;
  
  if (tempValues.length === 0) {
    throw new Error('No temperature values in response');
  }
  
  // Build forecast array
  const forecasts: PointForecast[] = [];
  
  for (let i = 0; i < responseTimestamps.length; i++) {
    const tempK = tempValues[i] ?? 273.15;
    const tempF = kelvinToFahrenheit(tempK);
    const tempC = kelvinToCelsius(tempK);
    
    const rh = rhValues[i] ?? 50;
    
    const dptK = dptValues[i] ?? tempK - 10;
    const dptF = kelvinToFahrenheit(dptK);
    const dptC = kelvinToCelsius(dptK);
    
    const u = ugrdValues[i] ?? 0;
    const v = vgrdValues[i] ?? 0;
    const windSpeedMs = calcWindSpeed(u, v);
    const windMph = msToMph(windSpeedMs);
    
    const feelsF = calcFeelsLike(tempF, rh, windMph);
    
    const precipMm = apcpValues[i] ?? 0;
    const precipIn = precipMm / 25.4; // Convert mm to inches
    
    forecasts.push({
      datetime: responseTimestamps[i],
      temperatureK: tempK,
      temperatureF: tempF,
      temperatureC: tempC,
      relativeHumidity: rh,
      dewpointF: dptF,
      dewpointC: dptC,
      windSpeedMph: windMph,
      windSpeedKmh: msToKmh(windSpeedMs),
      windDirection: calcWindDirection(u, v),
      precipitationMm: precipMm,
      precipitationIn: precipIn,
      feelsLikeF: feelsF,
      feelsLikeC: kelvinToCelsius((feelsF - 32) * 5/9 + 273.15),
    });
  }
  
  return forecasts;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Generate consistent time slots for a day starting at startHour.
 * Returns Date objects for each slot.
 */
function generateDaySlots(
  date: Date,
  startHour: number,
  intervalHours: number,
  slotsPerDay: number
): Date[] {
  const slots: Date[] = [];
  const slotDate = new Date(date);
  slotDate.setHours(startHour, 0, 0, 0);
  
  for (let i = 0; i < slotsPerDay; i++) {
    slots.push(new Date(slotDate));
    slotDate.setHours(slotDate.getHours() + intervalHours);
  }
  
  return slots;
}

// ============================================================
// PAINTING FORECAST (Temperature, Humidity, Wind for painting conditions)
// ============================================================

export interface PaintingForecast {
  datetime: string;
  temperatureF: number;
  temperatureC: number;
  relativeHumidity: number;
  windSpeedMph: number;
  windSpeedKmh: number;
  hour: number;
  // Painting condition flags
  tempOk: boolean;      // 50-85°F ideal
  humidityOk: boolean;  // 40-70% ideal
  windOk: boolean;      // < 15 mph ideal
  isDaylight: boolean;  // 7am - 7pm
  isGood: boolean;      // All conditions met
}

/**
 * Fetch weather forecast for exterior painting activity planning.
 * Considers: temperature (50-85°F), humidity (40-70%), wind (< 15 mph)
 * 
 * @param lat - Latitude
 * @param lng - Longitude
 * @param intervalHours - Hours between each forecast point (default 3)
 * @param startHour - Hour of day to start (default 6 = 6 AM)
 * @param slotsPerDay - Number of slots per day (default 6, covering 18 hours)
 * @param config - Thresholds for painting conditions
 * @returns Array of painting forecast data for today and tomorrow
 */
export async function fetchPaintingForecast(
  lat: number,
  lng: number,
  intervalHours: number = 3,
  startHour: number = 6,
  slotsPerDay: number = 6,
  config: {
    minTempF: number;
    maxTempF: number;
    minHumidity: number;
    maxHumidity: number;
    maxWindMph: number;
    daylightStart: number;
    daylightEnd: number;
  } = {
    minTempF: 50,
    maxTempF: 85,
    minHumidity: 40,
    maxHumidity: 70,
    maxWindMph: 15,
    daylightStart: 7,
    daylightEnd: 19,
  }
): Promise<PaintingForecast[]> {
  // Get available timestamps from GFS collection
  const metadata = await fetchCollectionMetadata('gfs-height-agl');
  
  // Generate slots for today and tomorrow
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const todaySlots = generateDaySlots(today, startHour, intervalHours, slotsPerDay);
  const tomorrowSlots = generateDaySlots(tomorrow, startHour, intervalHours, slotsPerDay);
  const allSlots = [...todaySlots, ...tomorrowSlots];
  
  // Find the closest available timestamp for each slot
  const timestamps: string[] = [];
  for (const slot of allSlots) {
    let bestMatch: string | null = null;
    let bestDiff = Infinity;
    
    for (const available of metadata.availableTimestamps) {
      const availableDate = new Date(available);
      const diff = Math.abs(availableDate.getTime() - slot.getTime());
      
      // Within 2 hour tolerance (GFS may have 3-hour intervals)
      if (diff < 2 * 60 * 60 * 1000 && diff < bestDiff) {
        bestDiff = diff;
        bestMatch = available;
      }
    }
    
    if (bestMatch) {
      timestamps.push(bestMatch);
    }
  }
  
  if (timestamps.length === 0) {
    throw new Error('No forecast timestamps available');
  }
  
  // Build single request with comma-separated timestamps
  const datetimeParam = timestamps.join(',');
  const parameters = 'TMP,RH,UGRD,VGRD';
  
  const params = new URLSearchParams({
    coords: `POINT(${lng} ${lat})`,
    'parameter-name': parameters,
    datetime: datetimeParam,
    f: 'CoverageJSON',
  });
  
  const url = `${getEdrBaseUrl()}/edr/collections/gfs-height-agl/position?${params.toString()}`;
  
  console.log(`Fetching ${timestamps.length}-point painting forecast (${parameters})`);
  
  const response = await authFetch(url);
  
  if (!response.ok) {
    throw new Error(`Painting forecast failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Extract values for each parameter
  const tempValues: number[] = data?.ranges?.TMP?.values ?? [];
  const rhValues: number[] = data?.ranges?.RH?.values ?? [];
  const ugrdValues: number[] = data?.ranges?.UGRD?.values ?? [];
  const vgrdValues: number[] = data?.ranges?.VGRD?.values ?? [];
  
  // Get the timestamps from the response
  const responseTimestamps: string[] = data?.domain?.axes?.t?.values ?? timestamps;
  
  if (tempValues.length === 0) {
    throw new Error('No temperature values in response');
  }
  
  // Build forecast array
  const forecasts: PaintingForecast[] = [];
  
  for (let i = 0; i < responseTimestamps.length; i++) {
    const tempK = tempValues[i] ?? 273.15;
    const tempF = kelvinToFahrenheit(tempK);
    const tempC = kelvinToCelsius(tempK);
    
    const rh = rhValues[i] ?? 50;
    
    const u = ugrdValues[i] ?? 0;
    const v = vgrdValues[i] ?? 0;
    const windSpeedMs = calcWindSpeed(u, v);
    const windMph = msToMph(windSpeedMs);
    const windKmh = msToKmh(windSpeedMs);
    
    const blockTime = new Date(responseTimestamps[i]);
    const hour = blockTime.getHours();
    
    // Check painting conditions
    const tempOk = tempF >= config.minTempF && tempF <= config.maxTempF;
    const humidityOk = rh >= config.minHumidity && rh <= config.maxHumidity;
    const windOk = windMph <= config.maxWindMph;
    const isDaylight = hour >= config.daylightStart && hour < config.daylightEnd;
    
    forecasts.push({
      datetime: responseTimestamps[i],
      temperatureF: tempF,
      temperatureC: tempC,
      relativeHumidity: rh,
      windSpeedMph: windMph,
      windSpeedKmh: windKmh,
      hour,
      tempOk,
      humidityOk,
      windOk,
      isDaylight,
      isGood: tempOk && humidityOk && windOk && isDaylight,
    });
  }
  
  return forecasts;
}

// ============================================================
// MOWING CONDITIONS - Comprehensive Mow Score System
// Supports multiple weather models: HRRR, GFS, NBM, NDFD
// TODO: Higher resolution data interpolation could be a paid feature
// ============================================================

export type MowStatus = 'great' | 'good' | 'marginal' | 'poor' | 'bad' | 'night' | 'unavailable';

// Weather model identifier
export type WeatherModel = 'hrrr' | 'gfs' | 'nbm' | 'ndfd';

// Model metadata for UI display
export interface ModelInfo {
  id: WeatherModel;
  name: string;
  resolution: string;
  description: string;
  color: string;
  maxHoursAhead: number;
}

// Model configuration
export const WEATHER_MODELS: Record<WeatherModel, ModelInfo> = {
  hrrr: {
    id: 'hrrr',
    name: 'HRRR',
    resolution: '3km',
    description: 'High-Resolution Rapid Refresh',
    color: '#3b82f6', // Blue
    maxHoursAhead: 18,
  },
  gfs: {
    id: 'gfs',
    name: 'GFS',
    resolution: '22km',
    description: 'Global Forecast System',
    color: '#22c55e', // Green
    maxHoursAhead: 120,
  },
  nbm: {
    id: 'nbm',
    name: 'NBM',
    resolution: '2.5km',
    description: 'National Blend of Models',
    color: '#8b5cf6', // Purple
    maxHoursAhead: 72,
  },
  ndfd: {
    id: 'ndfd',
    name: 'NDFD',
    resolution: '2.5km',
    description: 'National Digital Forecast Database (Official NWS)',
    color: '#f97316', // Orange
    maxHoursAhead: 168,
  },
};

export interface MowScores {
  precipitation: number;  // 0-100 (weight: 35%)
  temperature: number;    // 0-100 (weight: 20%)
  wind: number;           // 0-100 (weight: 15%)
  dewPoint: number;       // 0-100 (weight: 15%)
  timeOfDay: number;      // 0-100 (weight: 15%)
  overall: number;        // 0-100 weighted average
}

// Daylight period types for UI visualization
export type DaylightPeriod = 'night' | 'dawn' | 'day' | 'dusk';

export interface DaylightInfo {
  period: DaylightPeriod;
  label: string;
  color: string;
}

/**
 * Get daylight period for a given hour.
 * Can use actual sunrise/sunset times if provided, otherwise falls back to fixed approximations.
 * 
 * With astro data:
 * - Night: after sunset + 1hr OR before sunrise - 1hr
 * - Dawn: sunrise - 1hr to sunrise
 * - Day: sunrise to sunset
 * - Dusk: sunset to sunset + 1hr
 * 
 * Without astro data (fallback):
 * - Night: 9pm - 5am
 * - Dawn: 5am - 7am  
 * - Day: 7am - 7pm
 * - Dusk: 7pm - 9pm
 */
export function getDaylightPeriod(
  hour: number, 
  sunriseHour?: number, 
  sunsetHour?: number
): DaylightInfo {
  // If we have actual sunrise/sunset data, use it
  if (sunriseHour !== undefined && sunsetHour !== undefined) {
    const dawnStart = sunriseHour - 1;
    const duskEnd = sunsetHour + 1;
    
    if (hour >= sunsetHour && hour < duskEnd) {
      return { period: 'dusk', label: 'Dusk', color: '#fbbf24' }; // Yellow/orange (sunset)
    }
    if (hour >= duskEnd || hour < dawnStart) {
      return { period: 'night', label: 'Night', color: '#1a1a2e' }; // Dark blue
    }
    if (hour >= dawnStart && hour < sunriseHour) {
      return { period: 'dawn', label: 'Dawn', color: '#fbbf24' }; // Yellow/orange (sunrise)
    }
    // hour >= sunriseHour && hour < sunsetHour
    return { period: 'day', label: 'Day', color: '#fef08a' }; // Light yellow (daylight)
  }
  
  // Fallback to fixed times if no astro data
  if (hour >= 21 || hour < 5) {
    return { period: 'night', label: 'Night', color: '#1a1a2e' }; // Dark blue
  }
  if (hour >= 5 && hour < 7) {
    return { period: 'dawn', label: 'Dawn', color: '#fbbf24' }; // Yellow/orange (sunrise)
  }
  if (hour >= 7 && hour < 19) {
    return { period: 'day', label: 'Day', color: '#fef08a' }; // Light yellow (daylight)
  }
  // hour >= 19 && hour < 21
  return { period: 'dusk', label: 'Dusk', color: '#fbbf24' }; // Yellow/orange (sunset)
}

/**
 * Get daylight segments for a range of hours (for UI bar).
 * Returns array of segments with start/end percentages and colors.
 * 
 * @param startHour Starting hour (typically 0 for midnight)
 * @param endHour Ending hour (typically 24)
 * @param sunrise Optional sunrise Date object for accurate dawn/day calculation
 * @param sunset Optional sunset Date object for accurate day/dusk calculation
 */
export function getDaylightSegments(
  startHour: number,
  endHour: number,
  sunrise?: Date | null,
  sunset?: Date | null
): Array<{ startPercent: number; endPercent: number; period: DaylightPeriod; color: string }> {
  const totalHours = endHour - startHour;
  const segments: Array<{ startPercent: number; endPercent: number; period: DaylightPeriod; color: string }> = [];
  
  // Convert sunrise/sunset to fractional hours for more accurate segment boundaries
  const sunriseHour = sunrise ? sunrise.getHours() + sunrise.getMinutes() / 60 : undefined;
  const sunsetHour = sunset ? sunset.getHours() + sunset.getMinutes() / 60 : undefined;
  
  let currentPeriod: DaylightPeriod | null = null;
  let segmentStart = 0;
  
  for (let h = startHour; h <= endHour; h++) {
    const info = getDaylightPeriod(h, sunriseHour, sunsetHour);
    
    if (info.period !== currentPeriod) {
      // Close previous segment
      if (currentPeriod !== null) {
        const endPercent = ((h - startHour) / totalHours) * 100;
        segments.push({
          startPercent: segmentStart,
          endPercent,
          period: currentPeriod,
          color: getDaylightPeriod(h - 1, sunriseHour, sunsetHour).color,
        });
      }
      // Start new segment
      currentPeriod = info.period;
      segmentStart = ((h - startHour) / totalHours) * 100;
    }
  }
  
  // Close final segment
  if (currentPeriod !== null) {
    segments.push({
      startPercent: segmentStart,
      endPercent: 100,
      period: currentPeriod,
      color: getDaylightPeriod(endHour - 1, sunriseHour, sunsetHour).color,
    });
  }
  
  return segments;
}

// TODO: Allow manual timezone selection or use location's timezone
// Currently uses browser's local timezone via Date.getHours()
export interface MowingConditions {
  datetime: string;       // ISO 8601 timestamp (UTC)
  hour: number;           // Local hour (0-23) for display/filtering
  minute: number;         // Local minute (0, 10, 20, 30, 40, 50)
  model: WeatherModel;
  // Model run metadata (optional for backwards compatibility)
  modelRunTime?: string;       // ISO 8601 model initialization time
  forecastLeadHours?: number;  // Hours from model run to valid time
  // Raw values
  temperatureF: number;
  temperatureC: number;
  relativeHumidity: number;
  dewPointF: number;
  dewPointSpreadF: number;  // TMP - DPT (larger = less dew risk)
  windSpeedMph: number;
  windGustMph: number;
  precipitationMm: number;
  precipProbability: number | null;  // POP from NBM/NDFD (0-100%)
  // Scores (4 factors: precip 40%, temp 25%, wind 20%, dew 15%)
  scores: MowScores;
  // Status
  status: MowStatus;
  // Primary issue (if any)
  primaryIssue: string | null;
  primaryIssueEmoji: string | null;
}

// Multi-model data structure
export interface MultiModelMowingData {
  location: { lat: number; lng: number };
  fetchedAt: string;
  models: {
    hrrr: MowingConditions[];
    gfs: MowingConditions[];
    nbm: MowingConditions[];
    ndfd: MowingConditions[];
  };
  // Blended "best" forecast for simple view (HRRR → NBM → GFS)
  blended: MowingConditions[];
}

// Legacy interface for backwards compatibility
export interface MowingForecast {
  datetime: string;
  relativeHumidity: number;
  isDry: boolean;
  hour: number;
}

// Score weights for overall calculation (defaults)
const SCORE_WEIGHTS = {
  precipitation: 0.35,
  temperature: 0.20,
  wind: 0.15,
  dewPoint: 0.15,
  timeOfDay: 0.15,
};

// Threshold types and utilities for configurable scoring (inline to avoid external dependency)
interface ThresholdRange {
  idealMin: number;
  idealMax: number;
}

interface MowingThresholds {
  ranges: {
    temperature: ThresholdRange;
    wind: ThresholdRange;
    dewPointSpread: ThresholdRange;
    humidity: ThresholdRange;
  };
  weights: {
    precipitation: number;
    temperature: number;
    wind: number;
    dewPoint: number;
    timeOfDay: number;
  };
  enabled: {
    precipitation: boolean;
    temperature: boolean;
    wind: boolean;
    dewPoint: boolean;
    timeOfDay: boolean;
  };
}

interface PaintingThresholds {
  ranges: {
    temperature: ThresholdRange;
    humidity: ThresholdRange;
    wind: ThresholdRange;
  };
  weights: {
    temperature: number;
    humidity: number;
    wind: number;
    dryingTime: number;
    precipitation: number;
    dewRisk: number;
    timeOfDay: number;
  };
  enabled: {
    temperature: boolean;
    humidity: boolean;
    wind: boolean;
    dryingTime: boolean;
    precipitation: boolean;
    dewRisk: boolean;
    timeOfDay: boolean;
  };
}

const MOWING_DEFAULT: MowingThresholds = {
  ranges: {
    temperature: { idealMin: 60, idealMax: 75 },
    wind: { idealMin: 0, idealMax: 15 },
    dewPointSpread: { idealMin: 10, idealMax: 50 },
    humidity: { idealMin: 40, idealMax: 70 },
  },
  weights: {
    precipitation: 30,
    temperature: 20,
    wind: 20,
    dewPoint: 15,
    timeOfDay: 15,
  },
  enabled: {
    precipitation: true,
    temperature: true,
    wind: true,
    dewPoint: true,
    timeOfDay: true,
  },
};

const PAINTING_DEFAULT: PaintingThresholds = {
  ranges: {
    temperature: { idealMin: 50, idealMax: 85 },
    humidity: { idealMin: 40, idealMax: 70 },
    wind: { idealMin: 0, idealMax: 10 },
  },
  weights: {
    temperature: 20,
    humidity: 20,
    wind: 15,
    dryingTime: 15,
    precipitation: 15,
    dewRisk: 10,
    timeOfDay: 5,
  },
  enabled: {
    temperature: true,
    humidity: true,
    wind: true,
    dryingTime: true,
    precipitation: true,
    dewRisk: true,
    timeOfDay: true,
  },
};

/** Calculate score for value in a range - 100 when in ideal range, drops linearly to 0 at extremes */
function calcRangeScore(value: number, idealMin: number, idealMax: number, badLow: number, badHigh: number): number {
  if (value >= idealMin && value <= idealMax) return 100;
  if (value < idealMin) {
    if (value <= badLow) return 0;
    return Math.round(100 * (value - badLow) / (idealMin - badLow));
  }
  if (value >= badHigh) return 0;
  return Math.round(100 * (badHigh - value) / (badHigh - idealMax));
}

/** Calculate score where higher values are worse - 100 at/below ideal, 0 at/above bad */
function calcMaxScore(value: number, idealMax: number, badValue: number): number {
  if (value <= idealMax) return 100;
  if (value >= badValue) return 0;
  return Math.round(100 * (1 - (value - idealMax) / (badValue - idealMax)));
}

/** Calculate score where lower values are worse - 100 at/above ideal, 0 at/below bad */
function calcMinScore(value: number, idealMin: number, badValue: number): number {
  if (value >= idealMin) return 100;
  if (value <= badValue) return 0;
  return Math.round(100 * (1 - (idealMin - value) / (idealMin - badValue)));
}

/**
 * Calculate precipitation score based on accumulated precip and humidity
 */
function calcPrecipitationScore(precipMm: number, humidity: number): number {
  // Any measurable precipitation is bad
  if (precipMm > 0.5) return 0;
  if (precipMm > 0.1) return 20;
  
  // Use humidity as proxy when no precip
  if (humidity > 95) return 0;   // Likely raining/foggy
  if (humidity > 90) return 20;
  if (humidity > 85) return 40;
  if (humidity > 80) return 60;
  if (humidity > 70) return 80;
  return 100;
}

/**
 * Calculate temperature score (ideal range 60-75°F for grass)
 */
function calcTemperatureScore(tempF: number): number {
  if (tempF >= 60 && tempF <= 75) return 100;  // Ideal
  if (tempF >= 55 && tempF < 60) return 80;
  if (tempF > 75 && tempF <= 80) return 80;
  if (tempF >= 50 && tempF < 55) return 60;
  if (tempF > 80 && tempF <= 85) return 60;
  if (tempF >= 45 && tempF < 50) return 40;
  if (tempF > 85 && tempF <= 90) return 40;
  if (tempF >= 40 && tempF < 45) return 20;
  if (tempF > 90 && tempF <= 95) return 20;
  return 0;  // Too cold (<40°F) or too hot (>95°F)
}

/**
 * Calculate wind score based on gusts (safety concern)
 */
function calcWindScore(gustMph: number): number {
  if (gustMph < 10) return 100;
  if (gustMph < 15) return 80;
  if (gustMph < 20) return 60;
  if (gustMph < 25) return 40;
  if (gustMph < 30) return 20;
  return 0;  // Dangerous winds
}

/**
 * Calculate dew point score (morning dew prediction)
 * Spread = TMP - DPT; smaller spread means more likely dew
 */
function calcDewPointScore(spreadF: number, hour: number): number {
  // Afternoon/evening: dew has evaporated
  if (hour >= 10 && hour < 20) return 100;
  
  // Morning hours: check dew risk
  if (spreadF > 15) return 100;  // Very unlikely dew
  if (spreadF > 10) return 80;
  if (spreadF > 5) return 50;
  if (spreadF > 2) return 30;
  return 10;  // High dew likelihood
}

/**
 * Calculate time of day score for mowing.
 * Best times: mid-morning to late afternoon (9am-6pm)
 * Okay times: early morning (7-9am) and evening (6-8pm)
 * Poor times: dawn (5-7am) and dusk (8-9pm) - low visibility, dew
 * Bad times: night (9pm-5am) - unsafe, disturbs neighbors
 */
function calcTimeOfDayScore(hour: number): number {
  // Prime mowing hours: 9am - 6pm
  if (hour >= 9 && hour < 18) return 100;
  
  // Good but not ideal: 7-9am (dew may still be present) and 6-8pm (getting late)
  if (hour >= 7 && hour < 9) return 70;
  if (hour >= 18 && hour < 20) return 70;
  
  // Dawn/dusk: 5-7am and 8-9pm - low light, dew issues
  if (hour >= 5 && hour < 7) return 30;
  if (hour >= 20 && hour < 21) return 30;
  
  // Night: 9pm - 5am - unsafe, noise concerns
  return 0;
}

/**
 * Determine status from overall score and hour
 */
function getStatusFromScore(score: number, hour: number): MowStatus {
  if (hour < 6 || hour >= 21) return 'night';
  if (score >= 80) return 'great';
  if (score >= 60) return 'good';
  if (score >= 40) return 'marginal';
  if (score >= 20) return 'poor';
  return 'bad';
}

/**
 * Determine the primary issue and emoji based on scores
 */
function getPrimaryIssue(
  scores: MowScores,
  conditions: {
    precipMm: number;
    humidity: number;
    tempF: number;
    gustMph: number;
    spreadF: number;
    hour: number;
  }
): { issue: string | null; emoji: string | null } {
  const { precipMm, humidity, tempF, gustMph, hour } = conditions;
  
  // Find the lowest score (biggest problem)
  const scoreEntries = [
    { name: 'precipitation', score: scores.precipitation },
    { name: 'temperature', score: scores.temperature },
    { name: 'wind', score: scores.wind },
    { name: 'dewPoint', score: scores.dewPoint },
    { name: 'timeOfDay', score: scores.timeOfDay },
  ];
  
  scoreEntries.sort((a, b) => a.score - b.score);
  const worst = scoreEntries[0];
  
  // If overall is good, no issue
  if (scores.overall >= 80) {
    return { issue: null, emoji: null };
  }
  
  // Generate issue message based on worst factor
  switch (worst.name) {
    case 'precipitation':
      if (precipMm > 0.1) return { issue: `Rain (${precipMm.toFixed(1)}mm)`, emoji: '🌧️' };
      if (humidity > 90) return { issue: `Very humid (${Math.round(humidity)}%)`, emoji: '💧' };
      return { issue: `Humid (${Math.round(humidity)}%)`, emoji: '💧' };
    
    case 'temperature':
      if (tempF < 50) return { issue: `Cold (${Math.round(tempF)}°F)`, emoji: '🥶' };
      if (tempF > 85) return { issue: `Hot (${Math.round(tempF)}°F)`, emoji: '🥵' };
      return { issue: `${Math.round(tempF)}°F`, emoji: '🌡️' };
    
    case 'wind':
      return { issue: `Gusts ${Math.round(gustMph)} mph`, emoji: '💨' };
    
    case 'dewPoint':
      if (hour < 10) return { issue: 'Morning dew likely', emoji: '💧' };
      return { issue: 'Dew risk', emoji: '💧' };
    
    case 'timeOfDay':
      if (hour >= 21 || hour < 5) return { issue: 'Too dark', emoji: '🌙' };
      if (hour >= 5 && hour < 7) return { issue: 'Too early (dawn)', emoji: '🌅' };
      if (hour >= 20) return { issue: 'Getting dark', emoji: '🌆' };
      return { issue: 'Not ideal time', emoji: '⏰' };
    
    default:
      return { issue: null, emoji: null };
  }
}

// =============================================================================
// Configurable Scoring Functions (using user thresholds)
// =============================================================================

/**
 * Calculate temperature score using configurable thresholds.
 * Falls back to hardcoded logic if no thresholds provided.
 */
function calcTemperatureScoreConfigurable(
  tempF: number,
  thresholds?: MowingThresholds
): number {
  if (!thresholds) return calcTemperatureScore(tempF);
  
  const { idealMin, idealMax } = thresholds.ranges.temperature;
  // Use configurable ideal range, with fixed bounds for 0 score
  return calcRangeScore(tempF, idealMin, idealMax, 30, 110);
}

/**
 * Calculate wind score using configurable thresholds.
 */
function calcWindScoreConfigurable(
  gustMph: number,
  thresholds?: MowingThresholds
): number {
  if (!thresholds) return calcWindScore(gustMph);
  
  const { idealMax } = thresholds.ranges.wind;
  // 0 mph to idealMax is ideal, score drops to 0 at 40mph
  return calcMaxScore(gustMph, idealMax, 40);
}

/**
 * Calculate dew point score using configurable thresholds.
 * Note: Time-of-day logic is preserved (afternoon always scores well).
 */
function calcDewPointScoreConfigurable(
  spreadF: number,
  hour: number,
  thresholds?: MowingThresholds
): number {
  if (!thresholds) return calcDewPointScore(spreadF, hour);
  
  // Afternoon/evening: dew has evaporated
  if (hour >= 10 && hour < 20) return 100;
  
  // Morning hours: check dew risk with configurable threshold
  const { idealMin } = thresholds.ranges.dewPointSpread;
  // idealMin+ is ideal, score drops to 0 at 0°F spread
  return calcMinScore(spreadF, idealMin, 0);
}

/**
 * Calculate precipitation score using configurable humidity threshold.
 * Note: Rain thresholds are fixed (any rain is bad), but humidity threshold is configurable.
 */
function calcPrecipitationScoreConfigurable(
  precipMm: number,
  humidity: number,
  thresholds?: MowingThresholds
): number {
  // Any measurable precipitation is bad (not configurable)
  if (precipMm > 0.5) return 0;
  if (precipMm > 0.1) return 20;
  
  if (!thresholds) {
    // Default humidity scoring
    if (humidity > 95) return 0;
    if (humidity > 90) return 20;
    if (humidity > 85) return 40;
    if (humidity > 80) return 60;
    if (humidity > 70) return 80;
    return 100;
  }
  
  // Use configurable humidity threshold
  const { idealMax } = thresholds.ranges.humidity;
  if (humidity <= idealMax) return 100;
  
  // Linear falloff from idealMax to 100%
  const excess = humidity - idealMax;
  const maxExcess = 100 - idealMax;
  if (maxExcess <= 0) return 0;
  return Math.max(0, Math.round(100 * (1 - excess / maxExcess)));
}

/**
 * Recalculate mowing scores for a single condition block using custom thresholds.
 * This is the key function cards call when user changes thresholds.
 */
export function recalculateMowingScores(
  condition: MowingConditions,
  thresholds: MowingThresholds
): MowingConditions {
  const {
    temperatureF,
    relativeHumidity,
    precipitationMm,
    windGustMph,
    dewPointSpreadF,
    hour,
  } = condition;
  
  // Calculate scores with custom thresholds
  const precipScore = calcPrecipitationScoreConfigurable(precipitationMm, relativeHumidity, thresholds);
  const tempScore = calcTemperatureScoreConfigurable(temperatureF, thresholds);
  const windScore = calcWindScoreConfigurable(windGustMph, thresholds);
  const dewScore = calcDewPointScoreConfigurable(dewPointSpreadF, hour, thresholds);
  const timeScore = calcTimeOfDayScore(hour); // Time of day not configurable
  
  // Calculate weighted overall using custom weights, only for enabled factors
  const weights = thresholds.weights;
  const enabled = thresholds.enabled;
  
  // Calculate total weight of enabled factors for normalization
  const totalEnabledWeight = 
    (enabled.precipitation ? weights.precipitation : 0) +
    (enabled.temperature ? weights.temperature : 0) +
    (enabled.wind ? weights.wind : 0) +
    (enabled.dewPoint ? weights.dewPoint : 0) +
    (enabled.timeOfDay ? weights.timeOfDay : 0);
  
  // Calculate weighted sum
  // Each factor: score (0-100) * weight (0-100), so we divide by totalEnabledWeight to normalize
  const weightedSum = 
    (enabled.precipitation ? precipScore * weights.precipitation : 0) +
    (enabled.temperature ? tempScore * weights.temperature : 0) +
    (enabled.wind ? windScore * weights.wind : 0) +
    (enabled.dewPoint ? dewScore * weights.dewPoint : 0) +
    (enabled.timeOfDay ? timeScore * weights.timeOfDay : 0);
  
  // Divide by total enabled weight to get score 0-100
  // e.g., if all enabled and weights sum to 100: (score1*w1 + score2*w2 + ...) / 100
  const overallScore = totalEnabledWeight > 0 
    ? Math.round(weightedSum / totalEnabledWeight) 
    : 0;
  
  const scores: MowScores = {
    precipitation: precipScore,
    temperature: tempScore,
    wind: windScore,
    dewPoint: dewScore,
    timeOfDay: timeScore,
    overall: overallScore,
  };
  
  // Get status and primary issue
  const status = getStatusFromScore(overallScore, hour);
  const { issue, emoji } = getPrimaryIssue(scores, {
    precipMm: precipitationMm,
    humidity: relativeHumidity,
    tempF: temperatureF,
    gustMph: windGustMph,
    spreadF: dewPointSpreadF,
    hour,
  });
  
  return {
    ...condition,
    scores,
    status,
    primaryIssue: issue,
    primaryIssueEmoji: emoji,
  };
}

/**
 * Recalculate mowing scores for an array of conditions.
 */
export function recalculateMowingConditions(
  conditions: MowingConditions[],
  thresholds: MowingThresholds
): MowingConditions[] {
  return conditions.map(c => recalculateMowingScores(c, thresholds));
}

/**
 * Fetch comprehensive mowing conditions from HRRR model.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 * Combines data from hrrr-height-agl (TMP, RH, DPT, wind) and hrrr-surface (GUST, APCP).
 * 
 * @param lat - Latitude
 * @param lng - Longitude
 * @returns Array of mowing conditions at 10-minute intervals with scores
 */
export async function fetchMowingConditions(
  lat: number,
  lng: number
): Promise<MowingConditions[]> {
  // Get available timestamps from HRRR and latest model run time in parallel
  const [heightAglMeta, surfaceMeta, hrrrRunTime] = await Promise.all([
    fetchCollectionMetadata('hrrr-height-agl'),
    fetchCollectionMetadata('hrrr-surface'),
    getLatestModelRun('hrrr-height-agl'),
  ]);
  
  // Find common timestamps between both collections
  const heightAglSet = new Set(heightAglMeta.availableTimestamps);
  const commonTimestamps = surfaceMeta.availableTimestamps.filter(t => heightAglSet.has(t));
  
  if (commonTimestamps.length === 0) {
    throw new Error('No HRRR timestamps available');
  }
  
  // Get the time range for the request
  const startTime = commonTimestamps[0];
  const endTime = commonTimestamps[commonTimestamps.length - 1];
  const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
  
  console.log(`HRRR: Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
  
  // Fetch from both collections in parallel with chunking for large time ranges
  const [heightAglData, surfaceData] = await Promise.all([
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/hrrr-height-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'TMP,RH,DPT,UGRD,VGRD',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/hrrr-surface/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'GUST,APCP',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
  ]);
  
  // Extract values (now at 10-minute intervals from server)
  const tmpValues: number[] = heightAglData?.ranges?.TMP?.values ?? [];
  const rhValues: number[] = heightAglData?.ranges?.RH?.values ?? [];
  const dptValues: number[] = heightAglData?.ranges?.DPT?.values ?? [];
  const ugrdValues: number[] = heightAglData?.ranges?.UGRD?.values ?? [];
  const vgrdValues: number[] = heightAglData?.ranges?.VGRD?.values ?? [];
  
  const gustValues: number[] = surfaceData?.ranges?.GUST?.values ?? [];
  const apcpValues: number[] = surfaceData?.ranges?.APCP?.values ?? [];
  
  // Get timestamps from response (now includes all interpolated times)
  const responseTimestamps: string[] = heightAglData?.domain?.axes?.t?.values ?? [];
  
  if (tmpValues.length === 0) {
    throw new Error('No temperature values in HRRR response');
  }
  
  console.log(`HRRR: Processing ${responseTimestamps.length} interpolated timestamps`);
  
  // Build conditions array (data is already at 10-minute intervals)
  const conditions: MowingConditions[] = [];
  
  for (let i = 0; i < responseTimestamps.length; i++) {
    const datetime = responseTimestamps[i];
    const blockTime = new Date(datetime);
    // Use local time for display/filtering (browser timezone)
    const hour = blockTime.getHours();
    const minute = blockTime.getMinutes();
    
    // Extract raw values (with defaults)
    const tmpK = tmpValues[i] ?? 288;  // ~59°F default
    const tmpF = kelvinToFahrenheit(tmpK);
    const tmpC = kelvinToCelsius(tmpK);
    
    const rh = rhValues[i] ?? 50;
    
    const dptK = dptValues[i] ?? (tmpK - 5);  // Default 5K spread
    const dptF = kelvinToFahrenheit(dptK);
    const spreadF = tmpF - dptF;
    
    const u = ugrdValues[i] ?? 0;
    const v = vgrdValues[i] ?? 0;
    const windSpeedMs = Math.sqrt(u * u + v * v);
    const windSpeedMph = windSpeedMs * 2.237;
    
    const gustMs = gustValues[i] ?? windSpeedMs * 1.5;  // Default gust = 1.5x sustained
    const gustMph = gustMs * 2.237;
    
    // Note: Server interpolates precipitation linearly, which represents accumulation rate
    const precipMm = apcpValues[i] ?? 0;
    
    // Calculate scores (5 factors: precip 35%, temp 20%, wind 15%, dew 15%, time 15%)
    const precipScore = calcPrecipitationScore(precipMm, rh);
    const tempScore = calcTemperatureScore(tmpF);
    const windScore = calcWindScore(gustMph);
    const dewScore = calcDewPointScore(spreadF, hour);
    const timeScore = calcTimeOfDayScore(hour);
    
    // Weighted overall score
    const overallScore = Math.round(
      precipScore * SCORE_WEIGHTS.precipitation +
      tempScore * SCORE_WEIGHTS.temperature +
      windScore * SCORE_WEIGHTS.wind +
      dewScore * SCORE_WEIGHTS.dewPoint +
      timeScore * SCORE_WEIGHTS.timeOfDay
    );
    
    const scores: MowScores = {
      precipitation: precipScore,
      temperature: tempScore,
      wind: windScore,
      dewPoint: dewScore,
      timeOfDay: timeScore,
      overall: overallScore,
    };
    
    // Get status and primary issue
    const status = getStatusFromScore(overallScore, hour);
    const { issue, emoji } = getPrimaryIssue(scores, {
      precipMm,
      humidity: rh,
      tempF: tmpF,
      gustMph,
      spreadF,
      hour,
    });
    
    conditions.push({
      datetime,
      hour,
      minute,  // Now from API timestamp (0, 10, 20, 30, 40, 50)
      model: 'hrrr',
      modelRunTime: hrrrRunTime ?? undefined,
      forecastLeadHours: hrrrRunTime 
        ? calculateForecastLeadHours(hrrrRunTime, datetime)
        : undefined,
      temperatureF: tmpF,
      temperatureC: tmpC,
      relativeHumidity: rh,
      dewPointF: dptF,
      dewPointSpreadF: spreadF,
      windSpeedMph,
      windGustMph: gustMph,
      precipitationMm: precipMm,
      precipProbability: null,  // HRRR uses APCP, not POP
      scores,
      status,
      primaryIssue: issue,
      primaryIssueEmoji: emoji,
    });
  }
  
  return conditions;
}

// Rename the HRRR function for clarity
export { fetchMowingConditions as fetchHRRRMowingData };

/**
 * Fetch mowing conditions from GFS model.
 * GFS has lower resolution (22km) but longer forecast horizon (up to 384 hours).
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 * Uses gfs-height-agl (TMP, RH, DPT, UGRD, VGRD) and gfs-surface (GUST, APCP).
 */
export async function fetchGFSMowingData(
  lat: number,
  lng: number,
  maxHours: number = 120
): Promise<MowingConditions[]> {
  // Get available timestamps from GFS and latest model run time in parallel
  const [heightAglMeta, surfaceMeta, gfsRunTime] = await Promise.all([
    fetchCollectionMetadata('gfs-height-agl'),
    fetchCollectionMetadata('gfs-surface'),
    getLatestModelRun('gfs-height-agl'),
  ]);
  
  // Find common timestamps between both collections
  const heightAglSet = new Set(heightAglMeta.availableTimestamps);
  const commonTimestamps = surfaceMeta.availableTimestamps.filter(t => heightAglSet.has(t));
  
  if (commonTimestamps.length === 0) {
    throw new Error('No GFS timestamps available');
  }
  
  // Limit to maxHours ahead
  const now = new Date();
  const maxTime = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
  const filteredTimestamps = commonTimestamps.filter(t => new Date(t) <= maxTime);
  
  if (filteredTimestamps.length === 0) {
    throw new Error('No GFS timestamps in requested time range');
  }
  
  // Get the time range for server-side interpolation
  const startTime = filteredTimestamps[0];
  const endTime = filteredTimestamps[filteredTimestamps.length - 1];
  const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
  
  console.log(`GFS: Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
  
  // Fetch from both collections in parallel with chunking for large time ranges
  const [heightAglData, surfaceData] = await Promise.all([
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/gfs-height-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'TMP,RH,DPT,UGRD,VGRD',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/gfs-surface/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'GUST,APCP',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
  ]);
  
  // Get timestamps from response (now includes all interpolated times)
  const responseTimestamps: string[] = (heightAglData?.domain as Record<string, unknown>)?.axes 
    ? ((heightAglData.domain as Record<string, unknown>).axes as Record<string, unknown>).t 
      ? (((heightAglData.domain as Record<string, unknown>).axes as Record<string, unknown>).t as { values?: string[] }).values ?? []
      : []
    : [];
  
  if (responseTimestamps.length === 0) {
    throw new Error('No timestamps in GFS response');
  }
  
  console.log(`GFS: Processing ${responseTimestamps.length} interpolated timestamps`);
  
  return buildMowingConditions(responseTimestamps, 'gfs', {
    tmpValues: heightAglData?.ranges?.TMP?.values ?? [],
    rhValues: heightAglData?.ranges?.RH?.values ?? [],
    dptValues: heightAglData?.ranges?.DPT?.values ?? [],
    ugrdValues: heightAglData?.ranges?.UGRD?.values ?? [],
    vgrdValues: heightAglData?.ranges?.VGRD?.values ?? [],
    gustValues: surfaceData?.ranges?.GUST?.values ?? [],
    apcpValues: surfaceData?.ranges?.APCP?.values ?? [],
    popValues: null,  // GFS uses APCP, not POP
  }, gfsRunTime);
}

/**
 * Fetch mowing conditions from NBM (National Blend of Models).
 * NBM has 2.5km resolution.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 * Uses 3 collections: nbm-conus-surface (APCP01), nbm-conus-2m-agl (TMP, DPT, RH), nbm-conus-10m-agl (GUST).
 * Note: POP is not available in current API, using APCP01 instead.
 */
export async function fetchNBMMowingData(
  lat: number,
  lng: number,
  maxHours: number = 72
): Promise<MowingConditions[]> {
  // Get available timestamps from all NBM collections and latest model run time in parallel
  const [surfaceMeta, agl2mMeta, agl10mMeta, nbmRunTime] = await Promise.all([
    fetchCollectionMetadata('nbm-conus-surface'),
    fetchCollectionMetadata('nbm-conus-2m-agl'),
    fetchCollectionMetadata('nbm-conus-10m-agl'),
    getLatestModelRun('nbm-conus-2m-agl'),
  ]);
  
  // Find common timestamps across all 3 collections
  const surfaceSet = new Set(surfaceMeta.availableTimestamps);
  const agl2mSet = new Set(agl2mMeta.availableTimestamps);
  const commonTimestamps = agl10mMeta.availableTimestamps.filter(
    t => surfaceSet.has(t) && agl2mSet.has(t)
  );
  
  if (commonTimestamps.length === 0) {
    throw new Error('No NBM timestamps available');
  }
  
  // Limit to maxHours ahead
  const now = new Date();
  const maxTime = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
  const filteredTimestamps = commonTimestamps.filter(t => new Date(t) <= maxTime);
  
  if (filteredTimestamps.length === 0) {
    throw new Error('No NBM timestamps in requested time range');
  }
  
  // Get the time range for server-side interpolation
  const startTime = filteredTimestamps[0];
  const endTime = filteredTimestamps[filteredTimestamps.length - 1];
  const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
  
  console.log(`NBM: Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
  
  // Fetch from all 3 collections in parallel with chunking for large time ranges
  const [surfaceData, agl2mData, agl10mData] = await Promise.all([
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/nbm-conus-surface/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'APCP01',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/nbm-conus-2m-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'TMP,DPT,RH',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/nbm-conus-10m-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'GUST',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
  ]);
  
  // Get timestamps from response (now includes all interpolated times)
  const responseTimestamps: string[] = agl2mData?.domain?.axes?.t?.values ?? [];
  
  if (responseTimestamps.length === 0) {
    throw new Error('No timestamps in NBM response');
  }
  
  console.log(`NBM: Processing ${responseTimestamps.length} interpolated timestamps`);
  
  return buildMowingConditions(responseTimestamps, 'nbm', {
    tmpValues: agl2mData?.ranges?.TMP?.values ?? [],
    rhValues: agl2mData?.ranges?.RH?.values ?? [],
    dptValues: agl2mData?.ranges?.DPT?.values ?? [],
    ugrdValues: null,
    vgrdValues: null,  // NBM doesn't have U/V, just GUST
    gustValues: agl10mData?.ranges?.GUST?.values ?? [],
    apcpValues: surfaceData?.ranges?.APCP01?.values ?? [],
    popValues: null,  // POP not available in current API
  }, nbmRunTime);
}

/**
 * Fetch mowing conditions from NDFD (National Digital Forecast Database).
 * NDFD is the official NWS forecast, 2.5km resolution, up to 7 days.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 * 
 * NOTE: NDFD collections updated 2026-01-14 with new collection IDs.
 * 
 * Available collections:
 * - ndfd-surface: POP12, SKY
 * - ndfd-2m: TMP, DPT, RH, WSPD, WDIR (2m above ground)
 * - ndfd-wind-2m-10m: WSPD, WDIR (wind at 2m and 10m)
 * 
 * Wind handling: NDFD provides WSPD (sustained wind) instead of GUST.
 * We estimate GUST ≈ WSPD × 1.4 (typical gust factor for open terrain).
 */
export async function fetchNDFDMowingData(
  lat: number,
  lng: number,
  maxHours: number = 168
): Promise<MowingConditions[]> {
  try {
    // Get available timestamps from NDFD collections and latest model run time in parallel
    const [surfaceMeta, ndfd2mMeta, windMeta, ndfdRunTime] = await Promise.all([
      fetchCollectionMetadata('ndfd-surface'),
      fetchCollectionMetadata('ndfd-2m'),
      fetchCollectionMetadata('ndfd-wind-2m-10m'),
      getLatestModelRun('ndfd-surface'),
    ]);
    
    // Find common timestamps across all collections
    const surfaceSet = new Set(surfaceMeta.availableTimestamps);
    const ndfd2mSet = new Set(ndfd2mMeta.availableTimestamps);
    const commonTimestamps = windMeta.availableTimestamps.filter(
      t => surfaceSet.has(t) && ndfd2mSet.has(t)
    );
    
    if (commonTimestamps.length === 0) {
      console.warn('NDFD: No common timestamps between collections');
      return [];
    }
    
    // Limit to maxHours ahead
    const now = new Date();
    const maxTime = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
    const filteredTimestamps = commonTimestamps.filter(t => new Date(t) <= maxTime);
    
    if (filteredTimestamps.length === 0) {
      console.warn('NDFD: No timestamps within maxHours range');
      return [];
    }
    
    // Get the time range for server-side interpolation
    const startTime = filteredTimestamps[0];
    const endTime = filteredTimestamps[filteredTimestamps.length - 1];
    const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
    
    console.log(`NDFD: Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
    
    // Fetch from all three collections in parallel using allSettled to handle failures gracefully
    const [surfaceResult, ndfd2mResult, windResult] = await Promise.allSettled([
      fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/ndfd-surface/position`, {
        coords: `POINT(${lng} ${lat})`,
        'parameter-name': 'POP12',
        datetime: `${startTime}/${endTime}`,
        interpolation: INTERPOLATION_CONFIG.method,
        step: stepParam,
        f: 'CoverageJSON',
      }),
      fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/ndfd-2m/position`, {
        coords: `POINT(${lng} ${lat})`,
        'parameter-name': 'TMP,DPT,RH',
        datetime: `${startTime}/${endTime}`,
        interpolation: INTERPOLATION_CONFIG.method,
        step: stepParam,
        f: 'CoverageJSON',
      }),
      fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/ndfd-wind-2m-10m/position`, {
        coords: `POINT(${lng} ${lat})`,
        'parameter-name': 'WSPD',
        datetime: `${startTime}/${endTime}`,
        interpolation: INTERPOLATION_CONFIG.method,
        step: stepParam,
        f: 'CoverageJSON',
      }),
    ]);
    
    // Parse responses, handling failures gracefully
    let surfaceData: CoverageJSONResponse | null = null;
    let ndfd2mData: CoverageJSONResponse | null = null;
    let windData: CoverageJSONResponse | null = null;
    
    if (surfaceResult.status === 'fulfilled') {
      surfaceData = surfaceResult.value;
    } else {
      console.warn('NDFD surface request failed:', surfaceResult.reason);
    }
    
    if (ndfd2mResult.status === 'fulfilled') {
      ndfd2mData = ndfd2mResult.value;
    } else {
      console.warn('NDFD 2m request failed:', ndfd2mResult.reason);
    }
    
    if (windResult.status === 'fulfilled') {
      windData = windResult.value;
    } else {
      console.warn('NDFD wind request failed:', windResult.reason);
    }
    
    // Extract values - use empty arrays for missing data
    const ranges = (data: CoverageJSONResponse | null) => data?.ranges ?? {};
    
    const domain = (data: CoverageJSONResponse | null) => data?.domain ?? {};
    
    // Get timestamps from whichever response succeeded (now includes interpolated times)
    const responseTimestamps: string[] = 
      domain(ndfd2mData)?.axes?.t?.values ?? 
      domain(windData)?.axes?.t?.values ?? 
      domain(surfaceData)?.axes?.t?.values ?? 
      [];
    
    if (responseTimestamps.length === 0) {
      console.warn('NDFD: No data returned');
      return [];
    }
    
    console.log(`NDFD: Processing ${responseTimestamps.length} interpolated timestamps`);
    
    const popValues: number[] = ranges(surfaceData)?.POP12?.values ?? [];
    const wspd10mValues: number[] = ranges(windData)?.WSPD?.values ?? [];
    const tmpValues: number[] = ranges(ndfd2mData)?.TMP?.values ?? [];
    const dptValues: number[] = ranges(ndfd2mData)?.DPT?.values ?? [];
    const rhValues: number[] = ranges(ndfd2mData)?.RH?.values ?? [];
    
    // NDFD provides WSPD (sustained wind) instead of GUST
    // Estimate gust from sustained wind: GUST ≈ WSPD × 1.4 (typical gust factor)
    const gustValues: number[] = wspd10mValues.map(wspd => wspd ? wspd * 1.4 : 0);
    
    // Check what data we actually got
    const hasTmp = tmpValues.some(v => v !== null && v !== undefined);
    const hasDpt = dptValues.some(v => v !== null && v !== undefined);
    const hasWspd = wspd10mValues.some(v => v !== null && v !== undefined);
    const hasPop = popValues.some(v => v !== null && v !== undefined);
    const hasRh = rhValues.some(v => v !== null && v !== undefined);
    
    console.log(`NDFD data available: TMP=${hasTmp}, DPT=${hasDpt}, WSPD=${hasWspd}, POP=${hasPop}, RH=${hasRh}`);
    
    // If we don't have enough data for meaningful scores, return empty
    // We need at least POP or RH to calculate precipitation score
    if (!hasPop && !hasRh) {
      console.warn('NDFD: Insufficient data (no POP or RH)');
      return [];
    }
    
    return buildMowingConditions(responseTimestamps, 'ndfd', {
      tmpValues,
      rhValues,
      dptValues,
      ugrdValues: null,
      vgrdValues: null,
      gustValues,
      apcpValues: null,
      popValues,
    }, ndfdRunTime);
  } catch (error) {
    console.warn('NDFD fetch failed:', error);
    return [];
  }
}

/**
 * Helper to build MowingConditions array from raw data.
 * Handles differences between models (APCP vs POP, U/V vs direct GUST).
 */
function buildMowingConditions(
  timestamps: string[],
  model: WeatherModel,
  data: {
    tmpValues: number[];
    rhValues: number[];
    dptValues: number[];
    ugrdValues: number[] | null;
    vgrdValues: number[] | null;
    gustValues: number[];
    apcpValues: number[] | null;
    popValues: number[] | null;
  },
  modelRunTime?: string | null
): MowingConditions[] {
  const conditions: MowingConditions[] = [];
  
  for (let i = 0; i < timestamps.length; i++) {
    const datetime = timestamps[i];
    const blockTime = new Date(datetime);
    // Use local time for display/filtering (browser timezone)
    const hour = blockTime.getHours();
    const minute = blockTime.getMinutes();
    
    // Temperature
    const tmpK = data.tmpValues[i] ?? 288;
    const tmpF = kelvinToFahrenheit(tmpK);
    const tmpC = kelvinToCelsius(tmpK);
    
    // Humidity
    const rh = data.rhValues[i] ?? 50;
    
    // Dew point
    const dptK = data.dptValues[i] ?? (tmpK - 5);
    const dptF = kelvinToFahrenheit(dptK);
    const spreadF = tmpF - dptF;
    
    // Wind speed (from U/V if available, otherwise estimate from gust)
    let windSpeedMph: number;
    if (data.ugrdValues && data.vgrdValues) {
      const u = data.ugrdValues[i] ?? 0;
      const v = data.vgrdValues[i] ?? 0;
      windSpeedMph = Math.sqrt(u * u + v * v) * 2.237;
    } else {
      // Estimate sustained wind as 60% of gust
      windSpeedMph = (data.gustValues[i] ?? 5) * 2.237 * 0.6;
    }
    
    // Gust
    const gustMs = data.gustValues[i] ?? (windSpeedMph / 2.237 * 1.5);
    const gustMph = gustMs * 2.237;
    
    // Precipitation - use APCP if available, otherwise derive from POP
    let precipMm: number;
    let precipProbability: number | null = null;
    
    if (data.apcpValues) {
      precipMm = data.apcpValues[i] ?? 0;
    } else if (data.popValues) {
      // POP-based models: estimate precip from probability
      precipProbability = data.popValues[i] ?? 0;
      // Convert POP to estimated precip (rough heuristic)
      precipMm = precipProbability > 50 ? (precipProbability / 100) * 2 : 0;
    } else {
      precipMm = 0;
    }
    
    // Calculate scores
    const precipScore = data.popValues 
      ? calcPrecipitationScoreFromPOP(data.popValues[i] ?? 0)
      : calcPrecipitationScore(precipMm, rh);
    const tempScore = calcTemperatureScore(tmpF);
    const windScore = calcWindScore(gustMph);
    const dewScore = calcDewPointScore(spreadF, hour);
    const timeScore = calcTimeOfDayScore(hour);
    
    const overallScore = Math.round(
      precipScore * SCORE_WEIGHTS.precipitation +
      tempScore * SCORE_WEIGHTS.temperature +
      windScore * SCORE_WEIGHTS.wind +
      dewScore * SCORE_WEIGHTS.dewPoint +
      timeScore * SCORE_WEIGHTS.timeOfDay
    );
    
    const scores: MowScores = {
      precipitation: precipScore,
      temperature: tempScore,
      wind: windScore,
      dewPoint: dewScore,
      timeOfDay: timeScore,
      overall: overallScore,
    };
    
    const status = getStatusFromScore(overallScore, hour);
    const { issue, emoji } = getPrimaryIssue(scores, {
      precipMm,
      humidity: rh,
      tempF: tmpF,
      gustMph,
      spreadF,
      hour,
    });
    
    conditions.push({
      datetime,
      hour,
      minute,  // From API timestamp (supports interpolated times)
      model,
      modelRunTime: modelRunTime ?? undefined,
      forecastLeadHours: modelRunTime 
        ? calculateForecastLeadHours(modelRunTime, datetime)
        : undefined,
      temperatureF: tmpF,
      temperatureC: tmpC,
      relativeHumidity: rh,
      dewPointF: dptF,
      dewPointSpreadF: spreadF,
      windSpeedMph,
      windGustMph: gustMph,
      precipitationMm: precipMm,
      precipProbability,
      scores,
      status,
      primaryIssue: issue,
      primaryIssueEmoji: emoji,
    });
  }
  
  return conditions;
}

/**
 * Calculate precipitation score from POP (Probability of Precipitation).
 * Used by NBM and NDFD models.
 */
function calcPrecipitationScoreFromPOP(popPercent: number): number {
  if (popPercent <= 10) return 100;
  if (popPercent <= 30) return 80;
  if (popPercent <= 50) return 50;
  if (popPercent <= 70) return 20;
  return 0;
}

/**
 * Fetch mowing data from all models in parallel.
 * Returns data organized by model plus a blended "best" forecast.
 * 
 * Uses Promise.allSettled to handle individual model failures gracefully.
 * Only throws an error if ALL models fail to fetch data.
 */
export async function fetchMultiModelMowingData(
  lat: number,
  lng: number
): Promise<MultiModelMowingData> {
  // Fetch all models in parallel, with error handling for each
  const [hrrrResult, gfsResult, nbmResult, ndfdResult] = await Promise.allSettled([
    fetchMowingConditions(lat, lng),
    fetchGFSMowingData(lat, lng, 120),
    fetchNBMMowingData(lat, lng, 72),
    fetchNDFDMowingData(lat, lng, 168),
  ]);
  
  const hrrr = hrrrResult.status === 'fulfilled' ? hrrrResult.value : [];
  const gfs = gfsResult.status === 'fulfilled' ? gfsResult.value : [];
  const nbm = nbmResult.status === 'fulfilled' ? nbmResult.value : [];
  const ndfd = ndfdResult.status === 'fulfilled' ? ndfdResult.value : [];
  
  // Log any failures
  if (hrrrResult.status === 'rejected') console.warn('HRRR fetch failed:', hrrrResult.reason);
  if (gfsResult.status === 'rejected') console.warn('GFS fetch failed:', gfsResult.reason);
  if (nbmResult.status === 'rejected') console.warn('NBM fetch failed:', nbmResult.reason);
  if (ndfdResult.status === 'rejected') console.warn('NDFD fetch failed:', ndfdResult.reason);
  
  // Check if ALL models failed (excluding NDFD which is disabled)
  const hasAnyData = hrrr.length > 0 || gfs.length > 0 || nbm.length > 0;
  if (!hasAnyData) {
    // Build a descriptive error message
    const errors: string[] = [];
    if (hrrrResult.status === 'rejected') errors.push(`HRRR: ${hrrrResult.reason}`);
    if (gfsResult.status === 'rejected') errors.push(`GFS: ${gfsResult.reason}`);
    if (nbmResult.status === 'rejected') errors.push(`NBM: ${nbmResult.reason}`);
    
    throw new Error(
      `Unable to fetch weather data from any model. ` +
      `Please check your internet connection and try again. ` +
      (errors.length > 0 ? `Details: ${errors.join('; ')}` : '')
    );
  }
  
  // Data now comes pre-interpolated at 10-minute intervals from the server
  // Create blended forecast: HRRR (0-18h) -> NBM (18-48h) -> GFS (48h+)
  const blended = blendModelData(hrrr, nbm, gfs);
  
  return {
    location: { lat, lng },
    fetchedAt: new Date().toISOString(),
    models: { 
      hrrr, 
      gfs, 
      nbm, 
      ndfd 
    },
    blended,
  };
}

/**
 * Blend data from multiple models for the "simple" view.
 * Priority: HRRR (0-18h) -> NBM (18-48h) -> GFS (48h+)
 * 
 * This provides the best of each model:
 * - HRRR: Highest resolution, best for next 18 hours
 * - NBM: Good blend of models, reliable for 18-48 hours
 * - GFS: Global model, extends forecast to 5 days
 * 
 * Data comes pre-interpolated at 10-minute intervals from the server.
 */
function blendModelData(
  hrrr: MowingConditions[],
  nbm: MowingConditions[],
  gfs: MowingConditions[]
): MowingConditions[] {
  const now = new Date();
  const blended: MowingConditions[] = [];
  const usedTimestamps = new Set<string>();
  
  // Phase 1: HRRR for 0-18 hours (all 10-minute intervals)
  const hrrrCutoff = new Date(now.getTime() + 18 * 60 * 60 * 1000);
  for (const condition of hrrr) {
    const dt = new Date(condition.datetime);
    if (dt <= hrrrCutoff) {
      blended.push(condition);
      usedTimestamps.add(condition.datetime);
    }
  }
  
  // Phase 2: NBM for 18-48 hours (all 10-minute intervals)
  const nbmCutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  for (const condition of nbm) {
    const dt = new Date(condition.datetime);
    if (dt > hrrrCutoff && dt <= nbmCutoff && !usedTimestamps.has(condition.datetime)) {
      blended.push(condition);
      usedTimestamps.add(condition.datetime);
    }
  }
  
  // Phase 3: GFS for 48+ hours (all 10-minute intervals)
  for (const condition of gfs) {
    const dt = new Date(condition.datetime);
    if (dt > nbmCutoff && !usedTimestamps.has(condition.datetime)) {
      blended.push(condition);
      usedTimestamps.add(condition.datetime);
    }
  }
  
  // Sort by datetime
  blended.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
  
  const hrrrCount = blended.filter(c => c.model === 'hrrr').length;
  const nbmCount = blended.filter(c => c.model === 'nbm').length;
  const gfsCount = blended.filter(c => c.model === 'gfs').length;
  console.log(`Blended forecast: ${blended.length} intervals (HRRR: ${hrrrCount}, NBM: ${nbmCount}, GFS: ${gfsCount})`);
  
  return blended;
}

/**
 * Legacy function for backwards compatibility.
 * Wraps fetchMowingConditions and converts to old format.
 * @deprecated Use fetchMowingConditions instead
 */
export async function fetchMowingForecast(
  lat: number,
  lng: number,
  _intervalHours: number = 3,
  _startHour: number = 6,
  _slotsPerDay: number = 6,
  humidityThreshold: number = 85
): Promise<MowingForecast[]> {
  try {
    const conditions = await fetchMowingConditions(lat, lng);
    return conditions.map(c => ({
      datetime: c.datetime,
      relativeHumidity: c.relativeHumidity,
      isDry: c.relativeHumidity < humidityThreshold,
      hour: c.hour,
    }));
  } catch (error) {
    // Fall back to GFS if HRRR fails
    console.warn('HRRR failed, falling back to GFS:', error);
    return fetchMowingForecastGFS(lat, lng, humidityThreshold);
  }
}

/**
 * Fallback GFS-based mowing forecast (simpler, less accurate)
 */
async function fetchMowingForecastGFS(
  lat: number,
  lng: number,
  humidityThreshold: number
): Promise<MowingForecast[]> {
  const metadata = await fetchCollectionMetadata('gfs-height-agl');
  
  if (metadata.availableTimestamps.length === 0) {
    throw new Error('No GFS timestamps available');
  }
  
  const datetimeParam = metadata.availableTimestamps.slice(0, 24).join(',');
  
  const response = await authFetch(`${getEdrBaseUrl()}/edr/collections/gfs-height-agl/position?` + new URLSearchParams({
    coords: `POINT(${lng} ${lat})`,
    'parameter-name': 'RH',
    datetime: datetimeParam,
    f: 'CoverageJSON',
  }));
  
  if (!response.ok) {
    throw new Error(`GFS request failed: ${response.status}`);
  }
  
  const data = await response.json();
  const rhValues: number[] = data?.ranges?.RH?.values ?? [];
  const responseTimestamps: string[] = data?.domain?.axes?.t?.values ?? [];
  
  return responseTimestamps.map((datetime, i) => {
    const rh = rhValues[i] ?? 50;
    const blockTime = new Date(datetime);
    return {
      datetime,
      relativeHumidity: rh,
      isDry: rh < humidityThreshold,
      hour: blockTime.getHours(),
    };
  });
}

// ============================================================
// PAINTING CONDITIONS - Comprehensive Paint Score System
// Supports multiple weather models: HRRR, GFS, NBM
// ============================================================

export type PaintStatus = 'great' | 'good' | 'marginal' | 'poor' | 'bad' | 'night' | 'unavailable';

export interface PaintScores {
  precipitation: number;  // 0-100 (weight: 35%)
  temperature: number;    // 0-100 (weight: 25%)
  humidity: number;       // 0-100 (weight: 20%)
  wind: number;           // 0-100 (weight: 10%)
  dewRisk: number;        // 0-100 (weight: 5%)
  timeOfDay: number;      // 0-100 (weight: 5%)
  overall: number;        // 0-100 weighted average
}

// TODO: Allow manual timezone selection or use location's timezone
// Currently uses browser's local timezone via Date.getHours()
export interface PaintingConditions {
  datetime: string;       // ISO 8601 timestamp (UTC)
  hour: number;           // Local hour (0-23) for display/filtering
  minute: number;         // Local minute (0, 10, 20, 30, 40, 50)
  model: WeatherModel;
  // Model run metadata (optional for backwards compatibility)
  modelRunTime?: string;       // ISO 8601 model initialization time
  forecastLeadHours?: number;  // Hours from model run to valid time
  // Raw values
  temperatureF: number;
  temperatureC: number;
  relativeHumidity: number;
  dewPointF: number;
  dewPointSpreadF: number;  // TMP - DPT (larger = less condensation risk)
  windSpeedMph: number;
  windGustMph: number;
  precipitationMm: number;
  precipProbability: number | null;  // POP from NBM (0-100%)
  // Scores
  scores: PaintScores;
  // Status
  status: PaintStatus;
  // Primary issue (if any)
  primaryIssue: string | null;
  primaryIssueEmoji: string | null;
}

// Multi-model data structure for painting
export interface MultiModelPaintingData {
  location: { lat: number; lng: number };
  fetchedAt: string;
  models: {
    hrrr: PaintingConditions[];
    gfs: PaintingConditions[];
    nbm: PaintingConditions[];
    ndfd: PaintingConditions[];
  };
  // Blended "best" forecast for simple view (HRRR → NBM → GFS)
  blended: PaintingConditions[];
}

// Score weights for painting
const PAINT_SCORE_WEIGHTS = {
  precipitation: 0.35,
  temperature: 0.25,
  humidity: 0.20,
  wind: 0.10,
  dewRisk: 0.05,
  timeOfDay: 0.05,
};

/**
 * Calculate precipitation score for painting.
 * Painting requires completely dry conditions.
 */
function calcPaintPrecipitationScore(precipMm: number, precipProbability: number | null, humidity: number): number {
  // Any rain is a dealbreaker
  if (precipMm > 0.5) return 0;
  if (precipMm > 0.1) return 10;
  
  // Use POP if available
  if (precipProbability !== null) {
    if (precipProbability > 70) return 0;
    if (precipProbability > 50) return 20;
    if (precipProbability > 30) return 50;
    if (precipProbability > 10) return 80;
    return 100;
  }
  
  // Fall back to humidity as proxy
  if (humidity > 95) return 0;
  if (humidity > 90) return 20;
  if (humidity > 85) return 50;
  if (humidity > 80) return 70;
  return 100;
}

/**
 * Calculate temperature score for painting.
 * Most paints require 50-85°F (10-29°C) for proper application and curing.
 * Ideal range is 60-75°F.
 */
function calcPaintTemperatureScore(tempF: number): number {
  // Ideal range: 60-75°F
  if (tempF >= 60 && tempF <= 75) return 100;
  
  // Good range: 55-60°F and 75-80°F
  if (tempF >= 55 && tempF < 60) return 85;
  if (tempF > 75 && tempF <= 80) return 85;
  
  // Acceptable: 50-55°F and 80-85°F
  if (tempF >= 50 && tempF < 55) return 60;
  if (tempF > 80 && tempF <= 85) return 60;
  
  // Marginal: 45-50°F (paint may not cure) and 85-90°F (dries too fast)
  if (tempF >= 45 && tempF < 50) return 30;
  if (tempF > 85 && tempF <= 90) return 30;
  
  // Too cold or too hot - paint won't work properly
  return 0;
}

/**
 * Calculate humidity score for painting.
 * Ideal: 40-50% RH
 * Acceptable: 30-70% RH
 * High humidity prevents proper drying and causes defects.
 */
function calcPaintHumidityScore(humidity: number): number {
  // Ideal range
  if (humidity >= 40 && humidity <= 50) return 100;
  
  // Good range
  if (humidity >= 35 && humidity < 40) return 90;
  if (humidity > 50 && humidity <= 55) return 90;
  
  // Acceptable range
  if (humidity >= 30 && humidity < 35) return 75;
  if (humidity > 55 && humidity <= 60) return 75;
  
  // Starting to get problematic
  if (humidity >= 25 && humidity < 30) return 60;
  if (humidity > 60 && humidity <= 70) return 60;
  
  // Poor conditions
  if (humidity > 70 && humidity <= 80) return 30;
  if (humidity < 25) return 50; // Too dry can also cause issues
  
  // High humidity - paint won't dry properly
  if (humidity > 80 && humidity <= 85) return 15;
  return 0; // > 85% - don't paint
}

/**
 * Calculate wind score for painting.
 * Wind causes overspray, debris in wet paint, uneven drying.
 * Painting is more sensitive to wind than mowing.
 */
function calcPaintWindScore(gustMph: number): number {
  if (gustMph < 5) return 100;   // Ideal - calm
  if (gustMph < 8) return 90;    // Very light breeze
  if (gustMph < 10) return 75;   // Light breeze - manageable
  if (gustMph < 15) return 50;   // Moderate - overspray risk
  if (gustMph < 20) return 25;   // Windy - difficult
  return 0;                       // Too windy - don't paint
}

/**
 * Calculate dew risk score for painting.
 * If surface temperature approaches dew point, moisture condenses
 * and paint won't adhere properly.
 * Need at least 5°F spread, ideally 10°F+
 */
function calcPaintDewRiskScore(spreadF: number, hour: number): number {
  // Afternoon - dew has evaporated, less risk
  if (hour >= 11 && hour < 18) {
    if (spreadF > 10) return 100;
    if (spreadF > 5) return 80;
    if (spreadF > 3) return 50;
    return 20;
  }
  
  // Morning and evening - higher dew risk
  if (spreadF > 15) return 100;
  if (spreadF > 10) return 75;
  if (spreadF > 5) return 40;
  if (spreadF > 3) return 20;
  return 0; // High condensation risk
}

/**
 * Calculate time of day score for painting.
 * Best: mid-morning to late afternoon (avoid early morning dew, evening moisture)
 * Need time for paint to dry before nightfall
 */
function calcPaintTimeOfDayScore(hour: number): number {
  // Prime painting hours: 10am - 4pm (paint has time to dry)
  if (hour >= 10 && hour < 16) return 100;
  
  // Good: 8-10am and 4-6pm
  if (hour >= 8 && hour < 10) return 75;
  if (hour >= 16 && hour < 18) return 75;
  
  // Marginal: 6-8am (dew) and 6-7pm (limited drying time)
  if (hour >= 6 && hour < 8) return 40;
  if (hour >= 18 && hour < 19) return 40;
  
  // Poor: 7-9pm (paint may not dry before nightfall)
  if (hour >= 19 && hour < 21) return 20;
  
  // Night - don't paint
  return 0;
}

/**
 * Determine status from overall paint score and hour
 */
function getPaintStatusFromScore(score: number, hour: number): PaintStatus {
  if (hour < 6 || hour >= 21) return 'night';
  if (score >= 80) return 'great';
  if (score >= 60) return 'good';
  if (score >= 40) return 'marginal';
  if (score >= 20) return 'poor';
  return 'bad';
}

/**
 * Determine the primary issue for painting based on scores
 */
function getPaintPrimaryIssue(
  scores: PaintScores,
  conditions: {
    precipMm: number;
    precipProbability: number | null;
    humidity: number;
    tempF: number;
    gustMph: number;
    spreadF: number;
    hour: number;
  }
): { issue: string | null; emoji: string | null } {
  const { precipMm, precipProbability, humidity, tempF, gustMph, spreadF, hour } = conditions;
  
  // Find the lowest score (biggest problem)
  const scoreEntries = [
    { name: 'precipitation', score: scores.precipitation },
    { name: 'temperature', score: scores.temperature },
    { name: 'humidity', score: scores.humidity },
    { name: 'wind', score: scores.wind },
    { name: 'dewRisk', score: scores.dewRisk },
    { name: 'timeOfDay', score: scores.timeOfDay },
  ];
  
  scoreEntries.sort((a, b) => a.score - b.score);
  const worst = scoreEntries[0];
  
  // If overall is good, no issue
  if (scores.overall >= 80) {
    return { issue: null, emoji: null };
  }
  
  // Generate issue message based on worst factor
  switch (worst.name) {
    case 'precipitation':
      if (precipMm > 0.1) return { issue: `Rain (${precipMm.toFixed(1)}mm)`, emoji: '🌧️' };
      if (precipProbability !== null && precipProbability > 30) {
        return { issue: `${Math.round(precipProbability)}% rain chance`, emoji: '🌧️' };
      }
      if (humidity > 85) return { issue: `Very humid (${Math.round(humidity)}%)`, emoji: '💧' };
      return { issue: 'Precipitation risk', emoji: '🌧️' };
    
    case 'temperature':
      if (tempF < 50) return { issue: `Too cold (${Math.round(tempF)}°F)`, emoji: '🥶' };
      if (tempF > 85) return { issue: `Too hot (${Math.round(tempF)}°F)`, emoji: '🥵' };
      if (tempF < 60) return { issue: `Cool (${Math.round(tempF)}°F)`, emoji: '🌡️' };
      return { issue: `Warm (${Math.round(tempF)}°F)`, emoji: '🌡️' };
    
    case 'humidity':
      if (humidity > 70) return { issue: `High humidity (${Math.round(humidity)}%)`, emoji: '💧' };
      if (humidity < 30) return { issue: `Very dry (${Math.round(humidity)}%)`, emoji: '🏜️' };
      return { issue: `Humidity ${Math.round(humidity)}%`, emoji: '💧' };
    
    case 'wind':
      return { issue: `Windy (${Math.round(gustMph)} mph gusts)`, emoji: '💨' };
    
    case 'dewRisk':
      if (spreadF < 5) return { issue: 'Condensation risk', emoji: '💧' };
      return { issue: 'Dew risk', emoji: '💧' };
    
    case 'timeOfDay':
      if (hour >= 21 || hour < 6) return { issue: 'Too dark', emoji: '🌙' };
      if (hour < 8) return { issue: 'Too early (dew)', emoji: '🌅' };
      if (hour >= 18) return { issue: 'Limited drying time', emoji: '🌆' };
      return { issue: 'Not ideal time', emoji: '⏰' };
    
    default:
      return { issue: null, emoji: null };
  }
}

// =============================================================================
// Configurable Painting Scoring Functions (using user thresholds)
// =============================================================================

/**
 * Calculate painting temperature score using configurable thresholds.
 */
function calcPaintTemperatureScoreConfigurable(
  tempF: number,
  thresholds?: PaintingThresholds
): number {
  if (!thresholds) return calcPaintTemperatureScore(tempF);
  
  const { idealMin, idealMax } = thresholds.ranges.temperature;
  // Use configurable ideal range, with fixed bounds for 0 score
  return calcRangeScore(tempF, idealMin, idealMax, 40, 100);
}

/**
 * Calculate painting humidity score using configurable thresholds.
 */
function calcPaintHumidityScoreConfigurable(
  humidity: number,
  thresholds?: PaintingThresholds
): number {
  if (!thresholds) return calcPaintHumidityScore(humidity);
  
  const { idealMin, idealMax } = thresholds.ranges.humidity;
  // Use configurable ideal range, with fixed bounds
  return calcRangeScore(humidity, idealMin, idealMax, 0, 100);
}

/**
 * Calculate painting wind score using configurable thresholds.
 */
function calcPaintWindScoreConfigurable(
  gustMph: number,
  thresholds?: PaintingThresholds
): number {
  if (!thresholds) return calcPaintWindScore(gustMph);
  
  const { idealMax } = thresholds.ranges.wind;
  // 0 mph to idealMax is ideal, score drops to 0 at 30mph
  return calcMaxScore(gustMph, idealMax, 30);
}

/**
 * Recalculate painting scores for a single condition block using custom thresholds.
 */
export function recalculatePaintingScores(
  condition: PaintingConditions,
  thresholds: PaintingThresholds
): PaintingConditions {
  const {
    temperatureF,
    relativeHumidity,
    precipitationMm,
    precipProbability,
    windGustMph,
    dewPointSpreadF,
    hour,
  } = condition;
  
  // Calculate scores with custom thresholds
  const precipScore = calcPaintPrecipitationScore(precipitationMm, precipProbability, relativeHumidity);
  const tempScore = calcPaintTemperatureScoreConfigurable(temperatureF, thresholds);
  const humidityScore = calcPaintHumidityScoreConfigurable(relativeHumidity, thresholds);
  const windScore = calcPaintWindScoreConfigurable(windGustMph, thresholds);
  const dewRiskScore = calcPaintDewRiskScore(dewPointSpreadF, hour); // Not configurable
  const timeScore = calcPaintTimeOfDayScore(hour); // Not configurable
  
  // Calculate weighted overall using custom weights, only for enabled factors
  const weights = thresholds.weights;
  const enabled = thresholds.enabled;
  
  // Calculate total weight of enabled factors for normalization
  const totalEnabledWeight = 
    (enabled.precipitation ? weights.precipitation : 0) +
    (enabled.temperature ? weights.temperature : 0) +
    (enabled.humidity ? weights.humidity : 0) +
    (enabled.wind ? weights.wind : 0) +
    (enabled.dewRisk ? weights.dewRisk : 0) +
    (enabled.timeOfDay ? weights.timeOfDay : 0);
  
  // Calculate weighted sum
  // Each factor: score (0-100) * weight (0-100), so we divide by totalEnabledWeight to normalize
  const weightedSum = 
    (enabled.precipitation ? precipScore * weights.precipitation : 0) +
    (enabled.temperature ? tempScore * weights.temperature : 0) +
    (enabled.humidity ? humidityScore * weights.humidity : 0) +
    (enabled.wind ? windScore * weights.wind : 0) +
    (enabled.dewRisk ? dewRiskScore * weights.dewRisk : 0) +
    (enabled.timeOfDay ? timeScore * weights.timeOfDay : 0);
  
  // Divide by total enabled weight to get score 0-100
  const overallScore = totalEnabledWeight > 0 
    ? Math.round(weightedSum / totalEnabledWeight) 
    : 0;
  
  const scores: PaintScores = {
    precipitation: precipScore,
    temperature: tempScore,
    humidity: humidityScore,
    wind: windScore,
    dewRisk: dewRiskScore,
    timeOfDay: timeScore,
    overall: overallScore,
  };
  
  // Get status and primary issue
  const status = getPaintStatusFromScore(overallScore, hour);
  const { issue, emoji } = getPaintPrimaryIssue(scores, {
    precipMm: precipitationMm,
    precipProbability,
    humidity: relativeHumidity,
    tempF: temperatureF,
    gustMph: windGustMph,
    spreadF: dewPointSpreadF,
    hour,
  });
  
  return {
    ...condition,
    scores,
    status,
    primaryIssue: issue,
    primaryIssueEmoji: emoji,
  };
}

/**
 * Recalculate painting scores for an array of conditions.
 */
export function recalculatePaintingConditions(
  conditions: PaintingConditions[],
  thresholds: PaintingThresholds
): PaintingConditions[] {
  return conditions.map(c => recalculatePaintingScores(c, thresholds));
}

/**
 * Build PaintingConditions array from raw weather data.
 */
function buildPaintingConditions(
  timestamps: string[],
  model: WeatherModel,
  data: {
    tmpValues: number[];
    rhValues: number[];
    dptValues: number[];
    ugrdValues: number[] | null;
    vgrdValues: number[] | null;
    gustValues: number[];
    apcpValues: number[] | null;
    popValues: number[] | null;
  },
  modelRunTime?: string | null
): PaintingConditions[] {
  const conditions: PaintingConditions[] = [];
  
  for (let i = 0; i < timestamps.length; i++) {
    const datetime = timestamps[i];
    const blockTime = new Date(datetime);
    // Use local time for display/filtering (browser timezone)
    const hour = blockTime.getHours();
    const minute = blockTime.getMinutes();
    
    // Temperature
    const tmpK = data.tmpValues[i] ?? 288;
    const tmpF = kelvinToFahrenheit(tmpK);
    const tmpC = kelvinToCelsius(tmpK);
    
    // Humidity
    const rh = data.rhValues[i] ?? 50;
    
    // Dew point
    const dptK = data.dptValues[i] ?? (tmpK - 5);
    const dptF = kelvinToFahrenheit(dptK);
    const spreadF = tmpF - dptF;
    
    // Wind speed (from U/V if available, otherwise estimate from gust)
    let windSpeedMph: number;
    if (data.ugrdValues && data.vgrdValues) {
      const u = data.ugrdValues[i] ?? 0;
      const v = data.vgrdValues[i] ?? 0;
      windSpeedMph = Math.sqrt(u * u + v * v) * 2.237;
    } else {
      windSpeedMph = (data.gustValues[i] ?? 5) * 2.237 * 0.6;
    }
    
    // Gust
    const gustMs = data.gustValues[i] ?? (windSpeedMph / 2.237 * 1.5);
    const gustMph = gustMs * 2.237;
    
    // Precipitation
    let precipMm: number;
    let precipProbability: number | null = null;
    
    if (data.apcpValues) {
      precipMm = data.apcpValues[i] ?? 0;
    } else if (data.popValues) {
      precipProbability = data.popValues[i] ?? 0;
      precipMm = precipProbability > 50 ? (precipProbability / 100) * 2 : 0;
    } else {
      precipMm = 0;
    }
    
    // Calculate scores
    const precipScore = calcPaintPrecipitationScore(precipMm, precipProbability, rh);
    const tempScore = calcPaintTemperatureScore(tmpF);
    const humidityScore = calcPaintHumidityScore(rh);
    const windScore = calcPaintWindScore(gustMph);
    const dewScore = calcPaintDewRiskScore(spreadF, hour);
    const timeScore = calcPaintTimeOfDayScore(hour);
    
    const overallScore = Math.round(
      precipScore * PAINT_SCORE_WEIGHTS.precipitation +
      tempScore * PAINT_SCORE_WEIGHTS.temperature +
      humidityScore * PAINT_SCORE_WEIGHTS.humidity +
      windScore * PAINT_SCORE_WEIGHTS.wind +
      dewScore * PAINT_SCORE_WEIGHTS.dewRisk +
      timeScore * PAINT_SCORE_WEIGHTS.timeOfDay
    );
    
    const scores: PaintScores = {
      precipitation: precipScore,
      temperature: tempScore,
      humidity: humidityScore,
      wind: windScore,
      dewRisk: dewScore,
      timeOfDay: timeScore,
      overall: overallScore,
    };
    
    const status = getPaintStatusFromScore(overallScore, hour);
    const { issue, emoji } = getPaintPrimaryIssue(scores, {
      precipMm,
      precipProbability,
      humidity: rh,
      tempF: tmpF,
      gustMph,
      spreadF,
      hour,
    });
    
    conditions.push({
      datetime,
      hour,
      minute,  // From API timestamp (supports interpolated times)
      model,
      modelRunTime: modelRunTime ?? undefined,
      forecastLeadHours: modelRunTime 
        ? calculateForecastLeadHours(modelRunTime, datetime)
        : undefined,
      temperatureF: tmpF,
      temperatureC: tmpC,
      relativeHumidity: rh,
      dewPointF: dptF,
      dewPointSpreadF: spreadF,
      windSpeedMph,
      windGustMph: gustMph,
      precipitationMm: precipMm,
      precipProbability,
      scores,
      status,
      primaryIssue: issue,
      primaryIssueEmoji: emoji,
    });
  }
  
  return conditions;
}

/**
 * Fetch painting conditions from HRRR model.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 */
export async function fetchHRRRPaintingData(
  lat: number,
  lng: number
): Promise<PaintingConditions[]> {
  const [heightAglMeta, surfaceMeta, hrrrRunTime] = await Promise.all([
    fetchCollectionMetadata('hrrr-height-agl'),
    fetchCollectionMetadata('hrrr-surface'),
    getLatestModelRun('hrrr-height-agl'),
  ]);
  
  const heightAglSet = new Set(heightAglMeta.availableTimestamps);
  const commonTimestamps = surfaceMeta.availableTimestamps.filter(t => heightAglSet.has(t));
  
  if (commonTimestamps.length === 0) {
    throw new Error('No HRRR timestamps available');
  }
  
  // Get the time range for server-side interpolation
  const startTime = commonTimestamps[0];
  const endTime = commonTimestamps[commonTimestamps.length - 1];
  const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
  
  console.log(`HRRR (painting): Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
  
  // Fetch from both collections in parallel with chunking for large time ranges
  const [heightAglData, surfaceData] = await Promise.all([
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/hrrr-height-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'TMP,RH,DPT,UGRD,VGRD',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/hrrr-surface/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'GUST,APCP',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
  ]);
  
  const responseTimestamps: string[] = heightAglData?.domain?.axes?.t?.values ?? [];
  
  if (responseTimestamps.length === 0) {
    throw new Error('No timestamps in HRRR painting response');
  }
  
  console.log(`HRRR (painting): Processing ${responseTimestamps.length} interpolated timestamps`);
  
  return buildPaintingConditions(responseTimestamps, 'hrrr', {
    tmpValues: heightAglData?.ranges?.TMP?.values ?? [],
    rhValues: heightAglData?.ranges?.RH?.values ?? [],
    dptValues: heightAglData?.ranges?.DPT?.values ?? [],
    ugrdValues: heightAglData?.ranges?.UGRD?.values ?? [],
    vgrdValues: heightAglData?.ranges?.VGRD?.values ?? [],
    gustValues: surfaceData?.ranges?.GUST?.values ?? [],
    apcpValues: surfaceData?.ranges?.APCP?.values ?? [],
    popValues: null,
  }, hrrrRunTime);
}

/**
 * Fetch painting conditions from GFS model.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 */
export async function fetchGFSPaintingData(
  lat: number,
  lng: number,
  maxHours: number = 120
): Promise<PaintingConditions[]> {
  const [heightAglMeta, surfaceMeta, gfsRunTime] = await Promise.all([
    fetchCollectionMetadata('gfs-height-agl'),
    fetchCollectionMetadata('gfs-surface'),
    getLatestModelRun('gfs-height-agl'),
  ]);
  
  const heightAglSet = new Set(heightAglMeta.availableTimestamps);
  const commonTimestamps = surfaceMeta.availableTimestamps.filter(t => heightAglSet.has(t));
  
  if (commonTimestamps.length === 0) {
    throw new Error('No GFS timestamps available');
  }
  
  const now = new Date();
  const maxTime = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
  const filteredTimestamps = commonTimestamps.filter(t => new Date(t) <= maxTime);
  
  if (filteredTimestamps.length === 0) {
    throw new Error('No GFS timestamps in requested time range');
  }
  
  // Get the time range for server-side interpolation
  const startTime = filteredTimestamps[0];
  const endTime = filteredTimestamps[filteredTimestamps.length - 1];
  const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
  
  console.log(`GFS (painting): Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
  
  // Fetch from both collections in parallel with chunking for large time ranges
  const [heightAglData, surfaceData] = await Promise.all([
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/gfs-height-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'TMP,RH,DPT,UGRD,VGRD',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/gfs-surface/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'GUST,APCP',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
  ]);
  
  const responseTimestamps: string[] = heightAglData?.domain?.axes?.t?.values ?? [];
  
  if (responseTimestamps.length === 0) {
    throw new Error('No timestamps in GFS painting response');
  }
  
  console.log(`GFS (painting): Processing ${responseTimestamps.length} interpolated timestamps`);
  
  return buildPaintingConditions(responseTimestamps, 'gfs', {
    tmpValues: heightAglData?.ranges?.TMP?.values ?? [],
    rhValues: heightAglData?.ranges?.RH?.values ?? [],
    dptValues: heightAglData?.ranges?.DPT?.values ?? [],
    ugrdValues: heightAglData?.ranges?.UGRD?.values ?? [],
    vgrdValues: heightAglData?.ranges?.VGRD?.values ?? [],
    gustValues: surfaceData?.ranges?.GUST?.values ?? [],
    apcpValues: surfaceData?.ranges?.APCP?.values ?? [],
    popValues: null,
  }, gfsRunTime);
}

/**
 * Fetch painting conditions from NBM model.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 */
export async function fetchNBMPaintingData(
  lat: number,
  lng: number,
  maxHours: number = 72
): Promise<PaintingConditions[]> {
  const [surfaceMeta, agl2mMeta, agl10mMeta, nbmRunTime] = await Promise.all([
    fetchCollectionMetadata('nbm-conus-surface'),
    fetchCollectionMetadata('nbm-conus-2m-agl'),
    fetchCollectionMetadata('nbm-conus-10m-agl'),
    getLatestModelRun('nbm-conus-2m-agl'),
  ]);
  
  const surfaceSet = new Set(surfaceMeta.availableTimestamps);
  const agl2mSet = new Set(agl2mMeta.availableTimestamps);
  const commonTimestamps = agl10mMeta.availableTimestamps.filter(
    t => surfaceSet.has(t) && agl2mSet.has(t)
  );
  
  if (commonTimestamps.length === 0) {
    throw new Error('No NBM timestamps available');
  }
  
  const now = new Date();
  const maxTime = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
  const filteredTimestamps = commonTimestamps.filter(t => new Date(t) <= maxTime);
  
  if (filteredTimestamps.length === 0) {
    throw new Error('No NBM timestamps in requested time range');
  }
  
  // Get the time range for server-side interpolation
  const startTime = filteredTimestamps[0];
  const endTime = filteredTimestamps[filteredTimestamps.length - 1];
  const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;
  
  console.log(`NBM (painting): Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);
  
  // Fetch from all 3 collections in parallel with chunking for large time ranges
  const [surfaceData, agl2mData, agl10mData] = await Promise.all([
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/nbm-conus-surface/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'APCP01',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/nbm-conus-2m-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'TMP,DPT,RH',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
    fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/nbm-conus-10m-agl/position`, {
      coords: `POINT(${lng} ${lat})`,
      'parameter-name': 'GUST',
      datetime: `${startTime}/${endTime}`,
      interpolation: INTERPOLATION_CONFIG.method,
      step: stepParam,
      f: 'CoverageJSON',
    }),
  ]);
  
  const responseTimestamps: string[] = agl2mData?.domain?.axes?.t?.values ?? [];
  
  if (responseTimestamps.length === 0) {
    throw new Error('No timestamps in NBM painting response');
  }
  
  console.log(`NBM (painting): Processing ${responseTimestamps.length} interpolated timestamps`);
  
  return buildPaintingConditions(responseTimestamps, 'nbm', {
    tmpValues: agl2mData?.ranges?.TMP?.values ?? [],
    rhValues: agl2mData?.ranges?.RH?.values ?? [],
    dptValues: agl2mData?.ranges?.DPT?.values ?? [],
    ugrdValues: null,
    vgrdValues: null,
    gustValues: agl10mData?.ranges?.GUST?.values ?? [],
    apcpValues: surfaceData?.ranges?.APCP01?.values ?? [],
    popValues: null,
  }, nbmRunTime);
}

/**
 * Fetch painting conditions from NDFD (National Digital Forecast Database).
 * NDFD is the official NWS forecast, 2.5km resolution, up to 7 days.
 * Uses server-side temporal interpolation to get 10-minute interval data directly.
 *
 * Wind handling: NDFD provides WSPD (sustained wind) instead of GUST.
 * We estimate GUST ≈ WSPD × 1.4 (typical gust factor for open terrain).
 */
export async function fetchNDFDPaintingData(
  lat: number,
  lng: number,
  maxHours: number = 168
): Promise<PaintingConditions[]> {
  try {
    // Get available timestamps from NDFD collections and latest model run time in parallel
    const [surfaceMeta, ndfd2mMeta, windMeta, ndfdRunTime] = await Promise.all([
      fetchCollectionMetadata('ndfd-surface'),
      fetchCollectionMetadata('ndfd-2m'),
      fetchCollectionMetadata('ndfd-wind-2m-10m'),
      getLatestModelRun('ndfd-surface'),
    ]);

    // Find common timestamps across all collections
    const surfaceSet = new Set(surfaceMeta.availableTimestamps);
    const ndfd2mSet = new Set(ndfd2mMeta.availableTimestamps);
    const commonTimestamps = windMeta.availableTimestamps.filter(
      t => surfaceSet.has(t) && ndfd2mSet.has(t)
    );

    if (commonTimestamps.length === 0) {
      console.warn('NDFD (painting): No common timestamps between collections');
      return [];
    }

    // Limit to maxHours ahead
    const now = new Date();
    const maxTime = new Date(now.getTime() + maxHours * 60 * 60 * 1000);
    const filteredTimestamps = commonTimestamps.filter(t => new Date(t) <= maxTime);

    if (filteredTimestamps.length === 0) {
      console.warn('NDFD (painting): No timestamps within maxHours range');
      return [];
    }

    // Get the time range for server-side interpolation
    const startTime = filteredTimestamps[0];
    const endTime = filteredTimestamps[filteredTimestamps.length - 1];
    const stepParam = `PT${INTERPOLATION_CONFIG.stepMinutes}M`;

    console.log(`NDFD (painting): Fetching ${startTime} to ${endTime} with ${stepParam} interpolation`);

    // Fetch from all three collections in parallel using allSettled to handle failures gracefully
    const [surfaceResult, ndfd2mResult, windResult] = await Promise.allSettled([
      fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/ndfd-surface/position`, {
        coords: `POINT(${lng} ${lat})`,
        'parameter-name': 'POP12',
        datetime: `${startTime}/${endTime}`,
        interpolation: INTERPOLATION_CONFIG.method,
        step: stepParam,
        f: 'CoverageJSON',
      }),
      fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/ndfd-2m/position`, {
        coords: `POINT(${lng} ${lat})`,
        'parameter-name': 'TMP,DPT,RH',
        datetime: `${startTime}/${endTime}`,
        interpolation: INTERPOLATION_CONFIG.method,
        step: stepParam,
        f: 'CoverageJSON',
      }),
      fetchWithChunking(`${getEdrBaseUrl()}/edr/collections/ndfd-wind-2m-10m/position`, {
        coords: `POINT(${lng} ${lat})`,
        'parameter-name': 'WSPD',
        datetime: `${startTime}/${endTime}`,
        interpolation: INTERPOLATION_CONFIG.method,
        step: stepParam,
        f: 'CoverageJSON',
      }),
    ]);

    // Parse responses, handling failures gracefully
    let surfaceData: CoverageJSONResponse | null = null;
    let ndfd2mData: CoverageJSONResponse | null = null;
    let windData: CoverageJSONResponse | null = null;

    if (surfaceResult.status === 'fulfilled') {
      surfaceData = surfaceResult.value;
    } else {
      console.warn('NDFD (painting) surface request failed:', surfaceResult.reason);
    }

    if (ndfd2mResult.status === 'fulfilled') {
      ndfd2mData = ndfd2mResult.value;
    } else {
      console.warn('NDFD (painting) 2m request failed:', ndfd2mResult.reason);
    }

    if (windResult.status === 'fulfilled') {
      windData = windResult.value;
    } else {
      console.warn('NDFD (painting) wind request failed:', windResult.reason);
    }

    // Extract values - use empty arrays for missing data
    const ranges = (data: CoverageJSONResponse | null) => data?.ranges ?? {};
    const domain = (data: CoverageJSONResponse | null) => data?.domain ?? {};

    // Get timestamps from whichever response succeeded (now includes interpolated times)
    const responseTimestamps: string[] =
      domain(ndfd2mData)?.axes?.t?.values ??
      domain(windData)?.axes?.t?.values ??
      domain(surfaceData)?.axes?.t?.values ??
      [];

    if (responseTimestamps.length === 0) {
      console.warn('NDFD (painting): No data returned');
      return [];
    }

    console.log(`NDFD (painting): Processing ${responseTimestamps.length} interpolated timestamps`);

    const popValues: number[] = ranges(surfaceData)?.POP12?.values ?? [];
    const wspd10mValues: number[] = ranges(windData)?.WSPD?.values ?? [];
    const tmpValues: number[] = ranges(ndfd2mData)?.TMP?.values ?? [];
    const dptValues: number[] = ranges(ndfd2mData)?.DPT?.values ?? [];
    const rhValues: number[] = ranges(ndfd2mData)?.RH?.values ?? [];

    // NDFD provides WSPD (sustained wind) instead of GUST
    // Estimate gust from sustained wind: GUST ≈ WSPD × 1.4 (typical gust factor)
    const gustValues: number[] = wspd10mValues.map(wspd => wspd ? wspd * 1.4 : 0);

    // Check what data we actually got
    const hasTmp = tmpValues.some(v => v !== null && v !== undefined);
    const hasDpt = dptValues.some(v => v !== null && v !== undefined);
    const hasWspd = wspd10mValues.some(v => v !== null && v !== undefined);
    const hasPop = popValues.some(v => v !== null && v !== undefined);
    const hasRh = rhValues.some(v => v !== null && v !== undefined);

    console.log(`NDFD (painting) data available: TMP=${hasTmp}, DPT=${hasDpt}, WSPD=${hasWspd}, POP=${hasPop}, RH=${hasRh}`);

    // If we don't have enough data for meaningful scores, return empty
    // We need at least POP or RH to calculate precipitation score
    if (!hasPop && !hasRh) {
      console.warn('NDFD (painting): Insufficient data (no POP or RH)');
      return [];
    }

    return buildPaintingConditions(responseTimestamps, 'ndfd', {
      tmpValues,
      rhValues,
      dptValues,
      ugrdValues: null,
      vgrdValues: null,
      gustValues,
      apcpValues: null,
      popValues,
    }, ndfdRunTime);
  } catch (error) {
    console.warn('NDFD (painting) fetch failed:', error);
    return [];
  }
}

/**
 * Fetch painting data from all models in parallel.
 */
export async function fetchMultiModelPaintingData(
  lat: number,
  lng: number
): Promise<MultiModelPaintingData> {
  const [hrrrResult, gfsResult, nbmResult, ndfdResult] = await Promise.allSettled([
    fetchHRRRPaintingData(lat, lng),
    fetchGFSPaintingData(lat, lng, 120),
    fetchNBMPaintingData(lat, lng, 72),
    fetchNDFDPaintingData(lat, lng, 168),
  ]);

  const hrrr = hrrrResult.status === 'fulfilled' ? hrrrResult.value : [];
  const gfs = gfsResult.status === 'fulfilled' ? gfsResult.value : [];
  const nbm = nbmResult.status === 'fulfilled' ? nbmResult.value : [];
  const ndfd = ndfdResult.status === 'fulfilled' ? ndfdResult.value : [];

  // Log any failures
  if (hrrrResult.status === 'rejected') console.warn('HRRR painting fetch failed:', hrrrResult.reason);
  if (gfsResult.status === 'rejected') console.warn('GFS painting fetch failed:', gfsResult.reason);
  if (nbmResult.status === 'rejected') console.warn('NBM painting fetch failed:', nbmResult.reason);
  if (ndfdResult.status === 'rejected') console.warn('NDFD painting fetch failed:', ndfdResult.reason);

  // Check if ALL models failed (NDFD is optional, so don't include in critical check)
  const hasAnyData = hrrr.length > 0 || gfs.length > 0 || nbm.length > 0;
  if (!hasAnyData) {
    const errors: string[] = [];
    if (hrrrResult.status === 'rejected') errors.push(`HRRR: ${hrrrResult.reason}`);
    if (gfsResult.status === 'rejected') errors.push(`GFS: ${gfsResult.reason}`);
    if (nbmResult.status === 'rejected') errors.push(`NBM: ${nbmResult.reason}`);

    throw new Error(
      `Unable to fetch painting weather data. ` +
      `Please check your internet connection and try again. ` +
      (errors.length > 0 ? `Details: ${errors.join('; ')}` : '')
    );
  }

  // Data now comes pre-interpolated at 10-minute intervals from the server
  // Create blended forecast: HRRR (0-18h) -> NBM (18-48h) -> GFS (48h+)
  const blended = blendPaintingModelData(hrrr, nbm, gfs);

  return {
    location: { lat, lng },
    fetchedAt: new Date().toISOString(),
    models: {
      hrrr,
      gfs,
      nbm,
      ndfd,
    },
    blended,
  };
}

/**
 * Blend painting data from multiple models.
 * Priority: HRRR (0-18h) -> NBM (18-48h) -> GFS (48h+)
 * 
 * Data comes pre-interpolated at 10-minute intervals from the server.
 */
function blendPaintingModelData(
  hrrr: PaintingConditions[],
  nbm: PaintingConditions[],
  gfs: PaintingConditions[]
): PaintingConditions[] {
  const now = new Date();
  const blended: PaintingConditions[] = [];
  const usedTimestamps = new Set<string>();
  
  // Phase 1: HRRR for 0-18 hours (all 10-minute intervals)
  const hrrrCutoff = new Date(now.getTime() + 18 * 60 * 60 * 1000);
  for (const condition of hrrr) {
    const dt = new Date(condition.datetime);
    if (dt <= hrrrCutoff) {
      blended.push(condition);
      usedTimestamps.add(condition.datetime);
    }
  }
  
  // Phase 2: NBM for 18-48 hours (all 10-minute intervals)
  const nbmCutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  for (const condition of nbm) {
    const dt = new Date(condition.datetime);
    if (dt > hrrrCutoff && dt <= nbmCutoff && !usedTimestamps.has(condition.datetime)) {
      blended.push(condition);
      usedTimestamps.add(condition.datetime);
    }
  }
  
  // Phase 3: GFS for 48+ hours (all 10-minute intervals)
  for (const condition of gfs) {
    const dt = new Date(condition.datetime);
    if (dt > nbmCutoff && !usedTimestamps.has(condition.datetime)) {
      blended.push(condition);
      usedTimestamps.add(condition.datetime);
    }
  }
  
  // Sort by datetime
  blended.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());

  const hrrrCount = blended.filter(c => c.model === 'hrrr').length;
  const nbmCount = blended.filter(c => c.model === 'nbm').length;
  const gfsCount = blended.filter(c => c.model === 'gfs').length;
  console.log(`Blended painting forecast: ${blended.length} intervals (HRRR: ${hrrrCount}, NBM: ${nbmCount}, GFS: ${gfsCount})`);

  return blended;
}

// ============================================================================
// Position Time Series Fetching
// ============================================================================

/**
 * Response type for position time series data
 */
export interface PositionTimeSeriesPoint {
  timestamp: string;
  value: number;
}

/**
 * Fetch time series data at a specific point from the EDR position endpoint.
 * Returns values at the specified timestamps for the given collection and parameter.
 *
 * @param collection - Collection ID (e.g., 'hrrr-height-agl', 'gfs-height-agl', 'mrms-single-level')
 * @param parameter - Parameter name (e.g., 'TMP', 'REFC', 'UGRD')
 * @param lng - Longitude of the point
 * @param lat - Latitude of the point
 * @param timestamps - Array of ISO 8601 timestamps to fetch data for
 * @returns Array of time series points with timestamp and value
 */
export async function fetchPositionTimeSeries(
  collection: string,
  parameter: string,
  lng: number,
  lat: number,
  timestamps: string[]
): Promise<PositionTimeSeriesPoint[]> {
  console.log('[fetchPositionTimeSeries] Called with:', { collection, parameter, lng, lat, timestampCount: timestamps.length });

  if (timestamps.length === 0) {
    console.log('[fetchPositionTimeSeries] No timestamps provided');
    return [];
  }

  // Use comma-separated timestamps for specific time points
  const datetimeParam = timestamps.join(',');

  const url = `${getEdrBaseUrl()}/edr/collections/${collection}/position`;
  const params = new URLSearchParams({
    coords: `POINT(${lng} ${lat})`,
    'parameter-name': parameter,
    datetime: datetimeParam,
    f: 'CoverageJSON',
  });

  const fullUrl = `${url}?${params}`;
  console.log('[fetchPositionTimeSeries] Fetching:', fullUrl);

  try {
    const response = await authFetch(fullUrl);
    if (!response.ok) {
      console.error(`Position request failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json() as CoverageJSONResponse;

    // Extract timestamps and values from CoverageJSON response
    const responseTimestamps: string[] = data?.domain?.axes?.t?.values ?? [];
    const values: number[] = data?.ranges?.[parameter]?.values ?? [];

    if (responseTimestamps.length === 0 || values.length === 0) {
      console.warn(`No data returned for ${collection}/${parameter} at (${lng}, ${lat})`);
      return [];
    }

    // Build time series points
    const points: PositionTimeSeriesPoint[] = [];
    for (let i = 0; i < responseTimestamps.length && i < values.length; i++) {
      points.push({
        timestamp: responseTimestamps[i],
        value: values[i],
      });
    }

    return points;
  } catch (error) {
    console.error(`Error fetching position time series:`, error);
    return [];
  }
}

// =============================================================================
// METAR Station Observations
// =============================================================================

/**
 * Properties for a single METAR observation from the EDR API
 */
export interface MetarProperties {
  location_id: string;
  name: string;
  obs_time: string;
  temperature_k: number;
  dewpoint_k: number;
  wind_direction_deg: number;
  wind_speed_ms: number;
  wind_gust_ms?: number;
  visibility_m: number;
  altimeter_pa: number;
  sea_level_pressure_pa?: number;
  flight_category: 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
  raw_text: string;
}

/**
 * GeoJSON Feature with METAR properties
 */
export interface MetarFeature {
  type: 'Feature';
  id: string;
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  properties: MetarProperties;
}

/**
 * GeoJSON FeatureCollection of METAR observations
 */
export interface MetarFeatureCollection {
  type: 'FeatureCollection';
  features: MetarFeature[];
}

/**
 * Fetch latest METAR observations for all stations.
 * Uses a radius query centered on CONUS with a large radius to get all 77 stations.
 * Deduplicates by location_id, keeping only the most recent observation per station.
 */
export async function fetchMetarStations(): Promise<MetarFeatureCollection> {
  const baseUrl = getEdrBaseUrl();
  // Center on CONUS with a 5000km radius to capture all stations (including Alaska)
  const url = `${baseUrl}/edr/collections/metar/radius?coords=POINT(-98.0 39.0)&within=5000&within-units=km&limit=1`;

  console.log('[fetchMetarStations] Fetching:', url);

  try {
    const response = await authFetch(url);
    if (!response.ok) {
      console.error(`METAR fetch failed: ${response.status} ${response.statusText}`);
      return { type: 'FeatureCollection', features: [] };
    }

    const data = await response.json() as MetarFeatureCollection;

    // Deduplicate: keep only the latest observation per station
    const latestByStation = new Map<string, MetarFeature>();
    for (const feature of data.features) {
      const stationId = feature.properties.location_id;
      const existing = latestByStation.get(stationId);
      if (!existing || feature.properties.obs_time > existing.properties.obs_time) {
        latestByStation.set(stationId, feature);
      }
    }

    const deduped: MetarFeatureCollection = {
      type: 'FeatureCollection',
      features: Array.from(latestByStation.values()),
    };

    console.log(`[fetchMetarStations] Got ${deduped.features.length} stations (deduped from ${data.features.length} obs)`);
    return deduped;
  } catch (error) {
    console.error('Error fetching METAR stations:', error);
    return { type: 'FeatureCollection', features: [] };
  }
}

// =============================================================================
// NDBC Buoy Station Observations
// =============================================================================

/**
 * Properties for a single NDBC buoy/C-MAN observation from the EDR API.
 * All fields except location_id and obs_time are optional — stations report
 * different subsets of data depending on equipment and type.
 */
export interface BuoyProperties {
  location_id: string;
  name: string;
  obs_time: string;
  temperature_k?: number;
  dewpoint_k?: number;
  wind_direction_deg?: number;
  wind_speed_ms?: number;
  wind_gust_ms?: number;
  sea_level_pressure_pa?: number;
  water_temp_k?: number;
  wave_height_m?: number;
  dominant_wave_period_s?: number;
  average_wave_period_s?: number;
  mean_wave_direction_deg?: number;
  visibility_m?: number;
  raw_text?: string;
}

/**
 * GeoJSON Feature with NDBC buoy properties
 */
export interface BuoyFeature {
  type: 'Feature';
  id: string;
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  properties: BuoyProperties;
}

/**
 * GeoJSON FeatureCollection of NDBC buoy observations
 */
export interface BuoyFeatureCollection {
  type: 'FeatureCollection';
  features: BuoyFeature[];
}

/**
 * Fetch latest NDBC buoy/C-MAN observations for all stations.
 * Uses a radius query centered on CONUS with a large radius to capture
 * offshore buoys and coastal stations. Deduplicates by location_id.
 */
export async function fetchBuoyStations(): Promise<BuoyFeatureCollection> {
  const baseUrl = getEdrBaseUrl();
  // Center on CONUS with 5000km radius — covers Atlantic, Pacific, Gulf, Great Lakes
  const url = `${baseUrl}/edr/collections/ndbc/radius?coords=POINT(-98.0 39.0)&within=5000&within-units=km&limit=1`;

  console.log('[fetchBuoyStations] Fetching:', url);

  try {
    const response = await authFetch(url);
    if (!response.ok) {
      console.error(`NDBC fetch failed: ${response.status} ${response.statusText}`);
      return { type: 'FeatureCollection', features: [] };
    }

    const data = await response.json() as BuoyFeatureCollection;

    // Deduplicate: keep only the latest observation per station
    const latestByStation = new Map<string, BuoyFeature>();
    for (const feature of data.features) {
      const stationId = feature.properties.location_id;
      const existing = latestByStation.get(stationId);
      if (!existing || feature.properties.obs_time > existing.properties.obs_time) {
        latestByStation.set(stationId, feature);
      }
    }

    const deduped: BuoyFeatureCollection = {
      type: 'FeatureCollection',
      features: Array.from(latestByStation.values()),
    };

    console.log(`[fetchBuoyStations] Got ${deduped.features.length} stations (deduped from ${data.features.length} obs)`);
    return deduped;
  } catch (error) {
    console.error('Error fetching NDBC buoy stations:', error);
    return { type: 'FeatureCollection', features: [] };
  }
}

// =============================================================================
// TAF - Terminal Aerodrome Forecasts
// =============================================================================

/**
 * A single cloud layer within a TAF period
 */
export interface TafCloudLayer {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC' | string;
  base_m: number;
}

/**
 * A single forecast period within a TAF
 */
export interface TafPeriod {
  from: string;
  to: string;
  change_type?: string; // FM, TEMPO, PROB, BECMG, etc.
  wind_direction_deg?: number;
  wind_speed_ms?: number;
  wind_gust_ms?: number;
  visibility_m?: number;
  wx_string?: string;
  cloud_layers: TafCloudLayer[];
}

/**
 * Properties for a single TAF from the EDR API
 */
export interface TafProperties {
  location_id: string;
  name: string;
  issue_time: string;
  valid_from: string;
  valid_to: string;
  raw_taf: string;
  periods: TafPeriod[];
}

/**
 * GeoJSON Feature with TAF properties
 */
export interface TafFeature {
  type: 'Feature';
  id: string;
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  properties: TafProperties;
}

/**
 * GeoJSON FeatureCollection of TAF forecasts
 */
export interface TafFeatureCollection {
  type: 'FeatureCollection';
  features: TafFeature[];
}

/**
 * Fetch latest TAF forecasts for all stations.
 * Uses a radius query centered on CONUS with a large radius.
 * Deduplicates by location_id, keeping only the most recently issued TAF.
 */
export async function fetchTafStations(): Promise<TafFeatureCollection> {
  const baseUrl = getEdrBaseUrl();
  const url = `${baseUrl}/edr/collections/taf/radius?coords=POINT(-98.0 39.0)&within=5000&within-units=km&limit=1`;

  console.log('[fetchTafStations] Fetching:', url);

  try {
    const response = await authFetch(url);
    if (!response.ok) {
      console.error(`TAF fetch failed: ${response.status} ${response.statusText}`);
      return { type: 'FeatureCollection', features: [] };
    }

    const data = await response.json() as TafFeatureCollection;

    // Deduplicate: keep only the latest issued TAF per station
    const latestByStation = new Map<string, TafFeature>();
    for (const feature of data.features) {
      const stationId = feature.properties.location_id;
      const existing = latestByStation.get(stationId);
      if (!existing || feature.properties.issue_time > existing.properties.issue_time) {
        latestByStation.set(stationId, feature);
      }
    }

    const deduped: TafFeatureCollection = {
      type: 'FeatureCollection',
      features: Array.from(latestByStation.values()),
    };

    console.log(`[fetchTafStations] Got ${deduped.features.length} stations (deduped from ${data.features.length} TAFs)`);
    return deduped;
  } catch (error) {
    console.error('Error fetching TAF stations:', error);
    return { type: 'FeatureCollection', features: [] };
  }
}

// =============================================================================
// DART - Deep-ocean Assessment and Reporting of Tsunamis
// =============================================================================

/**
 * Properties for a DART station location (from /locations endpoint)
 */
export interface DartLocationProperties {
  location_id: string;
  name: string;
  type: string;
}

/**
 * GeoJSON Feature for a DART station location
 */
export interface DartLocationFeature {
  type: 'Feature';
  id: string;
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: DartLocationProperties;
}

/**
 * GeoJSON FeatureCollection of DART station locations
 */
export interface DartLocationCollection {
  type: 'FeatureCollection';
  features: DartLocationFeature[];
}

/**
 * A single DART observation for time series charting
 */
export interface DartObservation {
  obs_time: string;
  water_column_height_m: number;
  measurement_type: number; // 1=15-min standard, 2=1-min event, 3=15-sec triggered
  raw_text: string;
}

/**
 * Fetch all DART station locations for placing markers on the map.
 * Uses the /locations endpoint which returns station positions without observation data.
 * Extracts station IDs from the URL-formatted id field.
 */
export async function fetchDartLocations(): Promise<DartLocationCollection> {
  const baseUrl = getEdrBaseUrl();
  const url = `${baseUrl}/edr/collections/dart/locations`;

  console.log('[fetchDartLocations] Fetching:', url);

  try {
    const response = await authFetch(url);
    if (!response.ok) {
      console.error(`DART locations fetch failed: ${response.status} ${response.statusText}`);
      return { type: 'FeatureCollection', features: [] };
    }

    const data = await response.json() as {
      type: 'FeatureCollection';
      features: Array<{
        type: 'Feature';
        id: string; // URL like "https://.../locations/21413"
        geometry: { type: 'Point'; coordinates: [number, number] };
        properties: { name: string; type: string };
      }>;
    };

    // Extract station ID from URL-style id field and inject into properties
    const features: DartLocationFeature[] = data.features.map((f) => {
      const urlParts = f.id.split('/');
      const stationId = urlParts[urlParts.length - 1];
      return {
        type: 'Feature' as const,
        id: f.id,
        geometry: f.geometry,
        properties: {
          location_id: stationId,
          name: f.properties.name,
          type: f.properties.type,
        },
      };
    });

    const result: DartLocationCollection = {
      type: 'FeatureCollection',
      features,
    };

    console.log(`[fetchDartLocations] Got ${features.length} stations`);
    return result;
  } catch (error) {
    console.error('Error fetching DART locations:', error);
    return { type: 'FeatureCollection', features: [] };
  }
}

/**
 * Fetch DART time series observations for a specific station.
 * Returns observations sorted chronologically (oldest first).
 *
 * @param stationId - The DART station ID (e.g., "21413")
 * @param days - Number of days of history to fetch (default 5)
 * @param limit - Max observations to return (default 500)
 */
export async function fetchDartTimeSeries(
  stationId: string,
  days: number = 5,
  limit: number = 500,
): Promise<DartObservation[]> {
  const baseUrl = getEdrBaseUrl();
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - days);
  const startIso = startDate.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const url = `${baseUrl}/edr/collections/dart/locations/${stationId}?datetime=${startIso}/..&limit=${limit}`;

  console.log(`[fetchDartTimeSeries] Fetching station ${stationId}:`, url);

  try {
    const response = await authFetch(url);
    if (!response.ok) {
      console.error(`DART time series fetch failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json() as {
      type: 'FeatureCollection';
      features: Array<{
        properties: {
          obs_time: string;
          water_column_height_m?: number;
          raw_text?: string;
        };
      }>;
    };

    const observations: DartObservation[] = [];
    for (const f of data.features) {
      const p = f.properties;
      if (p.water_column_height_m == null) continue;

      // Parse measurement type from raw_text: "T=1 HEIGHT=..." → 1
      let mType = 1;
      if (p.raw_text) {
        const match = p.raw_text.match(/T=(\d)/);
        if (match) mType = parseInt(match[1], 10);
      }

      observations.push({
        obs_time: p.obs_time,
        water_column_height_m: p.water_column_height_m,
        measurement_type: mType,
        raw_text: p.raw_text ?? '',
      });
    }

    // Sort chronologically (oldest first) for charting
    observations.sort((a, b) => a.obs_time.localeCompare(b.obs_time));

    console.log(`[fetchDartTimeSeries] Station ${stationId}: ${observations.length} observations`);
    return observations;
  } catch (error) {
    console.error(`Error fetching DART time series for ${stationId}:`, error);
    return [];
  }
}
