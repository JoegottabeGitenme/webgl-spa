/**
 * Animation Manager
 * 
 * Manages frame caching and interpolation for smooth weather data animation.
 * Supports loading multiple timesteps and interpolating between them.
 * Also supports wind data frames for synchronized wind animation.
 */

import type { TileMetadata } from '../data/edr-client';
import type { WindData } from '../wind/wind-data';

export interface AnimationFrame {
  datetime: string;
  grayscaleData: Uint8ClampedArray;
  width: number;
  height: number;
  metadata: TileMetadata;
}

export interface WindAnimationFrame {
  datetime: string;
  windData: WindData;
}

export interface FrameLoadResult {
  grayscaleData: Uint8ClampedArray;
  metadata: TileMetadata;
  width: number;
  height: number;
}

export type FrameLoadFn = (datetime: string) => Promise<FrameLoadResult>;
export type WindFrameLoadFn = (datetime: string) => Promise<WindData>;

export interface LoadProgress {
  loaded: number;
  total: number;
  currentTimestamp: string;
}

export interface ProgressiveLoadCallbacks {
  onFrameLoaded?: (progress: LoadProgress, canStartPlayback: boolean) => void;
  onAllLoaded?: () => void;
}

export class AnimationManager {
  private frames: Map<string, AnimationFrame> = new Map();
  private windFrames: Map<string, WindAnimationFrame> = new Map();
  private sortedTimestamps: string[] = [];

  // Cache for pre-rendered colorized data URLs (keyed by frame index)
  private renderedUrlCache: Map<number, string> = new Map();
  
  /**
   * Load frames for animation
   * 
   * @param timestamps - Array of ISO 8601 timestamps to load
   * @param fetchFn - Function to fetch a single frame
   * @param onProgress - Optional progress callback
   * @param concurrency - Max concurrent requests (default 4)
   */
  async loadFrames(
    timestamps: string[],
    fetchFn: FrameLoadFn,
    onProgress?: (progress: LoadProgress) => void,
    concurrency: number = 4
  ): Promise<void> {
    this.clear();
    
    const total = timestamps.length;
    let loaded = 0;
    
    // Load frames with concurrency limit
    const loadFrame = async (datetime: string): Promise<void> => {
      try {
        const result = await fetchFn(datetime);
        
        this.frames.set(datetime, {
          datetime,
          grayscaleData: result.grayscaleData,
          width: result.width,
          height: result.height,
          metadata: result.metadata,
        });
        
        loaded++;
        onProgress?.({ loaded, total, currentTimestamp: datetime });
      } catch (error) {
        console.error(`Failed to load frame for ${datetime}:`, error);
        // Continue loading other frames even if one fails
        loaded++;
        onProgress?.({ loaded, total, currentTimestamp: datetime });
      }
    };
    
    // Process in batches for concurrency control
    for (let i = 0; i < timestamps.length; i += concurrency) {
      const batch = timestamps.slice(i, i + concurrency);
      await Promise.all(batch.map(loadFrame));
    }
    
    // Sort timestamps chronologically
    this.sortedTimestamps = [...this.frames.keys()].sort();
  }

  /**
   * Load frames progressively, allowing playback to start before all frames are loaded.
   * Frames are loaded with concurrency control and callbacks fire after each batch.
   *
   * @param timestamps - Array of ISO 8601 timestamps to load
   * @param fetchFn - Function to fetch a single frame
   * @param callbacks - Callbacks for frame loaded and all loaded events
   * @param minFramesForPlayback - Minimum frames needed before playback can start (default 2)
   * @param concurrency - Max concurrent requests (default 4)
   * @returns Promise that resolves when all frames are loaded
   */
  async loadFramesProgressive(
    timestamps: string[],
    fetchFn: FrameLoadFn,
    callbacks: ProgressiveLoadCallbacks = {},
    minFramesForPlayback: number = 2,
    concurrency: number = 4
  ): Promise<void> {
    this.clear();

    const total = timestamps.length;

    const loadFrame = async (datetime: string): Promise<void> => {
      try {
        const result = await fetchFn(datetime);

        this.frames.set(datetime, {
          datetime,
          grayscaleData: result.grayscaleData,
          width: result.width,
          height: result.height,
          metadata: result.metadata,
        });
      } catch (error) {
        console.error(`Failed to load frame for ${datetime}:`, error);
      }
    };

    // Process in batches with concurrency control
    for (let i = 0; i < timestamps.length; i += concurrency) {
      const batch = timestamps.slice(i, i + concurrency);

      // Start all requests in batch
      await Promise.all(batch.map(loadFrame));

      // Update sorted timestamps after batch
      this.sortedTimestamps = [...this.frames.keys()].sort();

      // Report progress for this batch
      const progress: LoadProgress = {
        loaded: this.frames.size,
        total,
        currentTimestamp: batch[batch.length - 1],
      };
      const canStartPlayback = this.frames.size >= minFramesForPlayback;
      callbacks.onFrameLoaded?.(progress, canStartPlayback);
    }

    callbacks.onAllLoaded?.();
  }

