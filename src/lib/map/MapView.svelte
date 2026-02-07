<script lang="ts">
  /**
   * Interactive Map View Component
   *
   * Wraps MapLibre GL JS to provide an interactive map with weather data overlay.
   * Fetches a single tile from EDR API based on current map viewport.
   */

  import { onMount, onDestroy } from "svelte";
  import maplibregl from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import {
    fetchDataTile,
    fetchCollectionMetadata,
    fetchCollections,
    selectAnimationTimestamps,
    fetchPositionTimeSeries,
    getEdrBaseUrl,
    setEdrBaseUrl,
    setEdrApiKey,
    getDefaultEdrUrl,
    getEdrDepth,
    setEdrDepth,
    getDefaultDepth,
    type DataTile,
    type TileMetadata,
    type CollectionSummary,
    type CollectionMetadata,
  } from "../data/edr-client";
  import {
    COLOR_SCALES,
    COLOR_SCALE_LABELS,
    type ColorScaleName,
    type ColorScale,
    applyColormapToImageData,
    applySteppedColormapWithLevels,
    radarAlphaFunction,
  } from "../visualization/color-scales";
  import ColorLegend from "../components/ColorLegend.svelte";
  import { WindParticleLayer, fetchWindData, type WindData } from "../wind";
  import { AnimationManager, type LoadProgress, type ProgressiveLoadCallbacks } from "../animation";
  import { extractContours, contoursToGeoJSON, downsampleData } from "../isoline";
  import {
    type TileCoord,
    type BBox,
    getVisibleTiles,
    mapZoomToTileZoom,
    tileKey,
    tilesCombinedBbox,
  } from "../tiles/tile-utils";
  import { TileCache, getTileCache, type CachedTile } from "../tiles/TileCache";
  import { TileCompositor, getTileCompositor, type CompositeResult } from "../tiles/TileCompositor";
  import { getParameterScale, type ParameterScale } from "../tiles/parameter-scales";
  import { fetchTiles } from "../data/edr-client";

  // Props
  interface Props {
    initialCenter?: [number, number]; // [lng, lat]
    initialZoom?: number;
    compact?: boolean; // Disable interactivity and hide controls for card view
    dataLayerProp?: 'temperature' | 'reflectivity'; // External control of data layer
    animationEnabledProp?: boolean; // External control of animation
    onAnimationChange?: (playing: boolean) => void; // Callback when animation state changes
    onLocationChange?: (location: { lat: number; lng: number }) => void; // Callback when map center changes
  }

  let { 
    initialCenter = [-95.7, 37.0], 
    initialZoom = 4, 
    compact = false,
    dataLayerProp = 'temperature',
    animationEnabledProp = false,
    onAnimationChange,
    onLocationChange,
  }: Props = $props();

  // Data layer configuration
  type DataLayerType = 'temperature' | 'reflectivity' | 'humidity' | 'precipitation' | 'dewpoint';
  interface DataLayerConfig {
    label: string;
    collection: string;
    parameter: string;
    defaultScale: ColorScaleName;
    animation: {
      skipFactor: number;  // Use every Nth timestamp (1 = all, 3 = every 3rd)
      defaultFrameCount: number;
      mode: 'recent' | 'centered';
    };
  }
  const DATA_LAYERS: Record<DataLayerType, DataLayerConfig> = {
    temperature: {
      label: 'Temperature',
      collection: 'gfs-height-agl',
      parameter: 'TMP',
      defaultScale: 'temperature',
      animation: {
        skipFactor: 1,  // GFS has 1-hour steps, use all
        defaultFrameCount: 8,
        mode: 'centered',
      },
    },
    reflectivity: {
      label: 'Radar',
      collection: 'mrms-single-level',
      parameter: 'REFL',
      defaultScale: 'reflectivity',
      animation: {
        skipFactor: 3,  // MRMS has 2-min steps, use every 3rd (~6 min)
        defaultFrameCount: 8,
        mode: 'recent',
      },
    },
    humidity: {
      label: 'Humidity',
      collection: 'gfs-height-agl',
      parameter: 'RH',
      defaultScale: 'humidity',
      animation: {
        skipFactor: 1,
        defaultFrameCount: 8,
        mode: 'centered',
      },
    },
    precipitation: {
      label: 'Precipitation',
      collection: 'gfs-surface',
      parameter: 'APCP',
      defaultScale: 'precipitation',
      animation: {
        skipFactor: 1,
        defaultFrameCount: 8,
        mode: 'centered',
      },
    },
    dewpoint: {
      label: 'Dew Point',
      collection: 'gfs-height-agl',
      parameter: 'DPT',
      defaultScale: 'dewpoint',
      animation: {
        skipFactor: 1,
        defaultFrameCount: 8,
        mode: 'centered',
      },
    },
  };

  // State
  let mapContainer: HTMLDivElement;
  let collectionSelect: HTMLSelectElement;
  let dataLayerSelect: HTMLSelectElement;
  let styleSelect: HTMLSelectElement;
  let map = $state<maplibregl.Map | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Collections state
  let collections = $state<CollectionSummary[]>([]);
  let selectedCollection = $state<string>('gfs-height-agl');
  let selectedParameter = $state<string>('TMP');
  let collectionsLoading = $state(false);
  let selectedVerticalLevel = $state<number | null>(null);
  let dataLayer = $state<DataLayerType>('temperature');
  let selectedScale = $state<ColorScaleName>("temperature");

  // CRS (Coordinate Reference System) option
  type CRSOption = 'CRS:84' | 'EPSG:4326' | 'EPSG:3857';
  let selectedCRS = $state<CRSOption>('CRS:84');

  // Bbox offset adjustment (in pixels) for debugging alignment issues
  // Positive = expand bbox outward, Negative = shrink inward
  let bboxOffsetPixels = $state(0);  // Start with no offset - trust server bbox
  // Custom scales (user-edited colors) - keyed by scale name
  let customScales = $state<Map<ColorScaleName, ColorScale>>(new Map());
  let windEnabled = $state(false);
  let windLoading = $state(false);
  
  // Help modal state
  let showHelpModal = $state(false);

  // Wind tuning controls
  let windSpeedFactor = $state(0.4);
  let windFadeOpacity = $state(0.934);
  let windPointSize = $state(4.5);
  let windDropRate = $state(0.008);
  let windParticleCount = $state(4000);
  let windBrightness = $state(0.80);
  let showWindControls = $state(false);
  
  // Raster display options: 'pixelated' | 'smooth' | 'blur'
  type InterpolationMode = 'pixelated' | 'smooth' | 'blur';
  let interpolationMode = $state<InterpolationMode>('smooth');
  
  // Temperature unit preference
  type TemperatureUnit = 'F' | 'C';
  let temperatureUnit = $state<TemperatureUnit>('F');

  // EDR endpoint configuration
  let edrEndpoint = $state(getEdrBaseUrl());
  let edrApiKey = $state('');
  let edrDepthEnabled = $state(getEdrDepth() !== null);
  let edrDepthValue = $state(getEdrDepth() ?? getDefaultDepth());
  let showEdrConfig = $state(false);

  // Current tile data
  let currentTile = $state<DataTile | null>(null);
  let grayscaleData: Uint8ClampedArray | null = null;
  let imageWidth = 0;
  let imageHeight = 0;
  
  // Tile-based loading
  let useTiledLoading = $state(true);  // Enable tile-based loading by default
  let tileZoomOffset = $state(3);      // Map zoom - offset = tile zoom
  let currentTileCoords = $state<TileCoord[]>([]);
  let compositeBbox = $state<BBox | null>(null);  // Bbox of the composited tiles
  let isMercatorProjected = $state(false);  // True when data is already in EPSG:3857
  
  // Actual min/max calculated from pixel data (more accurate than API headers)
  let actualMin = $state<number | null>(null);
  let actualMax = $state<number | null>(null);
  
  // Wind particle layer
  let windLayer: WindParticleLayer | null = null;
  let windData: WindData | null = null;
  
  // Isoline layer (vector contours only)
  let isolinesEnabled = $state(false);
  let isolineInterval = $state(5.5);      // Default ~10°F interval (5.5K)
  let isolineThickness = $state(3.5);
  let isolineOpacity = $state(1.0);
  let isolineColor = $state('#000000');   // Black by default
  let showIsolineControls = $state(false);
  let contourResolution = $state(2);      // Downsample factor (1=full, 2=half, 4=quarter)
  let contourSmoothing = $state(0);       // Smoothing subdivisions (0=none, 1-8=smooth)
  let contourLabelsEnabled = $state(true); // Show labels on contour lines
  let contourLabelSize = $state(12);      // Label font size
  let steppedColorsEnabled = $state(false); // Use discrete color steps instead of smooth gradient
  let showGradientLayer = $state(true);     // Show/hide the underlying color gradient layer
  const CONTOUR_SOURCE_ID = 'contour-source';
  const CONTOUR_LAYER_ID = 'contour-lines';
  const CONTOUR_LABELS_ID = 'contour-labels';
  
  // Animation state
  let animationEnabled = $state(false);
  let animationPlaying = $state(false);
  let animationActive = $state(false);  // True when animation frames are loaded and ready
  let animationPosition = $state(0);  // 0-1 continuous position in loop
  let animationSpeed = $state(1);     // Playback speed multiplier (0.5, 1, 2, 3)
  let animationLoop = $state(true);   // Loop animation at end
  let animationFrameCount = $state(8);
  let mapLocked = $state(true);       // When true, map interactions are disabled
  let animationLoading = $state(false);
  let animationLoadingMore = $state(false);  // True when playback started but still loading more frames
  let animationLoadProgress = $state<LoadProgress | null>(null);
  let animationManager = $state<AnimationManager | null>(null);
  let animationFrameId: number | null = null;
  let lastAnimationTime = 0;
  let lastRenderedFrameIndex = -1;  // Track last rendered frame to avoid redundant updates
  let lastIsolineFrameIndex = -1;   // Track last isoline frame for animation interpolation
  const BASE_LOOP_DURATION = 4000;  // 4 seconds for full loop at 1x speed
  
  // Static weather data timestamp (when not animating)
  let staticTimestamp = $state<string | null>(null);
  // Current animation timestamp (updated during playback)
  let animationTimestamp = $state<string | null>(null);
  
  // Collection temporal metadata (for showing extent info in UI)
  let collectionMeta = $state<CollectionMetadata | null>(null);
  // Animation frame timestamps (for showing loaded range)
  let animationFrameTimestamps = $state<string[]>([]);

  // Marker state
  interface TimeSeriesPoint {
    timestamp: string;
    value: number;
  }
  interface MapMarker {
    id: string;
    lng: number;
    lat: number;
    value: number | null;
    positionData: TimeSeriesPoint[] | null;
    positionValue: number | null;
    positionLoading: boolean;
    maplibreMarker?: maplibregl.Marker;
  }
  let markers = $state<MapMarker[]>([]);
  let markerPlacementMode = $state(false);

  // Derived: current display timestamp (animation or static)
  let displayTimestamp = $derived(
    animationActive ? animationTimestamp : staticTimestamp
  );
  
  // Derived - use custom scale if user has edited it, otherwise use default
  let currentScale = $derived(customScales.get(selectedScale) ?? COLOR_SCALES[selectedScale]);
  // Use animationActive state instead of checking animationManager.hasFrames()
  // because $derived can't track changes inside class instances
  let hasAnimationFrames = $derived(animationActive);

  // Derived: parameters for current collection
  let currentCollectionParams = $derived(
    collections.find(c => c.id === selectedCollection)?.parameters ?? []
  );

  // Derived: vertical extent for current collection (if any)
  let currentVerticalExtent = $derived(
    collections.find(c => c.id === selectedCollection)?.verticalExtent ?? null
  );

  // React to external dataLayer prop changes (for compact mode)
  $effect(() => {
    if (compact && dataLayerProp !== dataLayer) {
      handleDataLayerChange(dataLayerProp);
    }
  });
  
  // React to external animation prop changes (for compact mode)
  $effect(() => {
    if (compact && animationEnabledProp !== animationEnabled) {
      if (animationEnabledProp) {
        // Start animation
        animationEnabled = true;
        loadAnimationFrames();
      } else {
        // Stop animation
        stopAnimation();
        animationEnabled = false;
        animationActive = false;
        loadWeatherData();
      }
    }
  });
  
  // Notify parent of animation state changes
  $effect(() => {
    if (compact && onAnimationChange) {
      onAnimationChange(animationPlaying);
    }
  });
  
  // React to compact mode and mapLocked changes - enable/disable map interactivity
  $effect(() => {
    if (!map) return;

    // In compact mode or when map is locked, disable interactions
    const shouldDisable = compact || mapLocked;
    console.log(`MapView: compact=${compact}, mapLocked=${mapLocked}, enabling interactions: ${!shouldDisable}`);

    if (shouldDisable) {
      // Disable all interactions
      map.dragPan.disable();
      map.scrollZoom.disable();
      map.boxZoom.disable();
      map.dragRotate.disable();
      map.keyboard.disable();
      map.doubleClickZoom.disable();
      map.touchZoomRotate.disable();
    } else {
      // Enable all interactions
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.boxZoom.enable();
      map.dragRotate.enable();
      map.keyboard.enable();
      map.doubleClickZoom.enable();
      map.touchZoomRotate.enable();

      // Make sure moveend listener is attached
      map.off("moveend", handleMapMoveEnd);
      map.on("moveend", handleMapMoveEnd);
    }
  });

  // Re-fetch position data for all markers when animation becomes active
  // This ensures markers get full time series data when animation frames are loaded
  $effect(() => {
    if (animationActive && animationManager?.hasFrames() && markers.length > 0) {
      console.log('[Position] Animation became active, re-fetching position data for', markers.length, 'markers');
      for (const marker of markers) {
        // Only re-fetch if we don't already have multi-point data
        if (!marker.positionData || marker.positionData.length <= 1) {
          marker.positionLoading = true;
          fetchPositionDataForMarker(marker);
        }
      }
    }
  });

  // Carto Dark Matter basemap
  const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
  
  // Weather layer source/layer IDs
  const WEATHER_SOURCE_ID = 'weather-data';
  const WEATHER_LAYER_ID = 'weather-layer';

  // Animation layer source/layer ID prefix
  const ANIM_SOURCE_PREFIX = 'weather-anim-src-';
  const ANIM_LAYER_PREFIX = 'weather-anim-layer-';

  /**
   * Apply pixel offset correction to bbox for proper image alignment.
   * Adjustable via bboxOffsetPixels state for debugging.
   * Positive = expand outward, Negative = shrink inward
   */
  function correctBboxForCellCenters(
    bbox: [number, number, number, number],
    imgWidth: number,
    imgHeight: number
  ): [number, number, number, number] {
    const [west, south, east, north] = bbox;

    // Calculate pixel size in degrees
    const pixelWidth = (east - west) / imgWidth;
    const pixelHeight = (north - south) / imgHeight;

    // Apply configurable offset
    const offset = bboxOffsetPixels;
    return [
      west - pixelWidth * offset,
      south - pixelHeight * offset,
      east + pixelWidth * offset,
      north + pixelHeight * offset,
    ];
  }

  // Track active animation sources/layers
  let animationSourceIds: string[] = [];
  let animationLayerIds: string[] = [];
  let currentVisibleAnimLayer: number = -1;

  /**
   * Convert latitude to Web Mercator Y coordinate (normalized 0-1 for -85.051° to 85.051°)
   */
  function latToMercatorY(lat: number): number {
    const MAX_LAT = 85.051129;
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const latRad = clampedLat * Math.PI / 180;
    const mercatorY = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    // Normalize to 0-1 range (where -85.051° = 0, 85.051° = 1)
    const maxMercY = Math.log(Math.tan(Math.PI / 4 + MAX_LAT * Math.PI / 360));
    return (mercatorY + maxMercY) / (2 * maxMercY);
  }

  /**
   * Convert Web Mercator Y (normalized 0-1) back to latitude
   */
  function mercatorYToLat(mercY: number): number {
    const MAX_LAT = 85.051129;
    const maxMercY = Math.log(Math.tan(Math.PI / 4 + MAX_LAT * Math.PI / 360));
    const mercatorY = mercY * 2 * maxMercY - maxMercY;
    const latRad = 2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2;
    return latRad * 180 / Math.PI;
  }

  /**
   * Reproject image data from CRS:84 (geographic) to Web Mercator (EPSG:3857)
   * This corrects the Mercator distortion when displaying on MapLibre.
   * Handles non-square source pixels (e.g., HRRR data reprojected from Lambert Conformal).
   *
   * @param data - Source image data in CRS:84
   * @param srcWidth - Source image width
   * @param srcHeight - Source image height
   * @param bbox - Geographic bbox [west, south, east, north] in degrees
   * @returns Object with reprojected data, dimensions, and new Mercator bbox
   */
  function reprojectToMercator(
    data: Uint8ClampedArray,
    srcWidth: number,
    srcHeight: number,
    bbox: [number, number, number, number]
  ): { data: Uint8ClampedArray; width: number; height: number; mercatorBbox: [number, number, number, number] } {
    const [west, south, east, north] = bbox;

    // Convert lat bounds to Mercator Y (using raw Mercator formula, not normalized)
    const mercSouthRaw = Math.log(Math.tan(Math.PI / 4 + (south * Math.PI / 180) / 2));
    const mercNorthRaw = Math.log(Math.tan(Math.PI / 4 + (north * Math.PI / 180) / 2));
    const mercHeightRaw = mercNorthRaw - mercSouthRaw;

    // Calculate the Mercator width (longitude is linear, so just use degree width converted to radians)
    const mercWidthRaw = (east - west) * Math.PI / 180;

    // Calculate output dimensions to maintain square pixels in Mercator space
    // For non-square source pixels (like HRRR), we need to use the geographic extent
    // to determine the correct Mercator pixel count, not just the source dimensions.
    //
    // The Mercator aspect ratio tells us how many pixels tall we need for a given width
    // to have square pixels in Mercator space.
    const mercatorAspect = mercHeightRaw / mercWidthRaw;

    // Use source width, calculate height for square Mercator pixels
    const dstWidth = srcWidth;
    const dstHeight = Math.round(dstWidth * mercatorAspect);

    // Debug: log the dimension change and what it means
    const srcPixelAspect = (srcWidth / srcHeight);
    const geoAspect = (east - west) / (north - south);
    console.log(`Reprojection: src=${srcWidth}x${srcHeight} (pixel aspect ${srcPixelAspect.toFixed(3)}), geo aspect=${geoAspect.toFixed(3)}, mercator aspect=${mercatorAspect.toFixed(3)}, dst=${dstWidth}x${dstHeight}`);

    // Note: Non-square source pixels (like HRRR from Lambert Conformal) are handled correctly
    // by this reprojection - we resample based on geographic coordinates, not pixel indices.
    // The source pixel aspect ratio doesn't need to match the geo aspect ratio.
    const pixelAspectMismatch = Math.abs(srcPixelAspect - geoAspect) > 0.01;
    if (pixelAspectMismatch) {
      console.log(`Note: Non-square source pixels detected (pixel aspect ${srcPixelAspect.toFixed(3)} vs geo aspect ${geoAspect.toFixed(3)}), reprojection will handle this correctly`);
    }

    // Create output buffer
    const dstData = new Uint8ClampedArray(dstWidth * dstHeight * 4);

    // For each output pixel, find the corresponding source pixel
    // We need to map geographic coordinates, not pixel indices directly
    const srcLatRange = north - south;
    const srcLngRange = east - west;

    for (let dstY = 0; dstY < dstHeight; dstY++) {
      // Output Y position - use pixel CENTER (0.5 offset) for correct alignment
      // This assumes bbox represents pixel EDGES, not centers
      const dstYNorm = (dstY + 0.5) / dstHeight; // 0 to 1, top to bottom (center of each pixel)

      // Convert to Mercator Y, then to latitude
      // Linear interpolation in Mercator space
      const mercY = mercNorthRaw - dstYNorm * mercHeightRaw;
      // Convert Mercator Y back to latitude
      const lat = (2 * Math.atan(Math.exp(mercY)) - Math.PI / 2) * 180 / Math.PI;

      // Convert latitude to source Y position (geographic mapping)
      // Use pixel centers: srcY=0 is center of first pixel, srcY=srcHeight-1 is center of last
      const srcYNorm = (north - lat) / srcLatRange; // 0 to 1, north to south
      const srcY = srcYNorm * srcHeight - 0.5; // Map to pixel centers

      // Bilinear interpolation Y components (clamp to valid range)
      const srcY0 = Math.max(0, Math.floor(srcY));
      const srcY1 = Math.min(srcY0 + 1, srcHeight - 1);
      const yFrac = Math.max(0, srcY - srcY0);

      for (let dstX = 0; dstX < dstWidth; dstX++) {
        // X is linear (longitude doesn't change between projections)
        // Use pixel CENTER for correct alignment
        const dstXNorm = (dstX + 0.5) / dstWidth; // 0 to 1, left to right (center of each pixel)
        const lng = west + dstXNorm * srcLngRange;

        // Convert longitude to source X position (geographic mapping)
        // Use pixel centers
        const srcXNorm = (lng - west) / srcLngRange; // 0 to 1, west to east
        const srcX = srcXNorm * srcWidth - 0.5; // Map to pixel centers

        // Bilinear interpolation X components (clamp to valid range)
        const srcX0 = Math.max(0, Math.floor(srcX));
        const srcX1 = Math.min(srcX0 + 1, srcWidth - 1);
        const xFrac = Math.max(0, srcX - srcX0);

        // Get 4 source pixels for bilinear interpolation
        const idx00 = (srcY0 * srcWidth + srcX0) * 4;
        const idx01 = (srcY0 * srcWidth + srcX1) * 4;
        const idx10 = (srcY1 * srcWidth + srcX0) * 4;
        const idx11 = (srcY1 * srcWidth + srcX1) * 4;

        // Bilinear interpolation for each channel
        const dstIdx = (dstY * dstWidth + dstX) * 4;
        for (let c = 0; c < 4; c++) {
          const v00 = data[idx00 + c];
          const v01 = data[idx01 + c];
          const v10 = data[idx10 + c];
          const v11 = data[idx11 + c];

          const v0 = v00 * (1 - xFrac) + v01 * xFrac;
          const v1 = v10 * (1 - xFrac) + v11 * xFrac;
          const v = v0 * (1 - yFrac) + v1 * yFrac;

          dstData[dstIdx + c] = Math.round(v);
        }
      }
    }

    // The bbox in Mercator coordinates (still using lat/lng for MapLibre)
    // MapLibre handles the conversion internally, we just need to provide correct geographic bounds
    // But now our image pixels are evenly spaced in Mercator, not geographic
    return {
      data: dstData,
      width: dstWidth,
      height: dstHeight,
      mercatorBbox: [west, south, east, north], // Same bbox, but image is now Mercator-correct
    };
  }
  
  /**
   * Fix the vertical seam at the prime meridian (0° longitude) by interpolating
   * pixel values from neighboring columns.
   */
  function fixPrimeMeridianSeam(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    bbox: [number, number, number, number]
  ): Uint8ClampedArray {
    const [west, , east, ] = bbox;
    
    // Only fix if the bbox crosses 0° longitude
    if (west >= 0 || east <= 0) {
      return data;
    }
    
    // Find the pixel column corresponding to 0° longitude
    const lonRange = east - west;
    const zeroLonNormalized = (0 - west) / lonRange; // 0-1 position of 0° longitude
    const seamColumn = Math.round(zeroLonNormalized * (width - 1));
    
    // If seam is at edge, nothing to fix
    if (seamColumn <= 1 || seamColumn >= width - 2) {
      return data;
    }
    
    console.log(`Fixing prime meridian seam at column ${seamColumn} (bbox: ${west.toFixed(2)} to ${east.toFixed(2)})`);
    
    // Create a copy of the data
    const fixed = new Uint8ClampedArray(data);
    
    // Interpolate the seam column and one column on each side for smoother blending
    for (let y = 0; y < height; y++) {
      // Get pixels from 2 columns left and 2 columns right of seam
      const leftCol2 = seamColumn - 2;
      const leftCol1 = seamColumn - 1;
      const rightCol1 = seamColumn + 1;
      const rightCol2 = seamColumn + 2;
      
      for (let channel = 0; channel < 4; channel++) {
        const left2Val = data[(y * width + leftCol2) * 4 + channel];
        const left1Val = data[(y * width + leftCol1) * 4 + channel];
        const right1Val = data[(y * width + rightCol1) * 4 + channel];
        const right2Val = data[(y * width + rightCol2) * 4 + channel];
        
        // Interpolate values for the seam area (3 columns: left1, seam, right1)
        // Use cubic-ish interpolation weights
        const avgLeft = (left2Val + left1Val * 2) / 3;
        const avgRight = (right2Val + right1Val * 2) / 3;
        
        // Blend across the 3 columns
        fixed[(y * width + leftCol1) * 4 + channel] = Math.round(avgLeft * 0.7 + avgRight * 0.3);
        fixed[(y * width + seamColumn) * 4 + channel] = Math.round((avgLeft + avgRight) / 2);
        fixed[(y * width + rightCol1) * 4 + channel] = Math.round(avgLeft * 0.3 + avgRight * 0.7);
      }
    }
    
    return fixed;
  }

  /**
   * Apply Gaussian blur to grayscale image data.
   * Uses a 5x5 kernel for a nice soft blur effect.
   */
  function applyGaussianBlur(
    data: Uint8ClampedArray,
    width: number,
    height: number
  ): Uint8ClampedArray {
    // 5x5 Gaussian kernel (sigma ≈ 1.4)
    const kernel = [
      1,  4,  7,  4, 1,
      4, 16, 26, 16, 4,
      7, 26, 41, 26, 7,
      4, 16, 26, 16, 4,
      1,  4,  7,  4, 1
    ];
    const kernelSum = 273;
    const kernelSize = 5;
    const halfKernel = Math.floor(kernelSize / 2);
    
    const result = new Uint8ClampedArray(data.length);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        
        for (let ky = 0; ky < kernelSize; ky++) {
          for (let kx = 0; kx < kernelSize; kx++) {
            const px = Math.min(width - 1, Math.max(0, x + kx - halfKernel));
            const py = Math.min(height - 1, Math.max(0, y + ky - halfKernel));
            const idx = (py * width + px) * 4;
            const weight = kernel[ky * kernelSize + kx];
            
            r += data[idx] * weight;
            g += data[idx + 1] * weight;
            b += data[idx + 2] * weight;
            a += data[idx + 3] * weight;
          }
        }
        
        const outIdx = (y * width + x) * 4;
        result[outIdx] = Math.round(r / kernelSum);
        result[outIdx + 1] = Math.round(g / kernelSum);
        result[outIdx + 2] = Math.round(b / kernelSum);
        result[outIdx + 3] = Math.round(a / kernelSum);
      }
    }
    
    return result;
  }

  /**
   * Get the actual data units from the API response
   * Falls back to checking dataLayer if no currentTile is loaded
   */
  function getDataUnits(): string {
    if (currentTile?.metadata?.units) {
      return currentTile.metadata.units;
    }
    // Fallback to dataLayer-based detection
    switch (dataLayer) {
      case 'temperature':
      case 'dewpoint':
        return 'K';
      case 'humidity':
        return '%';
      case 'precipitation':
        return 'mm';
      case 'reflectivity':
        return 'dBZ';
      default:
        return '';
    }
  }
  
  /**
   * Check if the current data uses temperature units (Kelvin)
   * Uses actual API response units, not UI selection
   */
  function isTemperatureData(): boolean {
    const units = getDataUnits();
    return units === 'K';
  }
  
  /**
   * Get the appropriate unit suffix for contour labels based on actual data units
   */
  function getContourLabelUnit(): string {
    const units = getDataUnits();
    switch (units) {
      case 'K':
        return temperatureUnit === 'F' ? '°F' : '°C';
      case '%':
        return '%';
      case 'mm':
        return 'mm';
      case 'dBZ':
        return 'dBZ';
      default:
        return units || '';
    }
  }
  
  /**
   * Build MapLibre expression for contour label text based on data type
   * Returns the appropriate expression to convert raw values to display values
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildContourTextFieldExpression(): any {
    const unit = getContourLabelUnit();
    
    if (isTemperatureData()) {
      // Temperature data: convert from Kelvin to F or C
      // Kelvin to Celsius: K - 273.15
      // Kelvin to Fahrenheit: (K - 273.15) * 1.8 + 32
      return temperatureUnit === 'F'
        ? ['concat', 
            ['to-string', ['round', ['+', ['*', ['-', ['get', 'level'], 273.15], 1.8], 32]]], 
            unit
          ]
        : ['concat', 
            ['to-string', ['round', ['-', ['get', 'level'], 273.15]]], 
            unit
          ];
    } else {
      // Non-temperature data: display the raw value rounded
      return ['concat', 
        ['to-string', ['round', ['get', 'level']]], 
        unit
      ];
    }
  }
  
  /**
   * Get display interval label for the UI slider
   * Uses actual API units to determine formatting
   */
  function getIntervalDisplayLabel(): string {
    const units = getDataUnits();
    switch (units) {
      case 'K':
        return temperatureUnit === 'F' 
          ? `${(isolineInterval * 1.8).toFixed(0)}°F` 
          : `${isolineInterval.toFixed(1)}°C`;
      case '%':
        return `${isolineInterval.toFixed(0)}%`;
      case 'mm':
        return `${isolineInterval.toFixed(1)}mm`;
      case 'dBZ':
        return `${isolineInterval.toFixed(0)}dBZ`;
      default:
        return `${isolineInterval.toFixed(1)}${units}`;
    }
  }
  
  /**
   * Calculate contour levels that snap to nice round numbers in display units
   * This matches the logic in extractContours for consistent alignment
   */
  function calculateContourLevels(dataMin: number, dataMax: number): number[] {
    const levels: number[] = [];
    
    if (isTemperatureData()) {
      // Temperature data: convert from Kelvin to display units
      const displayMin = temperatureUnit === 'F' 
        ? (dataMin - 273.15) * 1.8 + 32 
        : dataMin - 273.15;
      const displayMax = temperatureUnit === 'F'
        ? (dataMax - 273.15) * 1.8 + 32
        : dataMax - 273.15;
      
      // Calculate display interval
      const displayInterval = Math.round(temperatureUnit === 'F' ? isolineInterval * 1.8 : isolineInterval);
      
      // Start from a clean multiple of the display interval
      const startDisplayLevel = Math.ceil(displayMin / displayInterval) * displayInterval;
      
      for (let displayLevel = startDisplayLevel; displayLevel <= displayMax; displayLevel += displayInterval) {
        // Convert back to Kelvin
        const kelvinLevel = temperatureUnit === 'F'
          ? (displayLevel - 32) / 1.8 + 273.15
          : displayLevel + 273.15;
        levels.push(kelvinLevel);
      }
    } else {
      // Non-temperature data: use values directly (humidity %, precipitation mm, etc.)
      const interval = isolineInterval;
      
      // Start from a clean multiple of the interval
      const startLevel = Math.ceil(dataMin / interval) * interval;
      
      for (let level = startLevel; level <= dataMax; level += interval) {
        levels.push(level);
      }
    }
    
    return levels;
  }
  
  /**
   * Apply a colormap to grayscale image data and return a data URL
   */
  function applyColormapToImage(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    scale: ColorScale,
    bbox?: [number, number, number, number],
    metadata?: { min: number; max: number }
  ): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    
    // Fix prime meridian seam if bbox provided and crosses 0°
    let processedData = data;
    if (bbox) {
      processedData = fixPrimeMeridianSeam(data, width, height, bbox);
    }
    
    // Use variable alpha for radar scales to make low values transparent
    const isRadarScale = selectedScale === 'reflectivity' || selectedScale === 'radarWarm';
    const alpha = isRadarScale ? radarAlphaFunction : 200;
    
    let coloredData: Uint8ClampedArray;
    
    // Use relative mapping: full gradient spans the actual data range from API headers
    // This ensures rich gradients regardless of the specific data values
    if (steppedColorsEnabled && isolineInterval > 0 && metadata) {
      // Stepped colors: create discrete bands at contour levels
      const levels = calculateContourLevels(metadata.min, metadata.max);
      coloredData = applySteppedColormapWithLevels(processedData, scale, levels, metadata.min, metadata.max, alpha);
    } else {
      // Smooth gradient: pixel 0 = min color, pixel 255 = max color
      coloredData = applyColormapToImageData(processedData, scale, alpha);
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageData = new ImageData(coloredData as any, width, height);
    ctx.putImageData(imageData, 0, 0);
    
    return canvas.toDataURL('image/png');
  }
  
  /**
   * Add or update the weather layer on the map
   */
  function updateWeatherLayer() {
    if (!map || !currentTile || !grayscaleData) return;

    const sourceBbox = currentTile.metadata.bbox as [number, number, number, number];

    let dataToColor: Uint8ClampedArray;
    let outputWidth: number;
    let outputHeight: number;

    if (isMercatorProjected) {
      // Data is already in EPSG:3857 (from tiles), no reprojection needed
      dataToColor = grayscaleData;
      outputWidth = imageWidth;
      outputHeight = imageHeight;
      
      // Apply blur if enabled
      if (interpolationMode === 'blur') {
        dataToColor = applyGaussianBlur(dataToColor, outputWidth, outputHeight);
      }
      
      console.log(`Updating weather layer (tile-based, no reprojection):`);
      console.log(`  Composite bbox: [${sourceBbox.map(v => v.toFixed(4)).join(', ')}]`);
      console.log(`  Image dimensions: ${outputWidth}x${outputHeight}`);
    } else {
      // Reproject from CRS:84 to Web Mercator to fix distortion on the Mercator map
      const reprojected = reprojectToMercator(
        grayscaleData,
        imageWidth,
        imageHeight,
        sourceBbox
      );
      
      dataToColor = reprojected.data;
      outputWidth = reprojected.width;
      outputHeight = reprojected.height;

      // Apply blur to reprojected data if blur mode is enabled
      if (interpolationMode === 'blur') {
        dataToColor = applyGaussianBlur(dataToColor, outputWidth, outputHeight);
      }
      
      console.log(`Updating weather layer (single request, reprojected):`);
      console.log(`  Source bbox (from server): [${sourceBbox.map(v => v.toFixed(4)).join(', ')}]`);
      console.log(`  Image dimensions: ${imageWidth}x${imageHeight} -> reprojected ${outputWidth}x${outputHeight}`);
    }

    const coloredDataUrl = applyColormapToImage(
      dataToColor,
      outputWidth,
      outputHeight,
      currentScale,  // Use currentScale which includes custom edits
      sourceBbox,
      currentTile.metadata
    );

    // Use the bbox from the server response directly
    const [west, south, east, north] = sourceBbox;

    // Use linear resampling for smooth/blur, nearest for pixelated
    const resampling = interpolationMode === 'pixelated' ? 'nearest' : 'linear';
    
    const source = map.getSource(WEATHER_SOURCE_ID) as maplibregl.ImageSource | undefined;

    console.log(`MapLibre coordinates: TL=[${west.toFixed(4)}, ${north.toFixed(4)}], TR=[${east.toFixed(4)}, ${north.toFixed(4)}], BR=[${east.toFixed(4)}, ${south.toFixed(4)}], BL=[${west.toFixed(4)}, ${south.toFixed(4)}]`);

    if (source) {
      source.updateImage({
        url: coloredDataUrl,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ]
      });
      // Also update resampling mode
      if (map.getLayer(WEATHER_LAYER_ID)) {
        map.setPaintProperty(WEATHER_LAYER_ID, 'raster-resampling', resampling);
      }
    } else {
      map.addSource(WEATHER_SOURCE_ID, {
        type: 'image',
        url: coloredDataUrl,
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ]
      });
      
      map.addLayer({
        id: WEATHER_LAYER_ID,
        type: 'raster',
        source: WEATHER_SOURCE_ID,
        paint: {
          'raster-opacity': 0.75,
          'raster-fade-duration': 0,
          'raster-resampling': resampling
        }
      });
    }
    
    // Update isoline layer (uses original non-reprojected data)
    updateIsolineLayer();
  }
  
  /**
   * Create or update the isoline layer with grayscale data
   * Uses ORIGINAL (non-reprojected) data - MapLibre handles projection for vector layers
   */
  function updateIsolineLayer() {
    if (!map || !currentTile || !grayscaleData) return;
    
    // Use original non-reprojected data - MapLibre's vector layers
    // automatically project GeoJSON coordinates from WGS84 to Mercator
    updateVectorContours(grayscaleData, imageWidth, imageHeight);
  }
  
  /**
   * Update vector contours using marching squares and MapLibre line layers
   */
  function updateVectorContours(
    data: Uint8ClampedArray,
    width: number,
    height: number
  ) {
    if (!map || !currentTile || !isolinesEnabled) return;
    
    const bbox = currentTile.metadata.bbox as [number, number, number, number];
    const { min, max } = currentTile.metadata;
    
    // Optionally downsample data for faster processing
    let processData = data;
    let processWidth = width;
    let processHeight = height;
    
    if (contourResolution > 1) {
      const downsampled = downsampleData(data, width, height, contourResolution);
      processData = downsampled.data;
      processWidth = downsampled.width;
      processHeight = downsampled.height;
      console.log(`Downsampled ${width}x${height} -> ${processWidth}x${processHeight} (${contourResolution}x)`);
    }
    
    // Extract contours using marching squares
    // Pass display unit config for proper level snapping
    const startTime = performance.now();
    
    // Build display unit config based on data type
    let displayUnitConfig: { unit: 'F' | 'C' | 'K'; interval: number };
    
    if (isTemperatureData()) {
      // Temperature: convert to user's preferred unit
      const displayInterval = temperatureUnit === 'F' ? isolineInterval * 1.8 : isolineInterval;
      displayUnitConfig = {
        unit: temperatureUnit,
        interval: Math.round(displayInterval)  // Round to nearest whole degree
      };
    } else {
      // Non-temperature data (humidity %, precipitation mm, etc.)
      // Use 'K' unit which does no conversion (pass-through) but still gets snapping
      displayUnitConfig = {
        unit: 'K',
        interval: Math.round(isolineInterval)  // Round to nearest whole number (e.g., 10%)
      };
    }
    
    const contours = extractContours(processData, processWidth, processHeight, min, max, bbox, isolineInterval, contourSmoothing, displayUnitConfig);
    
    const geojson = contoursToGeoJSON(contours);
    const elapsed = performance.now() - startTime;
    
    console.log(`Extracted ${contours.lines.length} contour lines at ${contours.levels.length} levels in ${elapsed.toFixed(1)}ms (smoothing=${contourSmoothing})`);
    
    // Update or create the GeoJSON source
    const source = map.getSource(CONTOUR_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    
    if (source) {
      source.setData(geojson);
    } else {
      map.addSource(CONTOUR_SOURCE_ID, {
        type: 'geojson',
        data: geojson
      });
      
      map.addLayer({
        id: CONTOUR_LAYER_ID,
        type: 'line',
        source: CONTOUR_SOURCE_ID,
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': isolineColor,
          'line-width': isolineThickness,
          'line-opacity': isolineOpacity
        }
      });
      
      // Build text-field expression based on data type
      const textFieldExpression = buildContourTextFieldExpression();
      
      // Add labels layer
      map.addLayer({
        id: CONTOUR_LABELS_ID,
        type: 'symbol',
        source: CONTOUR_SOURCE_ID,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 250,
          'text-field': textFieldExpression,
          'text-size': contourLabelSize,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-rotation-alignment': 'viewport',  // Keep text upright
          'text-keep-upright': true,              // Flip text to stay readable
          'text-pitch-alignment': 'viewport',
          'text-allow-overlap': true,             // Don't hide labels due to collision
          'text-ignore-placement': true,          // Don't affect other label placement
          'visibility': contourLabelsEnabled ? 'visible' : 'none'
        },
        paint: {
          'text-color': isolineColor,
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
          'text-opacity': isolineOpacity
        }
      });
      
      console.log('Vector contour layer created with labels');
    }
    
    // Update paint/layout properties if they changed
    if (map.getLayer(CONTOUR_LAYER_ID)) {
      map.setPaintProperty(CONTOUR_LAYER_ID, 'line-color', isolineColor);
      map.setPaintProperty(CONTOUR_LAYER_ID, 'line-width', isolineThickness);
      map.setPaintProperty(CONTOUR_LAYER_ID, 'line-opacity', isolineOpacity);
      // Ensure visibility
      map.setLayoutProperty(CONTOUR_LAYER_ID, 'visibility', 'visible');
      // Move to top so it renders above animation layers
      map.moveLayer(CONTOUR_LAYER_ID);
    }
    
    // Update labels layer
    if (map.getLayer(CONTOUR_LABELS_ID)) {
      map.setPaintProperty(CONTOUR_LABELS_ID, 'text-color', isolineColor);
      map.setPaintProperty(CONTOUR_LABELS_ID, 'text-opacity', isolineOpacity);
      map.setLayoutProperty(CONTOUR_LABELS_ID, 'text-size', contourLabelSize);
      map.setLayoutProperty(CONTOUR_LABELS_ID, 'visibility', contourLabelsEnabled ? 'visible' : 'none');
      // Update text-field expression when data type or unit changes
      map.setLayoutProperty(CONTOUR_LABELS_ID, 'text-field', buildContourTextFieldExpression());
      // Move labels to top
      map.moveLayer(CONTOUR_LABELS_ID);
    }
  }
  
  // Helper to convert hex color to RGB array [0-1]
  function hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
      ];
    }
    return [0, 0, 0];
  }

  /**
   * Update contour lines using the current data
   * Uses ORIGINAL (non-reprojected) data because MapLibre vector layers
   * automatically project GeoJSON coordinates from WGS84 to Mercator.
   * This ensures contours align correctly with the raster layer.
   */
  function updateContours() {
    if (!map || !currentTile || !grayscaleData) return;
    
    // Use original non-reprojected data - MapLibre handles projection for vector layers
    // The raster layer uses reprojected data placed at CRS:84 coords,
    // and vector layers use CRS:84 coords that MapLibre projects automatically.
    updateVectorContours(grayscaleData, imageWidth, imageHeight);
  }
  
  /**
   * Calculate actual min/max values from the grayscale pixel data
   */
  function calculateActualMinMax() {
    if (!grayscaleData || !currentTile) return;
    
    let min = 255;
    let max = 0;
    
    // Sample grayscale values (R channel from RGBA data)
    for (let i = 0; i < grayscaleData.length; i += 4) {
      const value = grayscaleData[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    
    // Convert normalized values (0-255) to actual data values
    const range = currentTile.metadata.max - currentTile.metadata.min;
    actualMin = currentTile.metadata.min + (min / 255) * range;
    actualMax = currentTile.metadata.min + (max / 255) * range;
    
    console.log(`Actual data range: ${actualMin.toFixed(1)} - ${actualMax.toFixed(1)} ${currentTile.metadata.units} (API reported: ${currentTile.metadata.min.toFixed(1)} - ${currentTile.metadata.max.toFixed(1)})`);
  }

  /**
   * Load weather data using tile-based approach.
   * Fetches multiple smaller tiles and composites them.
   */
  async function loadWeatherDataTiled(
    west: number,
    south: number,
    east: number,
    north: number,
    mapZoom: number,
    selectedTimestamp: string | null
  ) {
    const tileCache = getTileCache();
    const compositor = getTileCompositor();
    
    // Calculate tile zoom level
    // Minimum zoom 4 ensures tiles are ~2500km at most (won't cause 413 errors)
    // Maximum zoom 8 keeps tile count reasonable
    const tileZoom = mapZoomToTileZoom(mapZoom, tileZoomOffset, 4, 8);
    
    // Get visible tiles
    const viewportBbox: BBox = { west, south, east, north };
    const tiles = getVisibleTiles(viewportBbox, tileZoom);
    currentTileCoords = tiles;
    
    console.log(`Tile-based loading: map zoom ${mapZoom.toFixed(1)} -> tile zoom ${tileZoom}, ${tiles.length} tiles`);
    
    // Fetch tiles (with caching)
    const fetchResult = await fetchTiles(tiles, tileCache, {
      collection: selectedCollection,
      parameter: selectedParameter,
      datetime: selectedTimestamp ?? undefined,
      z: selectedVerticalLevel ?? undefined,
      useGlobalScale: true,  // Renormalize to global fixed scale
    });
    
    if (fetchResult.errors.size > 0) {
      console.warn(`${fetchResult.errors.size} tiles failed to load:`, fetchResult.errors);
      
      // If all tiles failed (likely 413 errors), fall back to single request mode
      if (fetchResult.tiles.size === 0) {
        console.log('All tiles failed, falling back to single request mode');
        await loadWeatherDataSingle(west, south, east, north, selectedTimestamp);
        return;
      }
    }
    
    // Composite tiles
    const composite = compositor.composite(
      fetchResult.tiles,
      tiles,
      selectedCollection,
      selectedParameter,
      selectedTimestamp ?? undefined
    );
    
    if (!composite) {
      throw new Error('Failed to composite tiles');
    }
    
    // Set the grayscale data and dimensions
    grayscaleData = composite.data;
    imageWidth = composite.width;
    imageHeight = composite.height;
    compositeBbox = composite.bbox;
    isMercatorProjected = false;  // Tiles are CRS:84, client reprojection needed
    
    // Create a synthetic currentTile for compatibility with existing code
    const paramScale = getParameterScale(selectedParameter);
    currentTile = {
      image: createImageFromData(composite.data, composite.width, composite.height),
      metadata: {
        encoding: 'uint8',
        min: paramScale.min,
        max: paramScale.max,
        units: paramScale.unit,
        bbox: [composite.bbox.west, composite.bbox.south, composite.bbox.east, composite.bbox.north],
        width: composite.width,
        height: composite.height,
        parameter: selectedParameter,
        crs: 'CRS:84',  // Geographic projection - will be reprojected by client
        datetime: selectedTimestamp ?? undefined,
      },
    };
    
    // Update last loaded bbox
    lastLoadedBbox = composite.bbox;
    
    console.log(`Tiled data loaded: ${imageWidth}x${imageHeight} from ${fetchResult.tiles.size} tiles, bbox: [${composite.bbox.west.toFixed(4)}, ${composite.bbox.south.toFixed(4)}, ${composite.bbox.east.toFixed(4)}, ${composite.bbox.north.toFixed(4)}]`);
  }

  /**
   * Create an HTMLImageElement from RGBA data.
   * Used for compatibility with existing code that expects an image.
   */
  function createImageFromData(data: Uint8ClampedArray, width: number, height: number): HTMLImageElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    
    const img = new Image();
    img.src = canvas.toDataURL();
    return img;
  }

  /**
   * Load weather data using single request approach (original method).
   * Makes one large request for the entire viewport.
   */
  async function loadWeatherDataSingle(
    west: number,
    south: number,
    east: number,
    north: number,
    selectedTimestamp: string | null
  ) {
    isMercatorProjected = false;  // Data will be CRS:84, needs reprojection
    compositeBbox = null;
    
    // Omit width/height to get native grid resolution from server
    currentTile = await fetchDataTile({
      parameter: selectedParameter,
      collection: selectedCollection,
      bbox: { west, south, east, north },
      datetime: selectedTimestamp ?? undefined,
      z: selectedVerticalLevel ?? undefined,
      crs: selectedCRS,
    });
    
    // Extract grayscale data for re-coloring
    const canvas = document.createElement('canvas');
    canvas.width = currentTile.image.width;
    canvas.height = currentTile.image.height;
    imageWidth = canvas.width;
    imageHeight = canvas.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(currentTile.image, 0, 0);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    grayscaleData = new Uint8ClampedArray(imgData.data);
    
    // Update last loaded bbox
    const [bboxWest, bboxSouth, bboxEast, bboxNorth] = currentTile.metadata.bbox;
    lastLoadedBbox = { west: bboxWest, south: bboxSouth, east: bboxEast, north: bboxNorth };
    
    console.log(`Single request data loaded: ${imageWidth}x${imageHeight} (native grid), range: ${currentTile.metadata.min.toFixed(1)} - ${currentTile.metadata.max.toFixed(1)} ${currentTile.metadata.units}`);
  }

  async function loadWeatherData() {
    if (!map) return;

    loading = true;
    error = null;

    try {
      const bounds = map.getBounds();
      const west = Math.max(-180, bounds.getWest());
      const south = Math.max(-85, bounds.getSouth());
      const east = Math.min(180, bounds.getEast());
      const north = Math.min(85, bounds.getNorth());
      const mapZoom = map.getZoom();

      // Use selectedCollection and selectedParameter for data fetching
      console.log(`Requesting ${selectedParameter} from ${selectedCollection} for bbox: [${west.toFixed(2)}, ${south.toFixed(2)}, ${east.toFixed(2)}, ${north.toFixed(2)}]`);

      // Fetch collection metadata and find timestamp closest to now (rounded down to nearest hour)
      const meta = await fetchCollectionMetadata(selectedCollection);
      collectionMeta = meta;
      const now = new Date();
      const nowHourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);

      // Find the closest available timestamp that's <= now (rounded down)
      let bestTimestamp: string | null = null;
      let bestDiff = Infinity;
      for (const ts of meta.availableTimestamps) {
        const tsDate = new Date(ts);
        // Only consider timestamps at or before the current hour
        if (tsDate <= nowHourStart) {
          const diff = nowHourStart.getTime() - tsDate.getTime();
          if (diff < bestDiff) {
            bestDiff = diff;
            bestTimestamp = ts;
          }
        }
      }
      // Fallback to first available if none found before now
      const selectedTimestamp = bestTimestamp ?? meta.availableTimestamps[0] ?? null;

      // Determine if we should use tiled loading
      // Regional models (HRRR, MRMS) have coverage issues with tiling - use single request
      const isRegionalModel = selectedCollection.toLowerCase().includes('hrrr') || 
                              selectedCollection.toLowerCase().includes('mrms') ||
                              selectedCollection.toLowerCase().includes('nbm') ||
                              selectedCollection.toLowerCase().includes('ndfd');
      const shouldUseTiles = useTiledLoading && !isRegionalModel;

      if (shouldUseTiles) {
        // TILE-BASED LOADING (for global models like GFS)
        await loadWeatherDataTiled(west, south, east, north, mapZoom, selectedTimestamp);
      } else {
        // SINGLE REQUEST LOADING (for regional models or when tiled loading disabled)
        if (isRegionalModel && useTiledLoading) {
          console.log(`Using single-request mode for regional model: ${selectedCollection}`);
        }
        await loadWeatherDataSingle(west, south, east, north, selectedTimestamp);
      }
      
      // Calculate actual min/max from pixel data
      calculateActualMinMax();

      // Store the timestamp for display
      staticTimestamp = selectedTimestamp;

      updateWeatherLayer();

      // Update marker values with new data
      if (markers.length > 0) {
        updateMarkerValues();
      }

    } catch (err) {
      error = `Failed to load weather data: ${err instanceof Error ? err.message : "Unknown error"}`;
      console.error("Weather data error:", err);
    } finally {
      loading = false;
    }
  }

  // Debounce timer for map movement and resize
  let moveTimeout: ReturnType<typeof setTimeout> | null = null;
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let lastContainerWidth = 0;
  let lastContainerHeight = 0;

  // Track last loaded bbox to avoid refetching on small movements
  let lastLoadedBbox: { west: number; south: number; east: number; north: number } | null = null;

  /**
   * Check if the current viewport has moved significantly from the last loaded bbox.
   * Returns true if we should reload data.
   */
  function shouldReloadData(): boolean {
    if (!map || !lastLoadedBbox) return true;

    const bounds = map.getBounds();
    const currentBbox = {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    };

    // Calculate how much of the current view is outside the loaded bbox
    const loadedWidth = lastLoadedBbox.east - lastLoadedBbox.west;
    const loadedHeight = lastLoadedBbox.north - lastLoadedBbox.south;

    // Check if current viewport extends beyond loaded area by more than 20%
    const threshold = 0.2;
    const westOverflow = Math.max(0, lastLoadedBbox.west - currentBbox.west) / loadedWidth;
    const eastOverflow = Math.max(0, currentBbox.east - lastLoadedBbox.east) / loadedWidth;
    const southOverflow = Math.max(0, lastLoadedBbox.south - currentBbox.south) / loadedHeight;
    const northOverflow = Math.max(0, currentBbox.north - lastLoadedBbox.north) / loadedHeight;

    const totalOverflow = westOverflow + eastOverflow + southOverflow + northOverflow;

    if (totalOverflow > threshold) {
      console.log(`Viewport overflow: ${(totalOverflow * 100).toFixed(1)}% - reloading data`);
      return true;
    }

    // Also reload if zoom changed significantly (viewport size changed by >30%)
    const currentWidth = currentBbox.east - currentBbox.west;
    const currentHeight = currentBbox.north - currentBbox.south;
    const widthRatio = currentWidth / loadedWidth;
    const heightRatio = currentHeight / loadedHeight;

    if (widthRatio < 0.7 || widthRatio > 1.3 || heightRatio < 0.7 || heightRatio > 1.3) {
      console.log(`Zoom change detected (ratio: ${widthRatio.toFixed(2)}x${heightRatio.toFixed(2)}) - reloading data`);
      return true;
    }

    return false;
  }

  function handleMapMoveEnd() {
    // Don't reload during animation playback or when paused (prevents resets)
    // Double-guard: check before AND after debounce to catch race conditions
    if (animationPlaying || animationActive) {
      console.log(`handleMapMoveEnd: SKIPPED (playing=${animationPlaying}, active=${animationActive})`);
      return;
    }

    if (moveTimeout) clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      if (animationPlaying || animationActive) {
        console.log(`handleMapMoveEnd: SKIPPED after debounce (playing=${animationPlaying}, active=${animationActive})`);
        return;
      }

      // Check if we actually need to reload data
      if (!shouldReloadData()) {
        console.log('handleMapMoveEnd: SKIPPED (viewport still within loaded area)');
        // Still notify parent of location change
        if (onLocationChange && map) {
          const center = map.getCenter();
          onLocationChange({ lat: center.lat, lng: center.lng });
        }
        return;
      }

      console.log('handleMapMoveEnd: EXECUTING (animation not active)');
      if (animationEnabled) {
        // Reload animation frames for new viewport
        stopAnimation();
        loadAnimationFrames();
      } else {
        loadWeatherData();
      }
      if (windEnabled) {
        loadWindData();
      }

      // Notify parent of location change
      if (onLocationChange && map) {
        const center = map.getCenter();
        onLocationChange({ lat: center.lat, lng: center.lng });
      }
    }, 300);
  }
  
  function handleContainerResize(width: number, height: number) {
    // Skip if size hasn't meaningfully changed (threshold of 20px)
    if (Math.abs(width - lastContainerWidth) < 20 && Math.abs(height - lastContainerHeight) < 20) {
      return;
    }

    lastContainerWidth = width;
    lastContainerHeight = height;

    // Debounce the reload
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      // Check fresh state - skip if animation is playing or paused
      if (!map || animationPlaying || animationActive) {
        console.log(`handleContainerResize: SKIPPED (playing=${animationPlaying}, active=${animationActive})`);
        return;
      }

      // Reload weather data for new dimensions
      console.log(`Container resized to ${width}x${height}, reloading weather data`);
      if (animationEnabled) {
        loadAnimationFrames();
      } else {
        loadWeatherData();
      }
      if (windEnabled) {
        loadWindData();
      }
    }, 300);
  }

  // Keyboard event handler
  function handleKeyDown(event: KeyboardEvent) {
    // Ignore if user is typing in an input field
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    switch (event.key) {
      case '?':
        event.preventDefault();
        showHelpModal = !showHelpModal;
        break;
    }

    switch (event.key.toLowerCase()) {
      case 'w':
        handleWindToggle();
        break;
      case 'i':
        event.preventDefault();
        handleIsolineToggle();
        break;
      case 'u':
        event.preventDefault();
        mapLocked = !mapLocked;
        console.log(`U key pressed, mapLocked now: ${mapLocked}`);
        break;
      case 'r':
        event.preventDefault();
        handleInterpolationCycle();
        break;
      case 'c':
        event.preventDefault();
        collectionSelect?.focus();
        collectionSelect?.showPicker?.();
        break;
      case 'd':
        event.preventDefault();
        dataLayerSelect?.focus();
        dataLayerSelect?.showPicker?.();
        break;
      case 's':
        event.preventDefault();
        styleSelect?.focus();
        styleSelect?.showPicker?.();
        break;
      case 'm':
        event.preventDefault();
        toggleMarkerPlacement();
        break;
      case ' ':
        // Space: Toggle play/pause, or load animation if not loaded (only when map is locked)
        if (mapLocked) {
          event.preventDefault();
          if (hasAnimationFrames) {
            handleAnimationPlayPause();
          } else if (!animationLoading) {
            toggleAnimation();
          }
        }
        break;
      case 'arrowleft':
        // Left arrow: Previous frame (only when paused and map is locked)
        if (mapLocked && hasAnimationFrames && !animationPlaying) {
          event.preventDefault();
          handleAnimationStepBackward();
        }
        break;
      case 'arrowright':
        // Right arrow: Next frame (only when paused and map is locked)
        if (mapLocked && hasAnimationFrames && !animationPlaying) {
          event.preventDefault();
          handleAnimationStepForward();
        }
        break;
      case 'arrowup':
        // Up arrow: Increase speed (only when playing and map is locked)
        if (mapLocked && hasAnimationFrames && animationPlaying) {
          event.preventDefault();
          increaseSpeed();
        }
        break;
      case 'arrowdown':
        // Down arrow: Decrease speed (only when playing and map is locked)
        if (mapLocked && hasAnimationFrames && animationPlaying) {
          event.preventDefault();
          decreaseSpeed();
        }
        break;
    }
  }

  onMount(async () => {
    // Add keyboard listener (use capture phase to ensure we get it before MapLibre)
    if (!compact) {
      window.addEventListener('keydown', handleKeyDown, true);
    }

    // Load available collections (don't reload data yet since map isn't ready)
    try {
      collectionsLoading = true;
      collections = await fetchCollections();
      console.log(`Loaded ${collections.length} collections from ${getEdrBaseUrl()}:`, collections.map(c => c.id));
    } catch (err) {
      console.error('Failed to load collections:', err);
    } finally {
      collectionsLoading = false;
    }

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      error = "WebGL is not available.";
      loading = false;
      return;
    }

    map = new maplibregl.Map({
      container: mapContainer,
      style: BASEMAP_STYLE,
      center: initialCenter,
      zoom: initialZoom,
      minZoom: 3,
      maxZoom: 16,
      fadeDuration: 0,  // Disable symbol fade transitions (reduces label flickering)
      // Disable interactivity in compact mode
      interactive: !compact,
      dragPan: !compact,
      scrollZoom: !compact,
      boxZoom: !compact,
      dragRotate: !compact,
      keyboard: !compact,
      doubleClickZoom: !compact,
      touchZoomRotate: !compact,
    });

    // Only add navigation controls if not in compact mode
    if (!compact) {
      map.addControl(new maplibregl.NavigationControl(), "top-right");
    }

    map.on("style.load", async () => {
      await loadWeatherData();
      // Only listen for move events if not in compact mode
      if (!compact) {
        map!.on("moveend", handleMapMoveEnd);
      }
    });

    map.on("error", (e) => {
      console.error("MapLibre error:", e);
    });

    // Listen for clicks for marker placement
    map.on("click", handleMapClick);

    // Set up resize observer to reload data when container size changes
    const rect = mapContainer.getBoundingClientRect();
    lastContainerWidth = rect.width;
    lastContainerHeight = rect.height;
    
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          handleContainerResize(width, height);
        }
      }
    });
    resizeObserver.observe(mapContainer);
  });

  onDestroy(() => {
    // Remove keyboard listener (check for browser environment, must match capture phase)
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeyDown, true);
    }

    if (moveTimeout) clearTimeout(moveTimeout);
    if (resizeTimeout) clearTimeout(resizeTimeout);
    if (resizeObserver) resizeObserver.disconnect();

    // Clean up animation
    stopAnimation();
    cleanupAnimationSources();
    animationManager?.clear();
    animationManager = null;

    if (windLayer && map?.getLayer('wind-particles')) {
      try { map.removeLayer('wind-particles'); } catch (e) {}
    }
    windLayer = null;
    
    // Clean up vector contours and labels
    if (map?.getLayer(CONTOUR_LABELS_ID)) {
      try { map.removeLayer(CONTOUR_LABELS_ID); } catch (e) {}
    }
    if (map?.getLayer(CONTOUR_LAYER_ID)) {
      try { map.removeLayer(CONTOUR_LAYER_ID); } catch (e) {}
    }
    if (map?.getSource(CONTOUR_SOURCE_ID)) {
      try { map.removeSource(CONTOUR_SOURCE_ID); } catch (e) {}
    }

    // Clean up markers
    for (const marker of markers) {
      marker.maplibreMarker?.remove();
    }
    markers = [];

    if (map) {
      map.remove();
      map = null;
    }
  });

  function handleScaleChange(scaleName: ColorScaleName) {
    selectedScale = scaleName;

    // If animation is active, invalidate cache and recreate sources
    if (animationEnabled && animationManager?.hasFrames()) {
      animationManager.clearRenderedCache();
      preRenderAnimationFrames();
      createAnimationSources();  // Recreate sources with new colors
      lastRenderedFrameIndex = -1;  // Force re-render
      renderAnimationFrame();
    } else {
      updateWeatherLayer();
    }
  }

  /**
   * Handle real-time preview of scale changes (only updates current frame display)
   */
  function handleScalePreview(newScale: ColorScale) {
    // Store the custom scale temporarily for preview
    const newCustomScales = new Map(customScales);
    newCustomScales.set(selectedScale, newScale);
    customScales = newCustomScales;

    // Only update the current frame display (don't re-render all animation frames)
    updateWeatherLayer();
  }

  /**
   * Handle final scale changes from the color legend editor (applies to all frames)
   */
  function handleCustomScaleChange(newScale: ColorScale) {
    // Store the custom scale for the current selected scale
    const newCustomScales = new Map(customScales);
    newCustomScales.set(selectedScale, newScale);
    customScales = newCustomScales;

    // Update the visualization - clear animation cache and re-render all frames
    if (animationEnabled && animationManager?.hasFrames()) {
      animationManager.clearRenderedCache();
      preRenderAnimationFrames();
      createAnimationSources();
      lastRenderedFrameIndex = -1;
      renderAnimationFrame();
    } else {
      updateWeatherLayer();
    }
  }

  function handleDataLayerChange(layer: DataLayerType) {
    if (layer === dataLayer) return;
    dataLayer = layer;
    // Update color scale to the default for this layer
    selectedScale = DATA_LAYERS[layer].defaultScale;
    // Update frame count to layer default
    animationFrameCount = DATA_LAYERS[layer].animation.defaultFrameCount;

    // Reload data (or animation if enabled)
    if (animationEnabled) {
      stopAnimation();
      loadAnimationFrames();
    } else {
      loadWeatherData();
    }
  }

  function handleCollectionChange(collectionId: string) {
    if (collectionId === selectedCollection) return;
    selectedCollection = collectionId;

    // Reset selected parameter to first available in new collection
    const collection = collections.find(c => c.id === collectionId);
    if (collection && collection.parameters.length > 0) {
      selectedParameter = collection.parameters[0];
    }

    // Set vertical level if collection has vertical extent
    if (collection?.verticalExtent?.values.length) {
      // Try to select 850 hPa as a sensible default, or the first level
      const levels = collection.verticalExtent.values;
      const default850 = levels.find(v => v === 850);
      selectedVerticalLevel = default850 ?? levels[0];
    } else {
      selectedVerticalLevel = null;
    }

    // Reset bbox tracking to force reload
    lastLoadedBbox = null;

    // Reload data with new collection/parameter
    if (animationEnabled) {
      stopAnimation();
      loadAnimationFrames();
    } else {
      loadWeatherData();
    }
  }

  /**
   * Load available collections from the EDR endpoint
   */
  async function loadCollections() {
    try {
      collectionsLoading = true;
      collections = await fetchCollections();
      console.log(`Loaded ${collections.length} collections from ${getEdrBaseUrl()}:`, collections.map(c => c.id));

      // Reset selection if current collection is not available
      if (collections.length > 0 && !collections.find(c => c.id === selectedCollection)) {
        selectedCollection = collections[0].id;
        if (collections[0].parameters.length > 0) {
          selectedParameter = collections[0].parameters[0];
        }
      }

      // Reload weather data with new endpoint
      if (map) {
        lastLoadedBbox = null;
        if (animationEnabled) {
          stopAnimation();
          loadAnimationFrames();
        } else {
          loadWeatherData();
        }
      }
    } catch (err) {
      console.error('Failed to load collections:', err);
    } finally {
      collectionsLoading = false;
    }
  }

  /**
   * Handle EDR config change - applies all settings and reloads
   */
  function handleEdrEndpointChange() {
    const trimmed = edrEndpoint.trim();
    if (trimmed) {
      setEdrBaseUrl(trimmed);
      setEdrApiKey(edrApiKey || null);
      setEdrDepth(edrDepthEnabled ? edrDepthValue : null);
      // Reload collections from the new endpoint
      loadCollections();
    }
  }

  /**
   * Reset EDR config to defaults
   */
  function resetEdrConfig() {
    edrEndpoint = getDefaultEdrUrl();
    edrApiKey = '';
    edrDepthEnabled = true;
    edrDepthValue = getDefaultDepth();
    setEdrBaseUrl(edrEndpoint);
    setEdrApiKey(null);
    setEdrDepth(getDefaultDepth());
    loadCollections();
  }

  function handleParameterChange(parameter: string) {
    if (parameter === selectedParameter) return;
    selectedParameter = parameter;

    // Reset bbox tracking to force reload
    lastLoadedBbox = null;

    // Reload data with new parameter
    if (animationEnabled) {
      stopAnimation();
      loadAnimationFrames();
    } else {
      loadWeatherData();
    }
  }

  function handleVerticalLevelChange(level: number) {
    if (level === selectedVerticalLevel) return;
    selectedVerticalLevel = level;

    // Reset bbox tracking to force reload
    lastLoadedBbox = null;

    // Reload data with new vertical level
    if (animationEnabled) {
      stopAnimation();
      loadAnimationFrames();
    } else {
      loadWeatherData();
    }
  }

  function handleCRSChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    const newCRS = select.value as CRSOption;
    if (newCRS === selectedCRS) return;
    selectedCRS = newCRS;

    // Reload data with new CRS
    if (animationEnabled) {
      stopAnimation();
      loadAnimationFrames();
    } else {
      loadWeatherData();
    }
  }

  function handleInterpolationCycle() {
    // Cycle through: smooth -> blur -> pixelated -> smooth
    const modes: InterpolationMode[] = ['smooth', 'blur', 'pixelated'];
    const currentIndex = modes.indexOf(interpolationMode);
    const prevMode = interpolationMode;
    interpolationMode = modes[(currentIndex + 1) % modes.length];

    // If animation is active, handle the mode change
    if (animationEnabled && animationManager?.hasFrames() && map) {
      // Check if we need full re-render (blur changes) or just resampling update
      const needsRerender = prevMode === 'blur' || interpolationMode === 'blur';

      if (needsRerender) {
        // Full re-render needed - do it asynchronously to avoid blocking UI
        const wasPlaying = animationPlaying;
        if (wasPlaying) stopAnimation();

        // Show loading state
        animationLoading = true;

        // Use setTimeout to let UI update before heavy work
        setTimeout(() => {
          animationManager!.clearRenderedCache();
          preRenderAnimationFrames();
          updateAllAnimationSources();
          lastRenderedFrameIndex = -1;
          renderAnimationFrame();
          animationLoading = false;

          if (wasPlaying) startAnimationPlayback();
        }, 10);
      } else {
        // Just update resampling property on all layers (fast)
        const resampling = interpolationMode === 'pixelated' ? 'nearest' : 'linear';
        for (const layerId of animationLayerIds) {
          if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'raster-resampling', resampling);
          }
        }
      }
    } else {
      // Re-render the weather layer with new mode
      updateWeatherLayer();
    }
  }

  async function loadWindData() {
    if (!map) return;
    
    const bounds = map.getBounds();
    const west = Math.max(-180, bounds.getWest());
    const south = Math.max(-85, bounds.getSouth());
    const east = Math.min(180, bounds.getEast());
    const north = Math.min(85, bounds.getNorth());
    
    console.log(`Fetching wind data for bbox: [${west.toFixed(2)}, ${south.toFixed(2)}, ${east.toFixed(2)}, ${north.toFixed(2)}]`);
    
    try {
      windData = await fetchWindData({
        width: 512,
        height: 256,
        bbox: { west, south, east, north },
        collection: 'gfs-height-agl',
      });
      
      if (windLayer) {
        windLayer.setWindData(windData);
      }
      
      console.log(`Wind data loaded for current viewport`);
    } catch (err) {
      console.error("Failed to load wind data:", err);
    }
  }

  async function handleWindToggle() {
    if (!map) {
      console.error("handleWindToggle: map not ready");
      return;
    }

    console.log("handleWindToggle called, windEnabled:", windEnabled);

    if (windEnabled) {
      windEnabled = false;
      if (windLayer && map.getLayer('wind-particles')) {
        map.removeLayer('wind-particles');
      }
      windLayer = null;
      windData = null;
      console.log("Wind disabled");
    } else {
      windLoading = true;
      console.log("Loading wind data...");

      try {
        // If animation is running, load wind frames for all timestamps
        if (animationEnabled && animationManager?.hasFrames()) {
          const timestamps = animationManager.getTimestamps();
          const bounds = map.getBounds();
          const west = Math.max(-180, bounds.getWest());
          const south = Math.max(-85, bounds.getSouth());
          const east = Math.min(180, bounds.getEast());
          const north = Math.min(85, bounds.getNorth());

          console.log(`Loading ${timestamps.length} wind frames for animation...`);

          await animationManager.loadWindFrames(
            timestamps,
            async (datetime: string) => {
              return await fetchWindData({
                width: 512,
                height: 256,
                bbox: { west, south, east, north },
                collection: 'gfs-height-agl',
                datetime,
              });
            }
          );

          // Get wind data for current animation position
          windData = animationManager.getWindDataAtPosition(animationPosition);
        } else {
          // Normal single-frame wind loading
          console.log("Calling loadWindData...");
          await loadWindData();
          console.log("loadWindData completed, windData:", windData ? "loaded" : "null");
        }

        if (windData) {
          console.log("Creating WindParticleLayer...");
          windLayer = new WindParticleLayer();
          windLayer.setWindData(windData);
          map.addLayer(windLayer);
          windEnabled = true;
          console.log("Wind layer added successfully");
        } else {
          console.error("Wind data is null after loading");
        }
      } catch (err) {
        console.error("Failed to load wind data:", err);
        error = `Failed to load wind data: ${err instanceof Error ? err.message : "Unknown error"}`;
      } finally {
        windLoading = false;
      }
    }
  }

  function handleRetry() {
    loadWeatherData();
  }
  
  function handleIsolineToggle() {
    if (!map) return;
    isolinesEnabled = !isolinesEnabled;
    
    // Toggle vector contour layer visibility
    if (map.getLayer(CONTOUR_LAYER_ID)) {
      map.setLayoutProperty(CONTOUR_LAYER_ID, 'visibility', isolinesEnabled ? 'visible' : 'none');
    } else if (isolinesEnabled && grayscaleData && currentTile) {
      updateIsolineLayer();
    }
    
    map.triggerRepaint();
    console.log("Isolines:", isolinesEnabled ? "enabled" : "disabled");
  }
  
  function updateIsolineInterval(event: Event) {
    isolineInterval = parseFloat((event.target as HTMLInputElement).value);
    // Regenerate contours with new interval
    if (isolinesEnabled && grayscaleData && currentTile) {
      updateIsolineLayer();
    }
  }
  
  function updateIsolineThickness(event: Event) {
    isolineThickness = parseFloat((event.target as HTMLInputElement).value);
    if (map?.getLayer(CONTOUR_LAYER_ID)) {
      map.setPaintProperty(CONTOUR_LAYER_ID, 'line-width', isolineThickness);
    }
  }
  
  function updateIsolineOpacity(event: Event) {
    isolineOpacity = parseFloat((event.target as HTMLInputElement).value);
    if (map?.getLayer(CONTOUR_LAYER_ID)) {
      map.setPaintProperty(CONTOUR_LAYER_ID, 'line-opacity', isolineOpacity);
    }
  }
  
  function updateIsolineColor(event: Event) {
    isolineColor = (event.target as HTMLInputElement).value;
    if (map?.getLayer(CONTOUR_LAYER_ID)) {
      map.setPaintProperty(CONTOUR_LAYER_ID, 'line-color', isolineColor);
    }
  }
  
  function handleContourResolutionChange(event: Event) {
    contourResolution = parseInt((event.target as HTMLSelectElement).value);
    // Regenerate contours with new resolution
    if (isolinesEnabled && grayscaleData && currentTile) {
      updateIsolineLayer();
    }
    console.log("Contour resolution:", contourResolution + "x downsample");
  }
  
  function handleContourSmoothingChange(event: Event) {
    contourSmoothing = parseInt((event.target as HTMLInputElement).value);
    // Regenerate contours with new smoothing
    if (isolinesEnabled && grayscaleData && currentTile) {
      updateIsolineLayer();
    }
    console.log("Contour smoothing:", contourSmoothing);
  }
  
  function handleContourLabelsToggle(event: Event) {
    contourLabelsEnabled = (event.target as HTMLInputElement).checked;
    if (map?.getLayer(CONTOUR_LABELS_ID)) {
      map.setLayoutProperty(CONTOUR_LABELS_ID, 'visibility', contourLabelsEnabled ? 'visible' : 'none');
    }
    console.log("Contour labels:", contourLabelsEnabled ? "enabled" : "disabled");
  }
  
  function handleContourLabelSizeChange(event: Event) {
    contourLabelSize = parseInt((event.target as HTMLInputElement).value);
    if (map?.getLayer(CONTOUR_LABELS_ID)) {
      map.setLayoutProperty(CONTOUR_LABELS_ID, 'text-size', contourLabelSize);
    }
  }
  
  // Helper to determine if weather/fill layer should be visible
  // Layer is visible if: stepped colors is enabled (for fill) OR gradient layer is enabled (for smooth gradient)
  function shouldShowWeatherLayer(): boolean {
    return steppedColorsEnabled || showGradientLayer;
  }
  
  // Update weather layer visibility based on current settings
  function updateWeatherLayerVisibility() {
    if (!map) return;
    const visibility = shouldShowWeatherLayer() ? 'visible' : 'none';
    
    // Toggle static weather layer
    if (map.getLayer('weather-layer')) {
      map.setLayoutProperty('weather-layer', 'visibility', visibility);
    }
    // Toggle all animation layers
    for (const layerId of animationLayerIds) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visibility);
      }
    }
  }
  
  function handleSteppedColorsToggle(event: Event) {
    steppedColorsEnabled = (event.target as HTMLInputElement).checked;
    // Re-render the weather layer with new color mode
    if (grayscaleData && currentTile) {
      updateWeatherLayer();
    }
    // Also re-render animation frames if in animation mode
    if (animationManager?.hasFrames()) {
      preRenderAnimationFrames();
      updateAllAnimationSources();
    }
    // Update visibility - stepped colors needs the layer to be visible for fill
    updateWeatherLayerVisibility();
    console.log("Stepped colors:", steppedColorsEnabled ? "enabled" : "disabled");
  }
  
  function handleGradientLayerToggle(event: Event) {
    showGradientLayer = (event.target as HTMLInputElement).checked;
    // Update visibility - respects stepped colors state
    updateWeatherLayerVisibility();
    console.log("Gradient layer:", showGradientLayer ? "visible" : "hidden");
  }
  
  function updateWindSpeed(event: Event) {
    windSpeedFactor = parseFloat((event.target as HTMLInputElement).value);
    windLayer?.setSpeedFactor(windSpeedFactor);
  }
  
  function updateWindFade(event: Event) {
    windFadeOpacity = parseFloat((event.target as HTMLInputElement).value);
    windLayer?.setFadeOpacity(windFadeOpacity);
  }
  
  function updateWindPointSize(event: Event) {
    windPointSize = parseFloat((event.target as HTMLInputElement).value);
    windLayer?.setPointSize(windPointSize);
  }
  
  function updateWindDropRate(event: Event) {
    windDropRate = parseFloat((event.target as HTMLInputElement).value);
    windLayer?.setDropRate(windDropRate);
  }
  
  function updateWindBrightness(event: Event) {
    windBrightness = parseFloat((event.target as HTMLInputElement).value);
    windLayer?.setBrightness(windBrightness);
  }
  
  async function updateWindParticleCount(event: Event) {
    const newCount = parseInt((event.target as HTMLInputElement).value, 10);
    if (newCount === windParticleCount || !map || !windEnabled) return;
    
    windParticleCount = newCount;
    
    // Particle count requires recreating the layer (buffers are sized at construction)
    if (windLayer && map.getLayer('wind-particles')) {
      map.removeLayer('wind-particles');
    }
    windLayer = null;
    
    // Create new layer with updated particle count
    if (windData) {
      windLayer = new WindParticleLayer({ numParticles: windParticleCount });
      windLayer.setWindData(windData);
      // Apply current settings to new layer
      windLayer.setSpeedFactor(windSpeedFactor);
      windLayer.setFadeOpacity(windFadeOpacity);
      windLayer.setPointSize(windPointSize);
      windLayer.setDropRate(windDropRate);
      windLayer.setBrightness(windBrightness);
      map.addLayer(windLayer);
    }
  }
  
  // ============================================================
  // ANIMATION FUNCTIONS
  // ============================================================

  // Store reprojected dimensions for animation sources
  let animationReprojectedWidth = 0;
  let animationReprojectedHeight = 0;

  /**
   * Pre-render interpolated animation frames to data URLs for efficient playback.
   * This pre-computes frames at regular intervals for smooth animation without
   * expensive canvas.toDataURL() calls during playback.
   * Frames are reprojected to Web Mercator for correct alignment on the map.
   */
  function preRenderAnimationFrames() {
    if (!animationManager?.hasFrames()) return;

    const resolution = animationManager.getCacheResolution();
    console.log(`Pre-rendering ${resolution + 1} interpolated animation frames with Mercator reprojection...`);

    // Pre-render at each cache position (0/resolution, 1/resolution, ..., resolution/resolution)
    for (let i = 0; i <= resolution; i++) {
      const position = i / resolution;

      // Get interpolated frame data at this position
      const frameData = animationManager.getFrameAtPosition(position);
      if (!frameData) continue;

      const sourceBbox = frameData.metadata.bbox as [number, number, number, number];

      // Reproject from CRS:84 to Web Mercator
      const reprojected = reprojectToMercator(
        frameData.grayscaleData,
        frameData.width,
        frameData.height,
        sourceBbox
      );

      // Store reprojected dimensions (should be same for all frames)
      if (i === 0) {
        animationReprojectedWidth = reprojected.width;
        animationReprojectedHeight = reprojected.height;
      }

      // Apply blur if needed
      let dataToColor = reprojected.data;
      if (interpolationMode === 'blur') {
        dataToColor = applyGaussianBlur(reprojected.data, reprojected.width, reprojected.height);
      }

      // Apply colormap and generate data URL
      const coloredDataUrl = applyColormapToImage(
        dataToColor,
        reprojected.width,
        reprojected.height,
        currentScale,  // Use currentScale which includes custom edits
        sourceBbox,
        frameData.metadata
      );

      // Cache the rendered URL at this position
      animationManager.cacheRenderedUrl(position, coloredDataUrl);
    }

    console.log(`Pre-rendered ${resolution + 1} interpolated animation frames (reprojected to ${animationReprojectedWidth}x${animationReprojectedHeight})`);
  }

  /**
   * Create map sources and layers for all pre-rendered animation frames.
   * This allows toggling visibility instead of updating URLs during playback.
   */
  function createAnimationSources() {
    if (!animationManager?.hasRenderedCache() || !map) return;

    // Clean up any existing animation sources first
    cleanupAnimationSources();

    const resolution = animationManager.getCacheResolution();
    console.log(`Creating ${resolution + 1} animation sources/layers...`);

    // Get coordinates from first frame - use server bbox directly
    const firstFrameData = animationManager.getFrameAtPosition(0);
    if (!firstFrameData) return;
    const [west, south, east, north] = firstFrameData.metadata.bbox as [number, number, number, number];
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ];

    // Determine resampling mode
    const resampling = interpolationMode === 'pixelated' ? 'nearest' : 'linear';

    // Hide the main weather layer during animation
    if (map.getLayer(WEATHER_LAYER_ID)) {
      map.setLayoutProperty(WEATHER_LAYER_ID, 'visibility', 'none');
    }

    // Create a source and layer for each cache position
    for (let i = 0; i <= resolution; i++) {
      const position = i / resolution;
      const url = animationManager.getRenderedUrl(position);
      if (!url) continue;

      const sourceId = `${ANIM_SOURCE_PREFIX}${i}`;
      const layerId = `${ANIM_LAYER_PREFIX}${i}`;

      // Add source
      map.addSource(sourceId, {
        type: 'image',
        url: url,
        coordinates: coordinates,
      });

      // Add layer (all hidden initially except first)
      map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        layout: {
          visibility: i === 0 ? 'visible' : 'none',
        },
        paint: {
          'raster-opacity': 0.75,
          'raster-fade-duration': 0,
          'raster-resampling': resampling,
        },
      });

      animationSourceIds.push(sourceId);
      animationLayerIds.push(layerId);
    }

    currentVisibleAnimLayer = 0;
    console.log(`Created ${animationSourceIds.length} animation sources/layers (layer 0 visible)`);
  }

  /**
   * Update all existing animation sources with new rendered URLs.
   * Called when frames finish loading to update interpolation quality.
   */
  function updateAllAnimationSources() {
    if (!animationManager?.hasRenderedCache() || !map) return;

    const resolution = animationManager.getCacheResolution();
    console.log(`Updating ${resolution + 1} animation sources with final renders...`);

    for (let i = 0; i <= resolution; i++) {
      const position = i / resolution;
      const url = animationManager.getRenderedUrl(position);
      if (!url) continue;

      const sourceId = `${ANIM_SOURCE_PREFIX}${i}`;
      const source = map.getSource(sourceId) as maplibregl.ImageSource | undefined;

      if (source) {
        // Use server bbox directly
        const firstFrameData = animationManager.getFrameAtPosition(0);
        if (firstFrameData) {
          const [west, south, east, north] = firstFrameData.metadata.bbox as [number, number, number, number];
          source.updateImage({
            url: url,
            coordinates: [
              [west, north],
              [east, north],
              [east, south],
              [west, south],
            ],
          });
        }
      }
    }

    console.log(`Updated animation sources with final renders`);
  }

  /**
   * Remove all animation sources and layers from the map.
   */
  function cleanupAnimationSources() {
    if (!map) return;

    // Remove layers first (must be done before sources)
    for (const layerId of animationLayerIds) {
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
    }

    // Remove sources
    for (const sourceId of animationSourceIds) {
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    }

    animationSourceIds = [];
    animationLayerIds = [];
    currentVisibleAnimLayer = -1;

    // Show the main weather layer again
    if (map.getLayer(WEATHER_LAYER_ID)) {
      map.setLayoutProperty(WEATHER_LAYER_ID, 'visibility', 'visible');
    }
  }

  async function toggleAnimation() {
    console.log(`toggleAnimation called: animationEnabled=${animationEnabled}`);
    if (animationEnabled) {
      stopAnimation();
      cleanupAnimationSources();
      animationEnabled = false;
      animationActive = false;
      // Reload single frame
      await loadWeatherData();
    } else {
      animationEnabled = true;
      await loadAnimationFrames();
    }
  }
  
  async function loadAnimationFrames() {
    if (!map) return;
    
    // CRITICAL: Don't reload animation frames if already loading or playing
    // This prevents the recursive cascade that causes thousands of requests
    if (animationLoading || animationPlaying) {
      console.log(`loadAnimationFrames: SKIPPED (loading=${animationLoading}, playing=${animationPlaying})`);
      return;
    }
    
    animationLoading = true;
    animationLoadProgress = null;
    error = null;
    
    try {
      // Get animation config from DATA_LAYERS if available, otherwise use defaults
      const layerConfig = Object.values(DATA_LAYERS).find(
        c => c.collection === selectedCollection && c.parameter === selectedParameter
      );
      const skipFactor = layerConfig?.animation.skipFactor ?? 1;
      const animationMode = layerConfig?.animation.mode ?? 'recent';

      // Fetch collection metadata to get available timestamps
      const animMeta = await fetchCollectionMetadata(selectedCollection);
      collectionMeta = animMeta;  // Update shared state for UI display

      // Select timestamps based on config
      console.log(`Available timestamps: ${animMeta.availableTimestamps.length}, frameCount: ${animationFrameCount}, mode: ${animationMode}`);
      const timestamps = selectAnimationTimestamps(
        animMeta,
        animationFrameCount,
        skipFactor,
        animationMode
      );
      animationFrameTimestamps = timestamps;  // Store for UI display

      if (timestamps.length === 0) {
        throw new Error('No timestamps available for animation');
      }

      console.log(`Loading ${timestamps.length} animation frames for ${selectedParameter} from ${selectedCollection}: ${timestamps[0]} to ${timestamps[timestamps.length - 1]}`);
      
      // Create animation manager if needed
      if (!animationManager) {
        animationManager = new AnimationManager();
      } else {
        animationManager.clear();
      }
      
      // Get current map bounds for fetching
      const bounds = map.getBounds();
      const west = Math.max(-180, bounds.getWest());
      const south = Math.max(-85, bounds.getSouth());
      const east = Math.min(180, bounds.getEast());
      const north = Math.min(85, bounds.getNorth());
      
      // Track whether we've started playback during progressive load
      let playbackStarted = false;

      // Fetch function for loading individual frames
      // Omit width/height to get native grid resolution from server
      const fetchFrame = async (datetime: string) => {
        const tile = await fetchDataTile({
          parameter: selectedParameter,
          collection: selectedCollection,
          // width/height omitted - server returns native grid resolution
          bbox: { west, south, east, north },
          datetime,
          z: selectedVerticalLevel ?? undefined,
          crs: selectedCRS,
        });

        // Extract grayscale data from image
        const canvas = document.createElement('canvas');
        canvas.width = tile.image.width;
        canvas.height = tile.image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(tile.image, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        return {
          grayscaleData: new Uint8ClampedArray(imgData.data),
          metadata: tile.metadata,
          width: tile.image.width,
          height: tile.image.height,
        };
      };

      // Progressive loading callbacks
      const progressiveCallbacks: ProgressiveLoadCallbacks = {
        onFrameLoaded: (progress, canStartPlayback) => {
          animationLoadProgress = progress;

          // Start playback as soon as we have minimum frames
          if (canStartPlayback && !playbackStarted && !animationActive) {
            playbackStarted = true;
            animationLoadingMore = true;  // Still loading more frames

            console.log(`Starting playback with ${progress.loaded}/${progress.total} frames loaded`);

            // Initialize with available frames
            const firstFrame = animationManager!.getFrameAtPosition(0);
            if (firstFrame) {
              imageWidth = firstFrame.width;
              imageHeight = firstFrame.height;
              currentTile = {
                image: new Image(),
                metadata: firstFrame.metadata
              };
            }

            // Pre-render and create sources with current frames
            preRenderAnimationFrames();
            createAnimationSources();
            lastRenderedFrameIndex = -1;

            // Start playback
            animationActive = true;
            animationPosition = 0;
            startAnimationPlayback();
          }
        },

        onAllLoaded: () => {
          console.log(`All ${animationManager!.getFrameCount()} frames loaded`);
          animationLoadingMore = false;

          // Re-render with all frames for smoother interpolation
          animationManager!.clearRenderedCache();
          preRenderAnimationFrames();

          // Update all sources with fully-rendered frames
          updateAllAnimationSources();
        }
      };

      // Load frames progressively (min 2 frames before playback starts)
      await animationManager.loadFramesProgressive(
        timestamps,
        fetchFrame,
        progressiveCallbacks,
        2,  // minFramesForPlayback
        4   // concurrency
      );

      // Store dimensions if not already set (edge case: very fast load)
      if (!currentTile) {
        const firstFrame = animationManager.getFrameAtPosition(0);
        if (firstFrame) {
          imageWidth = firstFrame.width;
          imageHeight = firstFrame.height;
          currentTile = {
            image: new Image(),
            metadata: firstFrame.metadata
          };
        }
      }

      // Load wind frames if wind is enabled (after all weather frames loaded)
      if (windEnabled) {
        console.log(`Loading ${timestamps.length} wind animation frames...`);
        await animationManager.loadWindFrames(
          timestamps,
          async (datetime: string) => {
            return await fetchWindData({
              width: 512,
              height: 256,
              bbox: { west, south, east, north },
              collection: 'gfs-height-agl',  // Wind always from GFS
              datetime,
            });
          },
          (progress) => {
            // Update progress to show wind loading
            animationLoadProgress = {
              ...progress,
              currentTimestamp: `Wind: ${progress.currentTimestamp}`
            };
          }
        );

        // Set initial wind data
        const initialWind = animationManager.getWindDataAtPosition(0);
        if (initialWind && windLayer) {
          windLayer.setWindData(initialWind);
        }

        console.log(`Wind animation loaded: ${animationManager.hasWindFrames() ? 'yes' : 'no'}`);
      }

      // Handle edge case: very fast load where playback didn't start in callback
      if (!animationActive) {
        animationActive = true;
        animationPosition = 0;

        // Ensure sources are created
        if (!animationManager.hasRenderedCache()) {
          preRenderAnimationFrames();
          createAnimationSources();
          lastRenderedFrameIndex = -1;
        }

        startAnimationPlayback();
      }

      // Update marker values with new animation data
      if (markers.length > 0) {
        updateMarkerValues();
      }

    } catch (err) {
      error = `Failed to load animation: ${err instanceof Error ? err.message : 'Unknown error'}`;
      console.error('Animation load error:', err);
      animationEnabled = false;
      animationActive = false;
    } finally {
      animationLoading = false;
      animationLoadProgress = null;
    }
  }
  
  function startAnimationPlayback() {
    if (animationPlaying) return;

    // If at the end and loop is disabled, restart from beginning
    if (animationPosition >= 1 && !animationLoop) {
      animationPosition = 0;
    }

    animationPlaying = true;
    lastAnimationTime = performance.now();
    
    // Reset isoline frame tracking to ensure isolines update on first frame
    lastIsolineFrameIndex = -1;

    // Detach moveend listener during animation to prevent request storm
    if (!compact && map) {
      map.off("moveend", handleMapMoveEnd);
      console.log('Detached moveend listener for animation playback');
    }

    animationFrameId = requestAnimationFrame(animationTick);
  }
  
  function stopAnimation() {
    animationPlaying = false;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    // Ensure current frame stays visible after stopping
    console.log(`stopAnimation: position=${animationPosition.toFixed(3)}, lastRendered=${lastRenderedFrameIndex}`);
    renderAnimationFrame();
  }
  
  function animationTick(timestamp: number) {
    if (!animationPlaying || !animationManager?.hasFrames()) return;
    
    const delta = timestamp - lastAnimationTime;
    lastAnimationTime = timestamp;
    
    // Advance position based on speed
    const loopDuration = BASE_LOOP_DURATION / animationSpeed;
    animationPosition += delta / loopDuration;
    
    // Handle end of animation
    if (animationPosition >= 1) {
      if (animationLoop) {
        animationPosition = animationPosition % 1;
      } else {
        animationPosition = 1;
        stopAnimation();
        return;
      }
    }
    
    // Render interpolated frame
    renderAnimationFrame();
    
    // Request next frame
    animationFrameId = requestAnimationFrame(animationTick);
  }
  
  function renderAnimationFrame() {
    if (!animationManager?.hasFrames() || !map) return;

    // Update the displayed timestamp for current position
    const frameData = animationManager.getFrameAtPosition(animationPosition);
    animationTimestamp = frameData?.datetime ?? null;

    // Get the cache key for the current position (this is the layer index)
    const currentCacheKey = animationManager.getCacheKey(animationPosition);

    // Skip layer update if we're still on the same frame (avoids redundant work)
    if (currentCacheKey === lastRenderedFrameIndex) {
      return;
    }

    // Toggle layer visibility instead of updating URLs
    // Hide the previous layer
    if (currentVisibleAnimLayer >= 0 && currentVisibleAnimLayer < animationLayerIds.length) {
      const prevLayerId = animationLayerIds[currentVisibleAnimLayer];
      if (map.getLayer(prevLayerId)) {
        map.setLayoutProperty(prevLayerId, 'visibility', 'none');
      }
    }

    // Show the current layer
    if (currentCacheKey >= 0 && currentCacheKey < animationLayerIds.length) {
      const currentLayerId = animationLayerIds[currentCacheKey];
      if (map.getLayer(currentLayerId)) {
        map.setLayoutProperty(currentLayerId, 'visibility', 'visible');
      }
    }

    // Update tracking
    currentVisibleAnimLayer = currentCacheKey;
    lastRenderedFrameIndex = currentCacheKey;

    // Update wind data if wind is enabled and we have wind frames
    if (windEnabled && windLayer && animationManager?.hasWindFrames()) {
      const windDataForFrame = animationManager.getWindDataAtPosition(animationPosition);
      if (windDataForFrame) {
        windLayer.setWindData(windDataForFrame);
      }
    }
    
    // Update isoline layer with data from current animation frame
    // Uses ORIGINAL (non-reprojected) data - MapLibre handles projection for vector layers
    if (isolinesEnabled && animationManager && currentCacheKey !== lastIsolineFrameIndex) {
      const frameData = animationManager.getFrameAtPosition(animationPosition);
      if (frameData) {
        // Update vector contours for this animation frame
        // Temporarily set currentTile metadata for the contour extraction
        const savedTile = currentTile;
        currentTile = { ...currentTile!, metadata: frameData.metadata };
        // Use original non-reprojected data
        updateVectorContours(frameData.grayscaleData, frameData.width, frameData.height);
        currentTile = savedTile;
        
        lastIsolineFrameIndex = currentCacheKey;
      }
    }

    // Update marker values with new frame data
    if (markers.length > 0) {
      updateMarkerValues();
    }
  }
  
  function handleAnimationPlayPause() {
    console.log(`handleAnimationPlayPause: playing=${animationPlaying}, hasFrames=${hasAnimationFrames}`);
    if (animationPlaying) {
      stopAnimation();
    } else {
      startAnimationPlayback();
    }
  }
  
  function handleAnimationStepBackward() {
    if (!animationManager?.hasFrames()) return;
    stopAnimation();

    const frameCount = animationManager.getFrameCount();
    // Snap to exact frame positions (no interpolation)
    const currentFrame = animationManager.getFrameIndexAtPosition(animationPosition);
    const newFrame = Math.max(0, currentFrame - 1);
    animationPosition = frameCount > 1 ? newFrame / (frameCount - 1) : 0;
    renderAnimationFrame();
  }

  function handleAnimationStepForward() {
    if (!animationManager?.hasFrames()) return;
    stopAnimation();

    const frameCount = animationManager.getFrameCount();
    // Snap to exact frame positions (no interpolation)
    const currentFrame = animationManager.getFrameIndexAtPosition(animationPosition);
    const newFrame = Math.min(frameCount - 1, currentFrame + 1);
    animationPosition = frameCount > 1 ? newFrame / (frameCount - 1) : 0;
    renderAnimationFrame();
  }
  
  function handleAnimationScrub(event: Event) {
    const value = parseFloat((event.target as HTMLInputElement).value);
    animationPosition = value;
    if (!animationPlaying) {
      renderAnimationFrame();
    }
  }
  
  function handleAnimationSpeedChange(event: Event) {
    animationSpeed = parseFloat((event.target as HTMLSelectElement).value);
  }

  // Available speed options (must match select options)
  const SPEED_OPTIONS = [0.5, 1, 2, 3];

  function increaseSpeed() {
    const currentIndex = SPEED_OPTIONS.indexOf(animationSpeed);
    if (currentIndex < SPEED_OPTIONS.length - 1) {
      animationSpeed = SPEED_OPTIONS[currentIndex + 1];
    }
  }

  function decreaseSpeed() {
    const currentIndex = SPEED_OPTIONS.indexOf(animationSpeed);
    if (currentIndex > 0) {
      animationSpeed = SPEED_OPTIONS[currentIndex - 1];
    }
  }
  
  function handleAnimationFrameCountChange(event: Event) {
    const newCount = parseInt((event.target as HTMLSelectElement).value, 10);
    if (newCount !== animationFrameCount) {
      animationFrameCount = newCount;
      // Reload animation with new frame count
      if (animationEnabled) {
        stopAnimation();
        loadAnimationFrames();
      }
    }
  }
  
  function formatTimestamp(isoString: string | null): string {
    if (!isoString) return '-- --- --:--';
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('en-US', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });
    } catch {
      return '-- --- --:--';
    }
  }

  /** Format a date compactly for extent display: "Feb 06 12Z" */
  function formatDateCompact(isoString: string): string {
    try {
      const date = new Date(isoString);
      const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      const day = String(date.getUTCDate()).padStart(2, '0');
      const hour = String(date.getUTCHours()).padStart(2, '0');
      return `${month} ${day} ${hour}Z`;
    } catch {
      return isoString;
    }
  }

  /** Format a model run time: "06Z Feb 06" */
  function formatRunTime(isoString: string): string {
    try {
      const date = new Date(isoString);
      const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      const day = String(date.getUTCDate()).padStart(2, '0');
      const hour = String(date.getUTCHours()).padStart(2, '0');
      return `${hour}Z ${month} ${day}`;
    } catch {
      return isoString;
    }
  }

  // ============================================================
  // MARKER FUNCTIONS
  // ============================================================

  /**
   * Sample the data value at a given lat/lng from the current grayscale data
   */
  function sampleDataAtLocation(
    lng: number,
    lat: number,
    data: Uint8ClampedArray | null,
    metadata: TileMetadata | null,
    width: number,
    height: number
  ): number | null {
    if (!data || !metadata || width === 0 || height === 0) return null;

    const [west, south, east, north] = metadata.bbox;

    // Check if point is within bounds
    if (lng < west || lng > east || lat < south || lat > north) {
      console.log(`Sample out of bounds: (${lng.toFixed(4)}, ${lat.toFixed(4)}) not in [${west.toFixed(4)}, ${south.toFixed(4)}, ${east.toFixed(4)}, ${north.toFixed(4)}]`);
      return null;
    }

    let xNorm: number;
    let yNorm: number;

    if (isMercatorProjected) {
      // Data is in EPSG:3857 (Web Mercator) - need Mercator Y conversion
      // X is still linear
      xNorm = (lng - west) / (east - west);
      
      // Convert lat to Mercator Y, then normalize
      const latToMercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
      const mercYPoint = latToMercY(lat);
      const mercYNorth = latToMercY(north);
      const mercYSouth = latToMercY(south);
      yNorm = (mercYNorth - mercYPoint) / (mercYNorth - mercYSouth); // Flip Y since image is top-down
    } else {
      // Data is in CRS:84 (geographic) - linear mapping
      xNorm = (lng - west) / (east - west);
      yNorm = (north - lat) / (north - south); // Flip Y since image is top-down
    }

    const x = Math.floor(xNorm * width);
    const y = Math.floor(yNorm * height);

    // Clamp to valid range
    const clampedX = Math.max(0, Math.min(width - 1, x));
    const clampedY = Math.max(0, Math.min(height - 1, y));

    // Sample the grayscale value (R channel of RGBA)
    const idx = (clampedY * width + clampedX) * 4;
    const grayscaleValue = data[idx];

    // Convert to actual data value
    const dataValue = metadata.min + (grayscaleValue / 255) * (metadata.max - metadata.min);

    console.log(`Sample at (${lng.toFixed(4)}, ${lat.toFixed(4)}): pixel(${clampedX}, ${clampedY}), gray=${grayscaleValue}, value=${dataValue.toFixed(1)}, bbox=[${west.toFixed(2)},${south.toFixed(2)},${east.toFixed(2)},${north.toFixed(2)}], size=${width}x${height}, mercator=${isMercatorProjected}`);

    return dataValue;
  }

  /**
   * Get the current grayscale data (either from animation or static)
   */
  function getCurrentFrameData(): { data: Uint8ClampedArray | null; metadata: TileMetadata | null; width: number; height: number } {
    if (animationActive && animationManager?.hasFrames()) {
      const frameData = animationManager.getFrameAtPosition(animationPosition);
      if (frameData) {
        return {
          data: frameData.grayscaleData,
          metadata: frameData.metadata,
          width: frameData.width,
          height: frameData.height,
        };
      }
    }

    // Fall back to static data
    return {
      data: grayscaleData,
      metadata: currentTile?.metadata ?? null,
      width: imageWidth,
      height: imageHeight,
    };
  }

  /**
   * Extract time series data at a location from all animation frames
   */
  function getTimeSeriesAtLocation(lng: number, lat: number): TimeSeriesPoint[] {
    if (!animationManager?.hasFrames()) return [];

    const timestamps = animationManager.getTimestamps();
    const points: TimeSeriesPoint[] = [];

    for (const timestamp of timestamps) {
      const frame = animationManager.getFrame(timestamp);
      if (frame) {
        const value = sampleDataAtLocation(
          lng, lat,
          frame.grayscaleData,
          frame.metadata,
          frame.width,
          frame.height
        );
        if (value !== null) {
          points.push({ timestamp, value });
        }
      }
    }

    return points;
  }

  /**
   * Generate a simple SVG sparkline chart with optional second dataset overlay
   * @param framePoints - Data sampled from animation frames (shown in white)
   * @param positionPoints - Data from position API (shown in cyan), can be null
   * @param currentTimestamp - Current display timestamp for indicator dot
   * @param width - Chart width in pixels
   * @param height - Chart height in pixels
   * @param units - Units for value formatting
   */
  function generateSparklineSVG(
    framePoints: TimeSeriesPoint[],
    positionPoints: TimeSeriesPoint[] | null,
    currentTimestamp: string | null,
    width: number = 160,
    height: number = 40,
    units: string | undefined
  ): string {
    if (framePoints.length < 2) return '';

    // Combine all values to determine shared scale
    const frameValues = framePoints.map(p => p.value);
    const positionValues = positionPoints?.map(p => p.value) ?? [];
    const allValues = [...frameValues, ...positionValues];
    const minVal = Math.min(...allValues);
    const maxVal = Math.max(...allValues);
    const range = maxVal - minVal || 1;

    // Padding for the chart
    const padX = 2;
    const padY = 4;
    const chartWidth = width - padX * 2;
    const chartHeight = height - padY * 2;

    // Helper to calculate Y position for a value
    const valueToY = (value: number) => padY + chartHeight - ((value - minVal) / range) * chartHeight;

    // Get time range from frame points for X positioning
    const firstTime = new Date(framePoints[0].timestamp).getTime();
    const lastTime = new Date(framePoints[framePoints.length - 1].timestamp).getTime();
    const timeRange = lastTime - firstTime || 1;

    // Helper to calculate X position for a timestamp
    const timeToX = (timestamp: string) => {
      const t = new Date(timestamp).getTime();
      return padX + ((t - firstTime) / timeRange) * chartWidth;
    };

    // Generate path for frame data (white line)
    const framePathPoints = framePoints.map((p, i) => {
      const x = timeToX(p.timestamp);
      const y = valueToY(p.value);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');

    // Generate path for position data (cyan line) if available
    let positionPath = '';
    if (positionPoints && positionPoints.length >= 2) {
      positionPath = positionPoints.map((p, i) => {
        const x = timeToX(p.timestamp);
        const y = valueToY(p.value);
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
    }

    // Find current position on the timeline (using frame points for the indicator)
    let currentX: number | null = null;
    let currentFrameY: number | null = null;
    let currentPositionY: number | null = null;

    if (currentTimestamp) {
      const currentTime = new Date(currentTimestamp).getTime();

      // Calculate X position based on time
      if (currentTime >= firstTime && currentTime <= lastTime) {
        currentX = timeToX(currentTimestamp);
      } else if (currentTime < firstTime) {
        currentX = padX;
      } else {
        currentX = padX + chartWidth;
      }

      // Find interpolated Y for frame data
      for (let i = 0; i < framePoints.length - 1; i++) {
        const t1 = new Date(framePoints[i].timestamp).getTime();
        const t2 = new Date(framePoints[i + 1].timestamp).getTime();
        if (currentTime >= t1 && currentTime <= t2) {
          const progress = (currentTime - t1) / (t2 - t1);
          const interpolatedValue = framePoints[i].value + (framePoints[i + 1].value - framePoints[i].value) * progress;
          currentFrameY = valueToY(interpolatedValue);
          break;
        }
      }
      // Handle edge cases for frame data
      if (currentFrameY === null && framePoints.length > 0) {
        if (currentTime <= firstTime) {
          currentFrameY = valueToY(framePoints[0].value);
        } else if (currentTime >= lastTime) {
          currentFrameY = valueToY(framePoints[framePoints.length - 1].value);
        }
      }

      // Find interpolated Y for position data if available
      if (positionPoints && positionPoints.length >= 2) {
        for (let i = 0; i < positionPoints.length - 1; i++) {
          const t1 = new Date(positionPoints[i].timestamp).getTime();
          const t2 = new Date(positionPoints[i + 1].timestamp).getTime();
          if (currentTime >= t1 && currentTime <= t2) {
            const progress = (currentTime - t1) / (t2 - t1);
            const interpolatedValue = positionPoints[i].value + (positionPoints[i + 1].value - positionPoints[i].value) * progress;
            currentPositionY = valueToY(interpolatedValue);
            break;
          }
        }
        // Handle edge cases for position data
        if (currentPositionY === null) {
          const posFirstTime = new Date(positionPoints[0].timestamp).getTime();
          const posLastTime = new Date(positionPoints[positionPoints.length - 1].timestamp).getTime();
          if (currentTime <= posFirstTime) {
            currentPositionY = valueToY(positionPoints[0].value);
          } else if (currentTime >= posLastTime) {
            currentPositionY = valueToY(positionPoints[positionPoints.length - 1].value);
          }
        }
      }
    }

    // Format min/max labels
    const formatVal = (v: number) => {
      if (units === 'K' && (dataLayer === 'temperature' || dataLayer === 'dewpoint')) {
        if (temperatureUnit === 'F') {
          return `${((v - 273.15) * 9/5 + 32).toFixed(0)}°`;
        } else {
          return `${(v - 273.15).toFixed(0)}°`;
        }
      }
      if (units === '%') return `${v.toFixed(0)}%`;
      if (units === 'dBZ') return `${v.toFixed(0)}`;
      return v.toFixed(0);
    };

    // Current position indicators - frame dot in white, position dot in cyan
    const frameDot = currentX !== null && currentFrameY !== null
      ? `<circle cx="${currentX.toFixed(1)}" cy="${currentFrameY.toFixed(1)}" r="3" fill="rgba(255,255,255,0.8)" stroke="white" stroke-width="1"/>`
      : '';
    const positionDot = currentX !== null && currentPositionY !== null
      ? `<circle cx="${currentX.toFixed(1)}" cy="${currentPositionY.toFixed(1)}" r="3" fill="rgb(78, 179, 211)" stroke="white" stroke-width="1"/>`
      : '';

    // Position path element (rendered behind frame path)
    const positionPathEl = positionPath
      ? `<path d="${positionPath}" fill="none" stroke="rgb(78, 179, 211)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>`
      : '';

    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="marker-chart">
        ${positionPathEl}
        <path d="${framePathPoints}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${positionDot}
        ${frameDot}
        <text x="${padX}" y="${height - 1}" font-size="8" fill="rgba(255,255,255,0.5)" font-family="monospace">${formatVal(minVal)}</text>
        <text x="${width - padX}" y="${padY + 6}" font-size="8" fill="rgba(255,255,255,0.5)" font-family="monospace" text-anchor="end">${formatVal(maxVal)}</text>
      </svg>
    `;
  }

  /**
   * Update all marker values based on current frame data
   */
  function updateMarkerValues() {
    const { data, metadata, width, height } = getCurrentFrameData();

    for (const marker of markers) {
      // Update frame-sampled value
      marker.value = sampleDataAtLocation(marker.lng, marker.lat, data, metadata, width, height);

      // Update position value if position data is available
      if (marker.positionData && marker.positionData.length > 0 && displayTimestamp) {
        marker.positionValue = interpolateValueAtTimestamp(marker.positionData, displayTimestamp);
      }

      updateMarkerPopup(marker);
    }
  }

  /**
   * Format the data value with units for display
   */
  function formatDataValue(value: number | null, units: string | undefined): string {
    if (value === null) return '--';

    // Convert Kelvin to preferred unit for temperature
    if (units === 'K' && (dataLayer === 'temperature' || dataLayer === 'dewpoint')) {
      if (temperatureUnit === 'F') {
        const fahrenheit = (value - 273.15) * 9/5 + 32;
        return `${fahrenheit.toFixed(1)}°F`;
      } else {
        const celsius = value - 273.15;
        return `${celsius.toFixed(1)}°C`;
      }
    }

    // Handle percentage for humidity
    if (units === '%') {
      return `${value.toFixed(0)}%`;
    }

    // Handle dBZ for reflectivity
    if (units === 'dBZ') {
      return `${value.toFixed(0)} dBZ`;
    }

    return `${value.toFixed(1)} ${units || ''}`;
  }

  /**
   * Update a marker's popup content
   */
  function updateMarkerPopup(marker: MapMarker) {
    if (!marker.maplibreMarker) return;

    const popup = marker.maplibreMarker.getPopup();
    if (popup) {
      const units = currentTile?.metadata?.units;

      // Generate time series chart with both frame data and position data
      const frameData = getTimeSeriesAtLocation(marker.lng, marker.lat);
      const chartSvg = generateSparklineSVG(frameData, marker.positionData, displayTimestamp, 150, 36, units);

      // Format position value display
      let positionValueDisplay: string;
      if (marker.positionLoading) {
        positionValueDisplay = '<span class="loading-indicator">...</span>';
      } else if (marker.positionValue !== null) {
        positionValueDisplay = formatDataValue(marker.positionValue, units);
      } else {
        positionValueDisplay = '--';
      }

      popup.setHTML(`
        <div class="marker-popup">
          <button class="marker-popup__close" onclick="window.dispatchEvent(new CustomEvent('remove-marker', { detail: '${marker.id}' }))">&times;</button>
          <div class="marker-popup__coords">${marker.lat.toFixed(4)}, ${marker.lng.toFixed(4)}</div>
          <div class="marker-popup__value">
            <span class="value-label">Frame:</span> ${formatDataValue(marker.value, units)}
            <span class="position-value"><span class="value-label">API:</span> ${positionValueDisplay}</span>
          </div>
          ${chartSvg ? `<div class="marker-popup__chart">${chartSvg}</div>` : ''}
        </div>
      `);
    }
  }

  /**
   * Create a MapLibre marker at the given location
   */
  function createMapMarker(lng: number, lat: number): MapMarker {
    const id = `marker-${Date.now()}`;
    const { data, metadata, width, height } = getCurrentFrameData();
    const value = sampleDataAtLocation(lng, lat, data, metadata, width, height);

    const marker: MapMarker = {
      id,
      lng,
      lat,
      value,
      positionData: null,
      positionValue: null,
      positionLoading: true,
    };

    if (map) {
      const units = currentTile?.metadata?.units;

      // Generate time series chart if animation frames are available
      const timeSeriesData = getTimeSeriesAtLocation(lng, lat);
      const chartSvg = generateSparklineSVG(timeSeriesData, null, displayTimestamp, 150, 36, units);

      // Create popup
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 25,
        className: 'marker-popup-container'
      }).setHTML(`
        <div class="marker-popup">
          <button class="marker-popup__close" onclick="window.dispatchEvent(new CustomEvent('remove-marker', { detail: '${id}' }))">&times;</button>
          <div class="marker-popup__coords">${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
          <div class="marker-popup__value">
            <span class="value-label">Frame:</span> ${formatDataValue(value, units)}
            <span class="position-value"><span class="value-label">API:</span> <span class="loading-indicator">...</span></span>
          </div>
          ${chartSvg ? `<div class="marker-popup__chart">${chartSvg}</div>` : ''}
        </div>
      `);

      // Create marker element
      const el = document.createElement('div');
      el.className = 'map-marker';
      el.innerHTML = `
        <svg viewBox="0 0 24 24" width="32" height="32" fill="var(--color-accent)" stroke="white" stroke-width="1">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
        </svg>
      `;

      marker.maplibreMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);

      // Show popup by default
      marker.maplibreMarker.togglePopup();

      // Fetch position data asynchronously
      fetchPositionDataForMarker(marker);
    }

    return marker;
  }

  /**
   * Fetch position data for a marker and update it when complete
   */
  async function fetchPositionDataForMarker(marker: MapMarker): Promise<void> {
    console.log('[Position] fetchPositionDataForMarker called for marker:', marker.id);
    console.log('[Position] animationManager exists:', !!animationManager);
    console.log('[Position] animationManager.hasFrames():', animationManager?.hasFrames());
    console.log('[Position] staticTimestamp:', staticTimestamp);
    console.log('[Position] displayTimestamp:', displayTimestamp);

    // Get timestamps - either from animation frames or from static timestamp
    let timestamps: string[] = [];

    if (animationManager?.hasFrames()) {
      timestamps = animationManager.getTimestamps();
      console.log('[Position] Using animation timestamps:', timestamps.length, 'frames');
    } else if (displayTimestamp) {
      // Fall back to single static timestamp
      timestamps = [displayTimestamp];
      console.log('[Position] Using single static timestamp:', displayTimestamp);
    } else if (staticTimestamp) {
      timestamps = [staticTimestamp];
      console.log('[Position] Using staticTimestamp:', staticTimestamp);
    }

    if (timestamps.length === 0) {
      console.log('[Position] No timestamps available, skipping position fetch');
      marker.positionLoading = false;
      return;
    }

    console.log('[Position] Fetching position data for', selectedCollection, selectedParameter);
    console.log('[Position] Location:', marker.lng, marker.lat);
    console.log('[Position] Time range:', timestamps[0], 'to', timestamps[timestamps.length - 1]);

    try {
      const positionData = await fetchPositionTimeSeries(
        selectedCollection,
        selectedParameter,
        marker.lng,
        marker.lat,
        timestamps
      );
      console.log('[Position] Received position data:', positionData.length, 'points');

      // Update marker with position data
      marker.positionData = positionData;
      marker.positionLoading = false;

      // Calculate current position value
      if (positionData.length > 0 && displayTimestamp) {
        marker.positionValue = interpolateValueAtTimestamp(positionData, displayTimestamp);
      }

      // Refresh popup to show the new data
      updateMarkerPopup(marker);
    } catch (error) {
      console.error(`Error fetching position data for marker ${marker.id}:`, error);
      marker.positionLoading = false;
      marker.positionData = null;
      updateMarkerPopup(marker);
    }
  }

  /**
   * Interpolate a value at a specific timestamp from time series data
   */
  function interpolateValueAtTimestamp(
    data: TimeSeriesPoint[],
    targetTimestamp: string
  ): number | null {
    if (data.length === 0) return null;

    const targetTime = new Date(targetTimestamp).getTime();

    // Find the two points surrounding the target time
    let before: TimeSeriesPoint | null = null;
    let after: TimeSeriesPoint | null = null;

    for (let i = 0; i < data.length; i++) {
      const pointTime = new Date(data[i].timestamp).getTime();
      if (pointTime <= targetTime) {
        before = data[i];
      }
      if (pointTime >= targetTime && !after) {
        after = data[i];
        break;
      }
    }

    // If exact match or only one point available
    if (before && after && before.timestamp === after.timestamp) {
      return before.value;
    }

    // If target is before all data points
    if (!before && after) {
      return after.value;
    }

    // If target is after all data points
    if (before && !after) {
      return before.value;
    }

    // Interpolate between the two points
    if (before && after) {
      const beforeTime = new Date(before.timestamp).getTime();
      const afterTime = new Date(after.timestamp).getTime();
      const ratio = (targetTime - beforeTime) / (afterTime - beforeTime);
      return before.value + ratio * (after.value - before.value);
    }

    return null;
  }

  const MAX_MARKERS = 5;

  /**
   * Handle map click for marker placement
   */
  function handleMapClick(e: maplibregl.MapMouseEvent) {
    if (!markerPlacementMode) return;

    // Check marker limit
    if (markers.length >= MAX_MARKERS) {
      markerPlacementMode = false;
      return;
    }

    const { lng, lat } = e.lngLat;
    const marker = createMapMarker(lng, lat);
    markers = [...markers, marker];

    // Exit placement mode after placing marker
    markerPlacementMode = false;
  }

  /**
   * Remove a marker by ID
   */
  function removeMarker(id: string) {
    const marker = markers.find(m => m.id === id);
    if (marker?.maplibreMarker) {
      marker.maplibreMarker.remove();
    }
    markers = markers.filter(m => m.id !== id);
  }

  /**
   * Toggle marker placement mode
   */
  function toggleMarkerPlacement() {
    markerPlacementMode = !markerPlacementMode;
  }

  // Listen for marker removal events from popup buttons
  if (typeof window !== 'undefined') {
    window.addEventListener('remove-marker', ((e: CustomEvent) => {
      removeMarker(e.detail);
    }) as EventListener);
  }
</script>

<div class="map-view">
  <div class="map-view__container" bind:this={mapContainer}></div>

  {#if loading && !currentTile}
    <div class="map-view__overlay">
      <div class="map-view__spinner"></div>
      <p class="map-view__message">Loading weather data...</p>
    </div>
  {/if}

  {#if error}
    <div class="map-view__error-toast">
      <p class="map-view__error-text">{error}</p>
      <div class="map-view__error-actions">
        <button class="map-view__error-retry" onclick={handleRetry}>Retry</button>
        <button class="map-view__error-dismiss" onclick={() => error = null}>Dismiss</button>
      </div>
    </div>
  {/if}

  {#if currentTile && !loading && !error && !compact}
    <div class="map-view__legend map-view__legend--anim-active">
      <ColorLegend
        min={actualMin ?? currentTile.metadata.min}
        max={actualMax ?? currentTile.metadata.max}
        dataMin={currentTile.metadata.min}
        dataMax={currentTile.metadata.max}
        units={currentTile.metadata.units}
        scale={currentScale}
        preferredUnit={temperatureUnit}
        onScalePreview={handleScalePreview}
        onScaleChange={handleCustomScaleChange}
      />
    </div>
  {/if}

  {#if !compact}
  <div class="map-view__controls">
    <div class="map-view__edr-config">
      <button
        class="map-view__edr-toggle"
        onclick={() => showEdrConfig = !showEdrConfig}
        title="Configure EDR endpoint"
      >
        {showEdrConfig ? 'Hide' : 'EDR'}: {edrEndpoint.replace(/^https?:\/\//, '').split('/')[0]}
      </button>

      {#if showEdrConfig}
        <div class="map-view__edr-panel">
          <div class="map-view__edr-field">
            <label class="map-view__edr-label" for="edr-endpoint">Endpoint:</label>
            <input
              type="text"
              id="edr-endpoint"
              class="map-view__edr-input"
              bind:value={edrEndpoint}
              onkeydown={(e) => e.key === 'Enter' && handleEdrEndpointChange()}
              placeholder="https://example.com"
            />
          </div>
          <div class="map-view__edr-field">
            <label class="map-view__edr-label" for="edr-api-key">API Key:</label>
            <input
              type="password"
              id="edr-api-key"
              class="map-view__edr-input"
              bind:value={edrApiKey}
              onkeydown={(e) => e.key === 'Enter' && handleEdrEndpointChange()}
              placeholder="(optional)"
            />
          </div>
          <div class="map-view__edr-field map-view__edr-depth">
            <label class="map-view__edr-label">
              <input
                type="checkbox"
                bind:checked={edrDepthEnabled}
              />
              Depth:
            </label>
            <input
              type="text"
              class="map-view__edr-input map-view__edr-input--small"
              bind:value={edrDepthValue}
              disabled={!edrDepthEnabled}
              onkeydown={(e) => e.key === 'Enter' && handleEdrEndpointChange()}
              placeholder="8"
            />
          </div>
          <div class="map-view__edr-buttons">
            <button
              class="map-view__edr-apply"
              onclick={handleEdrEndpointChange}
              disabled={collectionsLoading}
            >
              {collectionsLoading ? 'Loading...' : 'Apply'}
            </button>
            <button class="map-view__edr-reset" onclick={resetEdrConfig}>Reset</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="map-view__collection-selector">
      <label class="map-view__collection-label" for="collection">Collection: <kbd>C</kbd></label>
      <select
        id="collection"
        class="map-view__collection-select"
        bind:this={collectionSelect}
        value={selectedCollection}
        onchange={(e) => handleCollectionChange(e.currentTarget.value)}
        disabled={collectionsLoading}
      >
        {#if collectionsLoading}
          <option value="">Loading...</option>
        {:else}
          {#each collections as collection}
            <option value={collection.id}>{collection.title}</option>
          {/each}
        {/if}
      </select>
    </div>

    <div class="map-view__layer-selector">
      <label class="map-view__layer-label" for="data-layer">Parameter: <kbd>D</kbd></label>
      <select
        id="data-layer"
        class="map-view__layer-select"
        bind:this={dataLayerSelect}
        value={selectedParameter}
        onchange={(e) => handleParameterChange(e.currentTarget.value)}
      >
        {#each currentCollectionParams as param}
          <option value={param}>{param}</option>
        {/each}
      </select>
    </div>

    <div class="map-view__scale-selector">
      <label class="map-view__scale-label" for="color-scale">Style: <kbd>S</kbd></label>
      <select
        id="color-scale"
        class="map-view__scale-select"
        bind:this={styleSelect}
        value={selectedScale}
        onchange={(e) => handleScaleChange(e.currentTarget.value as ColorScaleName)}
      >
        {#each Object.entries(COLOR_SCALE_LABELS) as [value, label]}
          <option {value}>{label}</option>
        {/each}
      </select>
    </div>

    <div class="map-view__crs-selector">
      <label class="map-view__crs-label" for="crs-select">CRS:</label>
      <select
        id="crs-select"
        class="map-view__crs-select"
        value={selectedCRS}
        onchange={handleCRSChange}
      >
        <option value="CRS:84">CRS:84</option>
        <option value="EPSG:4326">EPSG:4326</option>
        <option value="EPSG:3857">EPSG:3857</option>
      </select>
    </div>

    <div class="map-view__offset-selector">
      <label class="map-view__offset-label" for="offset-slider">Offset: {bboxOffsetPixels.toFixed(1)}px</label>
      <input
        type="range"
        id="offset-slider"
        class="map-view__offset-slider"
        min="-10"
        max="10"
        step="0.5"
        value={bboxOffsetPixels}
        oninput={(e) => {
          bboxOffsetPixels = parseFloat(e.currentTarget.value);
          if (!animationEnabled) updateWeatherLayer();
        }}
      />
    </div>

    <button
      class="map-view__toggle-btn"
      class:map-view__toggle-btn--active={interpolationMode !== 'pixelated'}
      onclick={handleInterpolationCycle}
      title="Cycle interpolation: Smooth → Blur → Pixelated"
    >
      <span>{interpolationMode === 'smooth' ? 'Smooth' : interpolationMode === 'blur' ? 'Blur' : 'Pixelated'} <kbd>R</kbd></span>
    </button>
    
    <button
      class="map-view__wind-toggle"
      class:map-view__wind-toggle--active={windEnabled}
      onclick={handleWindToggle}
      disabled={windLoading}
      title={windEnabled ? "Hide wind" : "Show wind"}
    >
      {#if windLoading}
        <span class="map-view__wind-spinner"></span>
      {:else}
        <svg class="map-view__wind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      {/if}
      <span>Wind <kbd>W</kbd></span>
    </button>
    
    {#if windEnabled}
      <button
        class="map-view__settings-toggle"
        onclick={() => showWindControls = !showWindControls}
      >
        Settings
      </button>
    {/if}

    <button
      class="map-view__isoline-toggle"
      class:map-view__isoline-toggle--active={isolinesEnabled}
      onclick={handleIsolineToggle}
      title={isolinesEnabled ? "Hide isolines" : "Show isolines"}
    >
      <svg class="map-view__isoline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 18c3-3 6-3 9 0s6 3 9 0" stroke-linecap="round"/>
        <path d="M3 12c3-3 6-3 9 0s6 3 9 0" stroke-linecap="round"/>
        <path d="M3 6c3-3 6-3 9 0s6 3 9 0" stroke-linecap="round"/>
      </svg>
      <span>Isolines <kbd>I</kbd></span>
    </button>
    
    {#if isolinesEnabled}
      <button
        class="map-view__settings-toggle"
        onclick={() => showIsolineControls = !showIsolineControls}
      >
        Contours
      </button>
    {/if}

    <button
      class="map-view__lock-toggle"
      class:map-view__lock-toggle--locked={mapLocked}
      onclick={() => mapLocked = !mapLocked}
      title={mapLocked ? "Unlock map (enable pan/zoom)" : "Lock map (disable pan/zoom)"}
    >
      {#if mapLocked}
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
          <path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>
        </svg>
      {/if}
      <span>{mapLocked ? 'Locked' : 'Unlocked'} <kbd>U</kbd></span>
    </button>

    <button
      class="map-view__marker-btn"
      class:map-view__marker-btn--active={markerPlacementMode}
      onclick={toggleMarkerPlacement}
      disabled={markers.length >= MAX_MARKERS && !markerPlacementMode}
      title={markers.length >= MAX_MARKERS ? `Max ${MAX_MARKERS} markers` : markerPlacementMode ? "Cancel marker placement" : "Place a marker"}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
      </svg>
      <span>{markerPlacementMode ? 'Click map...' : `Marker${markers.length > 0 ? ` (${markers.length}/${MAX_MARKERS})` : ''}`} <kbd>M</kbd></span>
    </button>

    <button
      class="map-view__help-btn"
      onclick={() => showHelpModal = true}
      title="Keyboard shortcuts"
    >
      <span>? </span>
    </button>
  </div>
  {/if}
  
  {#if !compact}
    {#if collectionMeta}
    <div class="map-view__temporal-extent">
      <div class="map-view__temporal-extent-content">
        {#if collectionMeta.latestRun}
          <span class="map-view__temporal-run" title="Latest model run">
            Run: {formatRunTime(collectionMeta.latestRun.runTime)}
          </span>
          <span class="map-view__temporal-sep">|</span>
          <span class="map-view__temporal-range" title="Valid time range for latest run">
            {formatDateCompact(collectionMeta.latestRun.validStart)} - {formatDateCompact(collectionMeta.latestRun.validEnd)}
          </span>
          <span class="map-view__temporal-sep">|</span>
          <span class="map-view__temporal-hours" title="Number of forecast hours available">
            {collectionMeta.latestRun.forecastHours.length} hrs loaded (F{collectionMeta.latestRun.forecastHours[0] ?? 0}-F{collectionMeta.latestRun.forecastHours[collectionMeta.latestRun.forecastHours.length - 1] ?? '?'})
          </span>
        {:else}
          <span class="map-view__temporal-range" title="Available time range">
            {formatDateCompact(collectionMeta.temporalExtent.start)} - {formatDateCompact(collectionMeta.temporalExtent.end)}
          </span>
        {/if}
        <span class="map-view__temporal-sep">|</span>
        <span class="map-view__temporal-count" title="Total available timestamps across all runs">
          {collectionMeta.availableTimestamps.length} total steps
        </span>
        {#if animationFrameTimestamps.length > 0}
          <span class="map-view__temporal-sep">|</span>
          <span class="map-view__temporal-frames" title="Loaded animation frame range">
            Frames: {formatDateCompact(animationFrameTimestamps[0])} - {formatDateCompact(animationFrameTimestamps[animationFrameTimestamps.length - 1])}
          </span>
        {/if}
      </div>
      {#if collectionMeta.runs && collectionMeta.runs.length > 1}
        <details class="map-view__temporal-runs-details">
          <summary class="map-view__temporal-runs-summary">{collectionMeta.runs.length} runs</summary>
          <div class="map-view__temporal-runs-list">
            {#each collectionMeta.runs as run}
              <div class="map-view__temporal-run-item" class:map-view__temporal-run-item--latest={run === collectionMeta.latestRun}>
                <span class="map-view__temporal-run-time">{formatRunTime(run.runTime)}</span>
                <span class="map-view__temporal-run-range">{formatDateCompact(run.validStart)} - {formatDateCompact(run.validEnd)}</span>
                <span class="map-view__temporal-run-fhrs">F{run.forecastHours[0] ?? 0}-F{run.forecastHours[run.forecastHours.length - 1] ?? '?'} ({run.forecastHours.length}h)</span>
              </div>
            {/each}
          </div>
        </details>
      {/if}
    </div>
    {/if}
    <div class="map-view__animation-bar" class:map-view__animation-bar--disabled={!mapLocked}>
      <div class="map-view__animation-controls">
        <button
          class="map-view__anim-btn"
          onclick={handleAnimationStepBackward}
          disabled={!hasAnimationFrames || !mapLocked}
          title={!mapLocked ? "Lock map to use playback" : "Previous frame"}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
          </svg>
        </button>

        <button
          class="map-view__anim-btn map-view__anim-btn--play"
          onclick={() => {
            console.log(`Play button clicked: hasFrames=${hasAnimationFrames}, playing=${animationPlaying}`);
            hasAnimationFrames ? handleAnimationPlayPause() : toggleAnimation();
          }}
          disabled={animationLoading || !mapLocked}
          title={!mapLocked ? "Lock map to use playback" : animationLoading ? "Loading..." : animationPlaying ? "Pause" : hasAnimationFrames ? "Play" : "Load Frames"}
        >
          {#if animationLoading}
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" class="map-view__anim-spinner">
              <path d="M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z"/>
            </svg>
          {:else if animationPlaying}
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M6 4h4v16H6zm8 0h4v16h-4z"/>
            </svg>
          {:else if hasAnimationFrames}
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M8 5v14l11-7z"/>
            </svg>
          {:else}
            <!-- Download icon when frames not loaded -->
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
          {/if}
        </button>

        <button
          class="map-view__anim-btn"
          onclick={handleAnimationStepForward}
          disabled={!hasAnimationFrames || !mapLocked}
          title={!mapLocked ? "Lock map to use playback" : "Next frame"}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z"/>
          </svg>
        </button>
      </div>
      
      <div class="map-view__animation-scrubber">
        <input
          type="range"
          min="0"
          max="1"
          step="0.001"
          value={animationPosition}
          oninput={handleAnimationScrub}
          disabled={!mapLocked}
          class="map-view__scrubber-input"
        />
      </div>
      
      <div class="map-view__animation-time">
        {formatTimestamp(displayTimestamp)}
      </div>
      
      <div class="map-view__animation-options">
        <select
          class="map-view__anim-select"
          value={String(animationSpeed)}
          onchange={handleAnimationSpeedChange}
          disabled={!mapLocked}
          title="Playback speed"
        >
          <option value="0.5">0.5x</option>
          <option value="1">1x</option>
          <option value="2">2x</option>
          <option value="3">3x</option>
        </select>

        <select
          class="map-view__anim-select"
          value={String(animationFrameCount)}
          onchange={handleAnimationFrameCountChange}
          disabled={!mapLocked}
          title="Number of frames"
        >
          <option value="6">6f</option>
          <option value="8">8f</option>
          <option value="10">10f</option>
          <option value="12">12f</option>
          <option value="24">24f</option>
          <option value="-1">all</option>
        </select>

        <button
          class="map-view__anim-btn map-view__anim-btn--loop"
          class:map-view__anim-btn--active={animationLoop}
          onclick={() => animationLoop = !animationLoop}
          disabled={!mapLocked}
          title={animationLoop ? "Loop enabled" : "Loop disabled"}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
          </svg>
        </button>
      </div>

      {#if (animationLoading || animationLoadingMore) && animationLoadProgress}
        <div class="map-view__load-progress">
          <div
            class="map-view__load-progress-bar"
            style="width: {(animationLoadProgress.loaded / animationLoadProgress.total) * 100}%"
          ></div>
          <span class="map-view__load-progress-text">
            {animationLoadProgress.loaded}/{animationLoadProgress.total}
          </span>
        </div>
      {/if}
    </div>
  {/if}
  
  
  {#if windEnabled && showWindControls && !compact}
    <div class="map-view__wind-settings">
      <div class="map-view__settings-header">
        <span>Wind Settings</span>
        <button class="map-view__settings-close" onclick={() => showWindControls = false}>x</button>
      </div>
      
      <div class="map-view__setting">
        <label for="wind-speed">Speed: {windSpeedFactor}</label>
        <input type="range" id="wind-speed" min="0.1" max="10" step="0.1" value={windSpeedFactor} oninput={updateWindSpeed} />
      </div>
      
      <div class="map-view__setting">
        <label for="wind-fade">Trail Length: {windFadeOpacity.toFixed(3)}</label>
        <input type="range" id="wind-fade" min="0.9" max="0.999" step="0.001" value={windFadeOpacity} oninput={updateWindFade} />
      </div>
      
      <div class="map-view__setting">
        <label for="wind-size">Point Size: {windPointSize}</label>
        <input type="range" id="wind-size" min="1" max="20" step="0.5" value={windPointSize} oninput={updateWindPointSize} />
      </div>
      
      <div class="map-view__setting">
        <label for="wind-drop">Drop Rate: {windDropRate.toFixed(4)}</label>
        <input type="range" id="wind-drop" min="0" max="0.05" step="0.001" value={windDropRate} oninput={updateWindDropRate} />
      </div>
      
      <div class="map-view__setting">
        <label for="wind-brightness">Brightness: {windBrightness.toFixed(2)}</label>
        <input type="range" id="wind-brightness" min="0.1" max="1.0" step="0.05" value={windBrightness} oninput={updateWindBrightness} />
      </div>
      
      <div class="map-view__setting">
        <label for="wind-particles">Particles: {windParticleCount.toLocaleString()}</label>
        <input type="range" id="wind-particles" min="1000" max="20000" step="1000" value={windParticleCount} oninput={updateWindParticleCount} />
      </div>
    </div>
  {/if}
  
  {#if isolinesEnabled && showIsolineControls && !compact}
    <div class="map-view__isoline-settings">
      <div class="map-view__settings-header">
        <span>Isoline Settings</span>
        <button class="map-view__settings-close" onclick={() => showIsolineControls = false}>x</button>
      </div>
      
      <div class="map-view__setting">
        <label for="isoline-interval">Interval: {getIntervalDisplayLabel()}</label>
        <input type="range" id="isoline-interval" min="0.5" max="10" step="0.5" value={isolineInterval} oninput={updateIsolineInterval} />
      </div>
      
      <div class="map-view__setting">
        <label for="isoline-thickness">Thickness: {isolineThickness.toFixed(1)}</label>
        <input type="range" id="isoline-thickness" min="0.2" max="10" step="0.1" value={isolineThickness} oninput={updateIsolineThickness} />
      </div>
      
      <div class="map-view__setting">
        <label for="isoline-opacity">Opacity: {(isolineOpacity * 100).toFixed(0)}%</label>
        <input type="range" id="isoline-opacity" min="0.1" max="1" step="0.1" value={isolineOpacity} oninput={updateIsolineOpacity} />
      </div>
      
      <div class="map-view__setting map-view__setting--color">
        <label for="isoline-color">Color:</label>
        <input type="color" id="isoline-color" value={isolineColor} oninput={updateIsolineColor} />
        <span class="map-view__color-value">{isolineColor}</span>
      </div>
      
      <div class="map-view__setting">
        <label for="contour-resolution">Resolution:</label>
        <select 
          id="contour-resolution" 
          class="map-view__select"
          value={String(contourResolution)}
          onchange={handleContourResolutionChange}
        >
          <option value="1">Full (slow)</option>
          <option value="2">1/2 (faster)</option>
          <option value="4">1/4 (fast)</option>
          <option value="8">1/8 (fastest)</option>
        </select>
      </div>
      
      <div class="map-view__setting">
        <label for="contour-smoothing">Smoothing: {contourSmoothing === 0 ? 'None' : contourSmoothing}</label>
        <input 
          type="range" 
          id="contour-smoothing" 
          min="0" 
          max="8" 
          step="1" 
          value={contourSmoothing} 
          oninput={handleContourSmoothingChange} 
        />
      </div>
      
      <div class="map-view__setting map-view__setting--toggle">
        <label>
          <input 
            type="checkbox" 
            checked={contourLabelsEnabled} 
            onchange={handleContourLabelsToggle}
          />
          Show labels
        </label>
      </div>
      
      {#if contourLabelsEnabled}
        <div class="map-view__setting">
          <label for="contour-label-size">Label size: {contourLabelSize}px</label>
          <input 
            type="range" 
            id="contour-label-size" 
            min="8" 
            max="24" 
            step="1" 
            value={contourLabelSize} 
            oninput={handleContourLabelSizeChange} 
          />
        </div>
      {/if}
      
      <div class="map-view__setting map-view__setting--toggle">
        <label>
          <input 
            type="checkbox" 
            checked={steppedColorsEnabled} 
            onchange={handleSteppedColorsToggle}
          />
          Stepped colors (color fill)
        </label>
      </div>
      
      <div class="map-view__setting map-view__setting--toggle">
        <label>
          <input 
            type="checkbox" 
            checked={showGradientLayer} 
            onchange={handleGradientLayerToggle}
          />
          Show gradient layer
        </label>
      </div>
    </div>
  {/if}

  {#if showHelpModal}
    <div class="map-view__modal-overlay" onclick={() => showHelpModal = false}>
      <div class="map-view__modal" onclick={(e) => e.stopPropagation()}>
        <div class="map-view__modal-header">
          <h2>Keyboard Shortcuts</h2>
          <button class="map-view__modal-close" onclick={() => showHelpModal = false}>x</button>
        </div>
        <div class="map-view__modal-content">
          <table class="map-view__shortcuts-table">
            <tbody>
              <tr>
                <td><kbd>Space</kbd></td>
                <td>Play / Pause animation</td>
              </tr>
              <tr>
                <td><kbd>←</kbd> <kbd>→</kbd></td>
                <td>Step through frames (when paused)</td>
              </tr>
              <tr>
                <td><kbd>↑</kbd> <kbd>↓</kbd></td>
                <td>Increase / Decrease speed (when playing)</td>
              </tr>
              <tr>
                <td><kbd>U</kbd></td>
                <td>Lock / Unlock map panning</td>
              </tr>
              <tr>
                <td><kbd>W</kbd></td>
                <td>Toggle wind layer</td>
              </tr>
              <tr>
                <td><kbd>I</kbd></td>
                <td>Toggle isoline (contour) layer</td>
              </tr>
              <tr>
                <td><kbd>R</kbd></td>
                <td>Cycle resolution (Smooth / Blur / Pixelated)</td>
              </tr>
              <tr>
                <td><kbd>C</kbd></td>
                <td>Focus collection selector</td>
              </tr>
              <tr>
                <td><kbd>D</kbd></td>
                <td>Focus parameter selector</td>
              </tr>
              <tr>
                <td><kbd>S</kbd></td>
                <td>Focus style selector</td>
              </tr>
              <tr>
                <td><kbd>M</kbd></td>
                <td>Place a marker on map</td>
              </tr>
              <tr>
                <td><kbd>?</kbd></td>
                <td>Show / Hide this help</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  {/if}

  {#if currentVerticalExtent && !compact}
    <div class="map-view__vertical-slider">
      <div class="map-view__vertical-label">
        {currentVerticalExtent.units ?? 'hPa'}
      </div>
      <input
        type="range"
        class="map-view__vertical-input"
        min="0"
        max={currentVerticalExtent.values.length - 1}
        step="1"
        value={currentVerticalExtent.values.indexOf(selectedVerticalLevel ?? currentVerticalExtent.values[0])}
        oninput={(e) => {
          const idx = parseInt(e.currentTarget.value);
          handleVerticalLevelChange(currentVerticalExtent!.values[idx]);
        }}
        orient="vertical"
        title={`Vertical level: ${selectedVerticalLevel ?? currentVerticalExtent.values[0]} ${currentVerticalExtent.units ?? 'hPa'}`}
      />
      <div class="map-view__vertical-value">
        {selectedVerticalLevel ?? currentVerticalExtent.values[0]}
      </div>
    </div>
  {/if}
</div>

<style>
  .map-view {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 400px;
  }

  .map-view__container {
    position: absolute;
    inset: 0;
  }

  .map-view__container :global(.maplibregl-map) {
    font-family: inherit;
  }

  /* Marker styles (global since MapLibre creates these elements) */
  .map-view__container :global(.map-marker) {
    cursor: pointer;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
  }

  .map-view__container :global(.map-marker svg) {
    fill: var(--color-accent, rgb(78, 179, 211));
  }

  .map-view__container :global(.marker-popup-container .maplibregl-popup-content) {
    background: rgba(20, 20, 20, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    padding: 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .map-view__container :global(.marker-popup-container .maplibregl-popup-tip) {
    border-top-color: rgba(20, 20, 20, 0.95);
  }

  .map-view__container :global(.marker-popup) {
    position: relative;
    padding: 8px 12px;
    padding-right: 24px;
    min-width: 120px;
  }

  .map-view__container :global(.marker-popup__close) {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.5);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    border-radius: 3px;
    transition: all 0.15s;
  }

  .map-view__container :global(.marker-popup__close:hover) {
    background: rgba(239, 68, 68, 0.3);
    color: white;
  }

  .map-view__container :global(.marker-popup__coords) {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 2px;
    font-family: monospace;
  }

  .map-view__container :global(.marker-popup__value) {
    font-size: 11px;
    font-weight: 500;
    color: white;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .map-view__container :global(.marker-popup__value .value-label) {
    color: rgba(255, 255, 255, 0.6);
    font-weight: 400;
  }

  .map-view__container :global(.marker-popup__value .position-value) {
    color: rgb(78, 179, 211);
  }

  .map-view__container :global(.marker-popup__value .loading-indicator) {
    opacity: 0.5;
  }

  .map-view__container :global(.marker-popup__chart) {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .map-view__container :global(.marker-popup__chart svg) {
    display: block;
  }

  .map-view__overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: var(--spacing-md);
    background: rgba(30, 30, 30, 0.85);
    z-index: 10;
    pointer-events: auto;
  }

  .map-view__overlay--error {
    background: rgba(30, 30, 30, 0.95);
  }

  .map-view__spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .map-view__message {
    font-size: var(--font-size-base);
    color: rgba(255, 255, 255, 0.8);
  }

  .map-view__error-toast {
    position: absolute;
    bottom: var(--spacing-lg);
    right: var(--spacing-md);
    max-width: 320px;
    padding: var(--spacing-sm) var(--spacing-md);
    background: rgba(30, 30, 30, 0.95);
    border: 1px solid #f87171;
    border-radius: var(--radius-md);
    backdrop-filter: blur(8px);
    z-index: 20;
  }

  .map-view__error-text {
    font-size: var(--font-size-sm);
    color: #f87171;
    margin: 0 0 var(--spacing-sm) 0;
    line-height: 1.4;
  }

  .map-view__error-actions {
    display: flex;
    gap: var(--spacing-sm);
  }

  .map-view__error-retry {
    padding: var(--spacing-xs) var(--spacing-sm);
    background: var(--color-accent);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__error-retry:hover {
    background: var(--color-accent-dark);
  }

  .map-view__error-dismiss {
    padding: var(--spacing-xs) var(--spacing-sm);
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__error-dismiss:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .map-view__legend {
    position: absolute;
    bottom: var(--spacing-lg);
    left: var(--spacing-md);
    max-width: 280px;
    z-index: 5;
    transition: bottom 0.2s ease;
  }

  .map-view__legend--anim-active {
    bottom: 80px;  /* Move up to make room for animation bar */
  }

  .map-view__controls {
    position: absolute;
    top: var(--spacing-md);
    left: var(--spacing-md);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
    z-index: 5;
  }

  .map-view__edr-config {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .map-view__edr-toggle {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-xs);
    color: rgba(255, 255, 255, 0.7);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    cursor: pointer;
    text-align: left;
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .map-view__edr-toggle:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__edr-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    padding: var(--spacing-sm);
    background: rgba(30, 30, 30, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
  }

  .map-view__edr-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .map-view__edr-label {
    font-size: var(--font-size-xs);
    color: rgba(255, 255, 255, 0.6);
  }

  .map-view__edr-input {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: white;
    background: rgba(50, 50, 50, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    width: 220px;
  }

  .map-view__edr-input:focus {
    outline: none;
    border-color: var(--color-accent);
  }

  .map-view__edr-input::placeholder {
    color: rgba(255, 255, 255, 0.4);
  }

  .map-view__edr-input--small {
    width: 60px;
  }

  .map-view__edr-input:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .map-view__edr-depth {
    flex-direction: row;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .map-view__edr-depth .map-view__edr-label {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }

  .map-view__edr-depth input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
  }

  .map-view__edr-buttons {
    display: flex;
    gap: var(--spacing-xs);
    margin-top: var(--spacing-xs);
  }

  .map-view__edr-apply {
    flex: 1;
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-xs);
    color: white;
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .map-view__edr-apply:hover:not(:disabled) {
    background: var(--color-accent-dark);
  }

  .map-view__edr-apply:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .map-view__edr-reset {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-xs);
    color: rgba(255, 255, 255, 0.7);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .map-view__edr-reset:hover {
    color: white;
    border-color: rgba(255, 255, 255, 0.4);
  }

  .map-view__collection-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
  }

  .map-view__collection-label {
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.7);
  }

  .map-view__collection-label kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__collection-select {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.9);
    background: rgba(50, 50, 50, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    max-width: 200px;
  }

  .map-view__collection-select:hover {
    border-color: var(--color-accent);
  }

  .map-view__collection-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .map-view__collection-select option {
    background: #2a2a2a;
    color: white;
  }

  .map-view__layer-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
  }

  .map-view__layer-label {
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.7);
  }

  .map-view__layer-label kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__layer-select {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.9);
    background: rgba(50, 50, 50, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .map-view__layer-select:hover {
    border-color: var(--color-accent);
  }

  .map-view__layer-select option {
    background: #2a2a2a;
    color: white;
  }

  .map-view__scale-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
  }

  .map-view__scale-label {
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.7);
  }

  .map-view__scale-label kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__scale-select {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.9);
    background: rgba(50, 50, 50, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .map-view__scale-select:hover {
    border-color: var(--color-accent);
  }

  .map-view__scale-select option {
    background: #2a2a2a;
    color: white;
  }

  .map-view__crs-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
  }

  .map-view__crs-label {
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.7);
  }

  .map-view__crs-select {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.9);
    background: rgba(50, 50, 50, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .map-view__crs-select:hover {
    border-color: var(--color-accent);
  }

  .map-view__crs-select option {
    background: #2a2a2a;
    color: white;
  }

  .map-view__offset-selector {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
  }

  .map-view__offset-label {
    font-size: var(--font-size-sm);
    color: rgba(255, 255, 255, 0.7);
    white-space: nowrap;
    min-width: 85px;
  }

  .map-view__offset-slider {
    width: 80px;
    cursor: pointer;
  }

  .map-view__toggle-btn {
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__toggle-btn:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__toggle-btn--active {
    background: rgba(78, 179, 211, 0.3);
    border-color: rgb(78, 179, 211);
    color: white;
  }

  .map-view__toggle-btn kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__wind-toggle {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__wind-toggle kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__wind-toggle:hover:not(:disabled) {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__wind-toggle:disabled {
    cursor: wait;
    opacity: 0.7;
  }

  .map-view__wind-toggle--active {
    background: rgba(78, 179, 211, 0.3);
    border-color: rgb(78, 179, 211);
    color: white;
  }

  .map-view__wind-icon {
    width: 16px;
    height: 16px;
  }

  .map-view__isoline-toggle {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__isoline-toggle kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__isoline-toggle:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__isoline-toggle--active {
    background: rgba(100, 180, 100, 0.3);
    border-color: rgb(100, 180, 100);
    color: white;
  }

  .map-view__isoline-icon {
    width: 16px;
    height: 16px;
  }

  .map-view__isoline-settings {
    position: absolute;
    top: 160px;
    left: var(--spacing-md);
    background: rgba(30, 30, 30, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-md);
    padding: var(--spacing-sm);
    width: 240px;
    z-index: 100;
  }

  .map-view__setting--color {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .map-view__setting--color label {
    flex-shrink: 0;
  }

  .map-view__setting--color input[type="color"] {
    width: 40px;
    height: 28px;
    padding: 2px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }

  .map-view__color-value {
    font-family: monospace;
    font-size: var(--font-size-xs);
    color: rgba(255, 255, 255, 0.6);
  }

  .map-view__select {
    background: rgba(50, 50, 50, 0.9);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    margin-left: auto;
  }

  .map-view__select:hover {
    border-color: rgba(255, 255, 255, 0.5);
  }

  .map-view__setting--toggle {
    margin-top: var(--spacing-sm);
    padding-top: var(--spacing-sm);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .map-view__setting--toggle label {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    cursor: pointer;
    font-size: var(--font-size-sm);
  }

  .map-view__setting--toggle input[type="checkbox"] {
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .map-view__wind-spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .map-view__settings-toggle {
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__settings-toggle:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__lock-toggle {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__lock-toggle:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__lock-toggle--locked {
    background: rgba(78, 179, 211, 0.3);
    border-color: rgb(78, 179, 211);
    color: white;
  }

  .map-view__lock-toggle kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__marker-btn {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-xs) var(--spacing-sm);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .map-view__marker-btn:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__marker-btn--active {
    background: rgba(78, 179, 211, 0.3);
    border-color: rgb(78, 179, 211);
    color: white;
  }

  .map-view__marker-btn kbd {
    font-family: inherit;
    font-size: var(--font-size-xs);
    padding: 1px 4px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    opacity: 0.7;
  }

  .map-view__help-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(4px);
    color: rgba(255, 255, 255, 0.8);
    font-size: var(--font-size-base);
    font-weight: 600;
    cursor: pointer;
  }

  .map-view__help-btn:hover {
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(2px);
  }

  .map-view__modal {
    background: rgba(30, 30, 30, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-md);
    min-width: 320px;
    max-width: 90vw;
    max-height: 90vh;
    overflow: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .map-view__modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-md);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .map-view__modal-header h2 {
    margin: 0;
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: white;
  }

  .map-view__modal-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .map-view__modal-close:hover {
    color: white;
  }

  .map-view__modal-content {
    padding: var(--spacing-md);
  }

  .map-view__shortcuts-table {
    width: 100%;
    border-collapse: collapse;
  }

  .map-view__shortcuts-table td {
    padding: var(--spacing-sm) var(--spacing-xs);
    color: rgba(255, 255, 255, 0.9);
    font-size: var(--font-size-sm);
  }

  .map-view__shortcuts-table td:first-child {
    width: 120px;
    text-align: right;
    padding-right: var(--spacing-md);
  }

  .map-view__shortcuts-table kbd {
    display: inline-block;
    padding: 4px 8px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    font-family: inherit;
    font-size: var(--font-size-sm);
    color: white;
    min-width: 24px;
    text-align: center;
  }

  .map-view__wind-settings {
    position: absolute;
    top: 180px;
    left: var(--spacing-md);
    background: rgba(20, 20, 20, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-md);
    padding: var(--spacing-sm);
    min-width: 220px;
    backdrop-filter: blur(8px);
    z-index: 100;
  }

  .map-view__settings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-sm);
    padding-bottom: var(--spacing-xs);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: white;
  }

  .map-view__settings-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    font-size: 16px;
    padding: 0 4px;
  }

  .map-view__settings-close:hover {
    color: white;
  }

  .map-view__setting {
    margin-bottom: var(--spacing-sm);
  }

  .map-view__setting label {
    display: block;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 4px;
  }

  .map-view__setting input[type="range"] {
    width: 100%;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 2px;
    cursor: pointer;
  }

  .map-view__setting input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    background: rgb(78, 179, 211);
    border-radius: 50%;
    cursor: pointer;
  }

  .map-view__setting input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: rgb(78, 179, 211);
    border: none;
    border-radius: 50%;
    cursor: pointer;
  }

  /* Temporal Extent Info Strip */
  .map-view__temporal-extent {
    position: absolute;
    bottom: calc(var(--spacing-md) + 52px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(20, 20, 20, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: var(--radius-sm);
    backdrop-filter: blur(8px);
    z-index: 10;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.75);
    max-width: 90vw;
  }

  .map-view__temporal-extent-content {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    flex-wrap: wrap;
    white-space: nowrap;
  }

  .map-view__temporal-sep {
    color: rgba(255, 255, 255, 0.25);
    user-select: none;
  }

  .map-view__temporal-run {
    color: rgb(78, 179, 211);
    font-weight: 600;
  }

  .map-view__temporal-range {
    color: rgba(255, 255, 255, 0.85);
  }

  .map-view__temporal-hours {
    color: rgba(255, 255, 255, 0.6);
  }

  .map-view__temporal-count {
    color: rgba(255, 255, 255, 0.5);
  }

  .map-view__temporal-frames {
    color: rgb(129, 211, 78);
    font-weight: 500;
  }

  .map-view__temporal-runs-details {
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .map-view__temporal-runs-summary {
    padding: 3px 10px;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.5);
    font-size: 10px;
    user-select: none;
  }

  .map-view__temporal-runs-summary:hover {
    color: rgba(255, 255, 255, 0.8);
  }

  .map-view__temporal-runs-list {
    padding: 2px 10px 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .map-view__temporal-run-item {
    display: flex;
    gap: 10px;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.5);
  }

  .map-view__temporal-run-item--latest {
    color: rgb(78, 179, 211);
    font-weight: 600;
  }

  .map-view__temporal-run-time {
    min-width: 80px;
  }

  .map-view__temporal-run-range {
    min-width: 160px;
  }

  .map-view__temporal-run-fhrs {
    color: rgba(255, 255, 255, 0.4);
  }

  .map-view__temporal-run-item--latest .map-view__temporal-run-fhrs {
    color: rgba(78, 179, 211, 0.7);
  }

  /* Animation Control Bar */
  .map-view__animation-bar {
    position: absolute;
    bottom: var(--spacing-md);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-sm) var(--spacing-md);
    background: rgba(20, 20, 20, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-md);
    backdrop-filter: blur(8px);
    z-index: 10;
    transition: opacity 0.2s ease;
  }

  .map-view__animation-bar--disabled {
    opacity: 0.5;
  }

  .map-view__animation-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
  }

  .map-view__anim-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    transition: all 0.15s;
  }

  .map-view__anim-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }

  .map-view__anim-btn--play {
    width: 40px;
    height: 40px;
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__anim-btn--play:hover:not(:disabled) {
    background: var(--color-accent-dark);
    border-color: var(--color-accent-dark);
  }

  .map-view__anim-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .map-view__anim-btn--play:disabled {
    background: rgba(78, 179, 211, 0.3);
    border-color: rgba(78, 179, 211, 0.3);
  }

  .map-view__anim-btn--loop {
    width: 28px;
    height: 28px;
    opacity: 0.5;
  }

  .map-view__anim-btn--loop.map-view__anim-btn--active {
    opacity: 1;
    background: var(--color-accent);
    border-color: var(--color-accent);
    color: white;
  }

  .map-view__anim-btn--loop.map-view__anim-btn--active:hover {
    background: var(--color-accent-dark);
    border-color: var(--color-accent-dark);
  }

  .map-view__anim-spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .map-view__animation-scrubber {
    flex: 1;
    min-width: 200px;
  }

  .map-view__scrubber-input {
    width: 100%;
    height: 20px;
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }

  .map-view__scrubber-input::-webkit-slider-runnable-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
  }

  .map-view__scrubber-input::-moz-range-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
  }

  .map-view__scrubber-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    background: var(--color-accent);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    margin-top: -5px;
  }

  .map-view__scrubber-input::-moz-range-thumb {
    width: 16px;
    height: 16px;
    background: var(--color-accent);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .map-view__scrubber-input:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .map-view__scrubber-input:disabled::-webkit-slider-thumb {
    background: rgba(78, 179, 211, 0.5);
    cursor: not-allowed;
  }

  .map-view__scrubber-input:disabled::-moz-range-thumb {
    background: rgba(78, 179, 211, 0.5);
    cursor: not-allowed;
  }

  .map-view__animation-time {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: white;
    min-width: 160px;
    text-align: center;
    font-family: monospace;
    white-space: nowrap;
  }

  .map-view__animation-options {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
  }

  /* Progress bar for frame loading */
  .map-view__load-progress {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }

  .map-view__load-progress-bar {
    height: 100%;
    background: var(--color-accent, rgb(78, 179, 211));
    transition: width 0.2s ease-out;
  }

  .map-view__load-progress-text {
    position: absolute;
    right: 8px;
    top: -18px;
    font-size: 10px;
    color: var(--color-accent, rgb(78, 179, 211));
    font-weight: 500;
  }

  .map-view__anim-select {
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: 12px;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(50, 50, 50, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .map-view__anim-select:hover {
    border-color: var(--color-accent);
  }

  .map-view__anim-select option {
    background: #2a2a2a;
    color: white;
  }

  /* Vertical level slider - positioned on right below zoom controls */
  .map-view__vertical-slider {
    position: absolute;
    top: 120px;
    right: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-sm);
    background: rgba(20, 20, 20, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-md);
    backdrop-filter: blur(8px);
    z-index: 10;
  }

  .map-view__vertical-label {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.7);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .map-view__vertical-input {
    writing-mode: vertical-lr;
    direction: rtl;
    width: 24px;
    height: 150px;
    -webkit-appearance: slider-vertical;
    appearance: slider-vertical;
    background: transparent;
    cursor: pointer;
  }

  .map-view__vertical-input::-webkit-slider-runnable-track {
    width: 6px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
  }

  .map-view__vertical-input::-moz-range-track {
    width: 6px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
  }

  .map-view__vertical-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    background: var(--color-accent);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .map-view__vertical-input::-moz-range-thumb {
    width: 16px;
    height: 16px;
    background: var(--color-accent);
    border: none;
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .map-view__vertical-value {
    font-size: 14px;
    font-weight: 600;
    color: white;
    font-family: monospace;
  }
</style>