  /**
   * Interpolate between two adjacent frames
   * 
   * @param indexA - Index of first frame
   * @param indexB - Index of second frame
   * @param progress - Interpolation progress (0 = frameA, 1 = frameB)
   * @returns Interpolated grayscale data
   */
  interpolateFrames(
    indexA: number,
    indexB: number,
    progress: number
  ): Uint8ClampedArray | null {
    const timestampA = this.sortedTimestamps[indexA];
    const timestampB = this.sortedTimestamps[indexB];
    
    const frameA = this.frames.get(timestampA);
    const frameB = this.frames.get(timestampB);
    
    if (!frameA || !frameB) {
      return null;
    }
    
    // Ensure frames have same dimensions
    if (frameA.width !== frameB.width || frameA.height !== frameB.height) {
      console.warn('Frame dimensions mismatch, returning frameA');
      return frameA.grayscaleData;
    }
    
    const result = new Uint8ClampedArray(frameA.grayscaleData.length);
    const t = Math.max(0, Math.min(1, progress));
    const invT = 1 - t;
    
    // Interpolate grayscale values
    // Input is RGBA where R=G=B=grayscale value
    for (let i = 0; i < result.length; i += 4) {
      const valA = frameA.grayscaleData[i];
      const valB = frameB.grayscaleData[i];
      const interpolated = Math.round(valA * invT + valB * t);
      
      result[i] = interpolated;      // R
      result[i + 1] = interpolated;  // G
      result[i + 2] = interpolated;  // B
      result[i + 3] = 255;           // A (fully opaque)
    }
    
    return result;
  }
  
  /**
   * Get frame data at a continuous position in the animation
   * 
   * @param position - Animation position (0.0 = first frame, 1.0 = last frame)
   * @returns Interpolated grayscale data and computed timestamp
   */
  getFrameAtPosition(position: number): {
    grayscaleData: Uint8ClampedArray;
    datetime: string;
    metadata: TileMetadata;
    width: number;
    height: number;
  } | null {
    const frameCount = this.sortedTimestamps.length;
    
    if (frameCount === 0) {
      return null;
    }
    
    if (frameCount === 1) {
      const frame = this.frames.get(this.sortedTimestamps[0])!;
      return {
        grayscaleData: frame.grayscaleData,
        datetime: frame.datetime,
        metadata: frame.metadata,
        width: frame.width,
        height: frame.height,
      };
    }
    
    // Clamp position to valid range
    const pos = Math.max(0, Math.min(1, position));
    
    // Calculate which frames we're between
    const scaledPos = pos * (frameCount - 1);
    const indexA = Math.floor(scaledPos);
    const indexB = Math.min(indexA + 1, frameCount - 1);
    const progress = scaledPos - indexA;
    
    // Get interpolated grayscale data
    const grayscaleData = this.interpolateFrames(indexA, indexB, progress);
    
    if (!grayscaleData) {
      return null;
    }
    
    // Interpolate timestamp for display
    const timestampA = new Date(this.sortedTimestamps[indexA]).getTime();
    const timestampB = new Date(this.sortedTimestamps[indexB]).getTime();
    const interpolatedTime = timestampA + (timestampB - timestampA) * progress;
    const datetime = new Date(interpolatedTime).toISOString();
    
    // Use metadata from frame A (they should be similar except for datetime)
    const frameA = this.frames.get(this.sortedTimestamps[indexA])!;
    
    return {
      grayscaleData,
      datetime,
      metadata: frameA.metadata,
      width: frameA.width,
      height: frameA.height,
    };
  }
  
  /**
   * Get all loaded timestamps in chronological order
   */
  getTimestamps(): string[] {
    return [...this.sortedTimestamps];
  }
  
  /**
   * Get the number of loaded frames
   */
  getFrameCount(): number {
    return this.sortedTimestamps.length;
  }
  
  /**
   * Get a specific frame by timestamp
   */
  getFrame(timestamp: string): AnimationFrame | undefined {
    return this.frames.get(timestamp);
  }
  
  /**
   * Get metadata from the first loaded frame (useful for colormap range)
   */
  getMetadata(): TileMetadata | null {
    if (this.sortedTimestamps.length === 0) return null;
    return this.frames.get(this.sortedTimestamps[0])?.metadata ?? null;
  }
  
  /**
   * Check if frames are loaded
   */
  hasFrames(): boolean {
    return this.sortedTimestamps.length > 0;
  }
  
  /**
   * Check if wind frames are loaded
   */
  hasWindFrames(): boolean {
    return this.windFrames.size > 0;
  }
  
  /**
   * Load wind data frames for animation
   * 
   * @param timestamps - Array of ISO 8601 timestamps to load (should match weather frames)
   * @param fetchFn - Function to fetch wind data for a timestamp
   * @param onProgress - Optional progress callback
   */
  async loadWindFrames(
    timestamps: string[],
    fetchFn: WindFrameLoadFn,
    onProgress?: (progress: LoadProgress) => void,
    concurrency: number = 2  // Lower concurrency for wind (fetches 2 tiles per frame)
  ): Promise<void> {
    this.windFrames.clear();
    
    const total = timestamps.length;
    let loaded = 0;
    
    const loadFrame = async (datetime: string): Promise<void> => {
      try {
        const windData = await fetchFn(datetime);
        
        this.windFrames.set(datetime, {
          datetime,
          windData,
        });
        
        loaded++;
        onProgress?.({ loaded, total, currentTimestamp: datetime });
      } catch (error) {
        console.error(`Failed to load wind frame for ${datetime}:`, error);
        loaded++;
        onProgress?.({ loaded, total, currentTimestamp: datetime });
      }
    };
    
    // Process in batches
    for (let i = 0; i < timestamps.length; i += concurrency) {
      const batch = timestamps.slice(i, i + concurrency);
      await Promise.all(batch.map(loadFrame));
    }
  }
  
  /**
   * Get wind data at a position in the animation.
   * Returns the wind frame closest to the current position (no interpolation for wind).
   * 
   * @param position - Animation position (0.0 = first frame, 1.0 = last frame)
   * @returns WindData for the nearest frame, or null if not available
   */
  getWindDataAtPosition(position: number): WindData | null {
    if (this.sortedTimestamps.length === 0 || this.windFrames.size === 0) {
      return null;
    }
    
    // Find the nearest timestamp
    const pos = Math.max(0, Math.min(1, position));
    const frameCount = this.sortedTimestamps.length;
    const index = Math.round(pos * (frameCount - 1));
    const timestamp = this.sortedTimestamps[index];
    
    return this.windFrames.get(timestamp)?.windData ?? null;
  }
  
  /**
   * Get wind frame for a specific timestamp
   */
  getWindFrame(timestamp: string): WindAnimationFrame | undefined {
    return this.windFrames.get(timestamp);
  }
  
  /**
   * Clear all cached frames
   */
  clear(): void {
    this.frames.clear();
    this.windFrames.clear();
    this.sortedTimestamps = [];
    this.renderedUrlCache.clear();
  }

  // Resolution for pre-rendered cache (number of steps from 0 to 1)
  // Higher = smoother animation, more memory usage
  private cacheResolution: number = 60;

  /**
   * Set the cache resolution (number of pre-rendered positions)
   */
  setCacheResolution(resolution: number): void {
    this.cacheResolution = Math.max(10, Math.min(200, resolution));
  }

  /**
   * Get the cache resolution
   */
  getCacheResolution(): number {
    return this.cacheResolution;
  }

  /**
   * Convert a continuous position to a cache key
   */
  private positionToCacheKey(position: number): number {
    const pos = Math.max(0, Math.min(1, position));
    return Math.round(pos * this.cacheResolution);
  }

  /**
   * Convert a cache key back to a position
   */
  cacheKeyToPosition(key: number): number {
    return key / this.cacheResolution;
  }

  /**
   * Cache a pre-rendered data URL for a position
   * @param position - Animation position (0.0 to 1.0)
   * @param url - The rendered data URL
   */
  cacheRenderedUrl(position: number, url: string): void {
    const key = this.positionToCacheKey(position);
    this.renderedUrlCache.set(key, url);
  }

  /**
   * Get a cached rendered URL for a position
   * @param position - Animation position (0.0 to 1.0)
   * @returns The cached data URL, or undefined if not cached
   */
  getRenderedUrl(position: number): string | undefined {
    const key = this.positionToCacheKey(position);
    return this.renderedUrlCache.get(key);
  }

  /**
   * Get the quantized cache key for a position (for change detection)
   */
  getCacheKey(position: number): number {
    return this.positionToCacheKey(position);
  }

  /**
   * Check if all positions have been pre-rendered
   */
  hasRenderedCache(): boolean {
    return this.renderedUrlCache.size > 0;
  }

  /**
   * Clear the rendered URL cache (e.g., when colormap changes)
   */
  clearRenderedCache(): void {
    this.renderedUrlCache.clear();
  }

  /**
   * Get the frame index closest to a given animation position
   * @param position - Animation position (0.0 = first frame, 1.0 = last frame)
   * @returns The frame index
   */
  getFrameIndexAtPosition(position: number): number {
    const frameCount = this.sortedTimestamps.length;
    if (frameCount === 0) return 0;
    if (frameCount === 1) return 0;

    const pos = Math.max(0, Math.min(1, position));
    return Math.round(pos * (frameCount - 1));
  }

  /**
   * Get the timestamp for a given frame index
   */
  getTimestampAtIndex(index: number): string | undefined {
    return this.sortedTimestamps[index];
  }
}
