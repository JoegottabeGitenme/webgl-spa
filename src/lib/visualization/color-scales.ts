/**
 * Color scales for weather data visualization
 *
 * These define color gradients used to map data values to colors.
 * Each scale is an array of [position, r, g, b] tuples where:
 * - position: 0.0 to 1.0 (normalized data value)
 * - r, g, b: 0 to 255 color components
 */

export type ColorStop = [position: number, r: number, g: number, b: number];
export type ColorScale = ColorStop[];

/**
 * Temperature color scale (NWS/NOAA style)
 * Classic weather map color progression for intuitive temperature reading
 *
 * Color progression:
 * - Purple: Very cold (< 0°F / -18°C)
 * - Blue: Cold (0-30°F / -18 to -1°C)
 * - Cyan: Cool (30-50°F / -1 to 10°C)
 * - Green: Mild (50-65°F / 10 to 18°C)
 * - Yellow: Warm (65-80°F / 18 to 27°C)
 * - Orange: Hot (80-90°F / 27 to 32°C)
 * - Red: Very hot (90-100°F / 32 to 38°C)
 * - Magenta: Extreme heat (> 100°F / 38°C)
 */
export const TEMPERATURE_SCALE: ColorScale = [
  [0.00, 145, 0, 180],     // Purple (very cold)
  [0.10, 60, 0, 180],      // Dark purple  
  [0.20, 0, 0, 255],       // Blue (cold)
  [0.30, 0, 120, 255],     // Light blue
  [0.40, 0, 200, 200],     // Cyan (cool)
  [0.50, 0, 200, 0],       // Green (mild)
  [0.60, 150, 255, 0],     // Yellow-green
  [0.70, 255, 255, 0],     // Yellow (warm)
  [0.80, 255, 150, 0],     // Orange
  [0.90, 255, 0, 0],       // Red (hot)
  [1.00, 200, 0, 100],     // Magenta (very hot)
];

/**
 * Viridis color scale
 * Perceptually uniform, colorblind-friendly
 * Popular in scientific visualization (matplotlib default)
 */
export const VIRIDIS_SCALE: ColorScale = [
  [0.0, 68, 1, 84], // Dark purple
  [0.13, 71, 44, 122], // Purple
  [0.25, 59, 81, 139], // Blue-purple
  [0.38, 44, 113, 142], // Teal-blue
  [0.5, 33, 144, 141], // Teal
  [0.63, 39, 173, 129], // Green-teal
  [0.75, 92, 200, 99], // Green
  [0.88, 170, 220, 50], // Yellow-green
  [1.0, 253, 231, 37], // Yellow
];

/**
 * Plasma color scale
 * Perceptually uniform with high contrast
 * Good for highlighting variation
 */
export const PLASMA_SCALE: ColorScale = [
  [0.0, 13, 8, 135], // Dark blue
  [0.13, 75, 3, 161], // Purple
  [0.25, 125, 3, 168], // Magenta
  [0.38, 168, 34, 150], // Pink-magenta
  [0.5, 203, 70, 121], // Pink
  [0.63, 229, 107, 93], // Salmon
  [0.75, 248, 148, 65], // Orange
  [0.88, 253, 195, 40], // Yellow-orange
  [1.0, 240, 249, 33], // Yellow
];

/**
 * Inferno color scale
 * Perceptually uniform, black to yellow through red
 * Good for thermal/heat visualization
 */
export const INFERNO_SCALE: ColorScale = [
  [0.0, 0, 0, 4], // Black
  [0.13, 40, 11, 84], // Dark purple
  [0.25, 101, 21, 110], // Purple
  [0.38, 159, 42, 99], // Magenta
  [0.5, 212, 72, 66], // Red
  [0.63, 245, 125, 21], // Orange
  [0.75, 250, 175, 12], // Yellow-orange
  [0.88, 245, 219, 76], // Light yellow
  [1.0, 252, 255, 164], // Pale yellow
];

/**
 * Grayscale color scale
 * Simple black to white gradient
 * Useful for raw data visualization
 */
export const GRAYSCALE: ColorScale = [
  [0.0, 0, 0, 0], // Black
  [0.5, 128, 128, 128], // Gray
  [1.0, 255, 255, 255], // White
];

/**
 * Turbo color scale
 * High contrast rainbow-like scale
 * More perceptually uniform than traditional rainbow
 */
export const TURBO_SCALE: ColorScale = [
  [0.0, 48, 18, 59], // Dark blue
  [0.1, 67, 85, 175], // Blue
  [0.2, 60, 140, 202], // Light blue
  [0.3, 45, 185, 177], // Cyan
  [0.4, 74, 215, 115], // Green
  [0.5, 148, 230, 57], // Yellow-green
  [0.6, 218, 224, 47], // Yellow
  [0.7, 252, 188, 47], // Orange
  [0.8, 249, 130, 46], // Red-orange
  [0.9, 219, 67, 45], // Red
  [1.0, 122, 4, 3], // Dark red
];

/**
 * Radar Reflectivity color scale (College of DuPage style)
 * NEXRAD dBZ scale from -30 to 80 dBZ
 * 
 * Color progression:
 * - Black/Gray: Below threshold (-30 to 0 dBZ)
 * - Blue: Light returns (0-10 dBZ)
 * - Cyan/Teal: Light precip (10-20 dBZ)
 * - Green: Light rain (20-30 dBZ)
 * - Yellow: Moderate rain (30-40 dBZ)
 * - Orange: Heavy rain (40-50 dBZ)
 * - Red: Very heavy rain (50-60 dBZ)
 * - Magenta: Extreme/hail (60-70 dBZ)
 * - Cyan/White: Highest returns (70-80 dBZ)
 */
export const REFLECTIVITY_SCALE: ColorScale = [
  [0.000, 0, 0, 0],         // -30 dBZ - Black
  [0.182, 40, 40, 40],      // -10 dBZ - Dark gray
  [0.273, 100, 100, 100],   //   0 dBZ - Gray
  [0.318, 0, 0, 180],       //   5 dBZ - Dark blue
  [0.364, 0, 0, 255],       //  10 dBZ - Blue
  [0.409, 0, 200, 255],     //  15 dBZ - Cyan-blue
  [0.455, 0, 255, 200],     //  20 dBZ - Teal
  [0.500, 0, 255, 0],       //  25 dBZ - Green
  [0.545, 50, 255, 0],      //  30 dBZ - Yellow-green
  [0.591, 200, 255, 0],     //  35 dBZ - Yellow-green
  [0.636, 255, 255, 0],     //  40 dBZ - Yellow
  [0.682, 255, 180, 0],     //  45 dBZ - Orange-yellow
  [0.727, 255, 100, 0],     //  50 dBZ - Orange
  [0.773, 255, 0, 0],       //  55 dBZ - Red
  [0.818, 200, 0, 0],       //  60 dBZ - Dark red
  [0.864, 255, 0, 255],     //  65 dBZ - Magenta
  [0.909, 255, 100, 255],   //  70 dBZ - Pink-magenta
  [0.955, 0, 255, 255],     //  75 dBZ - Cyan
  [1.000, 255, 255, 255],   //  80 dBZ - White
];

/**
 * Radar color scale (Blue-Orange-Yellow style)
 * Cleaner visualization focusing on precipitation intensity
 * 
 * Color progression:
 * - Transparent: No returns (< 10 dBZ)
 * - Blue: Light returns (10-25 dBZ)
 * - Orange: Moderate rain (25-40 dBZ)
 * - Yellow/White: Heavy rain (40+ dBZ)
 */
export const RADAR_WARM_SCALE: ColorScale = [
  [0.00, 0, 0, 0],           // No return - will be transparent
  [0.30, 30, 60, 180],       // Dark blue - light precip
  [0.45, 60, 120, 220],      // Blue - light rain
  [0.55, 200, 100, 50],      // Orange - moderate rain
  [0.70, 255, 150, 0],       // Bright orange - heavy rain
  [0.85, 255, 220, 50],      // Yellow-orange - very heavy
  [1.00, 255, 255, 150],     // Light yellow/white - extreme
];

/**
 * Humidity color scale (0-100%)
 * Bluescale - darker = more humid
 */
export const HUMIDITY_SCALE: ColorScale = [
  [0.0, 200, 200, 255],     // Very light blue (0-20%)
  [0.2, 100, 150, 255],     // Light blue (20-40%)
  [0.4, 50, 100, 255],      // Medium blue (40-60%)
  [0.6, 0, 50, 255],        // Blue (60-80%)
  [0.8, 0, 0, 200],         // Dark blue (80-90%)
  [1.0, 0, 0, 100],         // Very dark blue (90-100%)
];

/**
 * Precipitation color scale (0-10mm)
 * Green to blue progression
 */
export const PRECIPITATION_SCALE: ColorScale = [
  [0.0, 240, 255, 240],     // Very light green (0mm)
  [0.2, 100, 255, 100],     // Light green (0.1-2mm)
  [0.4, 0, 200, 0],         // Green (2-4mm)
  [0.6, 0, 150, 150],       // Teal (4-6mm)
  [0.8, 0, 100, 200],       // Blue (6-8mm)
  [1.0, 0, 50, 255],        // Dark blue (8-10mm)
];

/**
 * Dew Point color scale (0-70°F)
 * Shows dew point temperature for dew risk assessment
 */
export const DEWPOINT_SCALE: ColorScale = [
  [0.0, 200, 200, 255],     // Light blue (0-15°F - very dry)
  [0.2, 150, 150, 255],     // Blue (15-25°F - dry)
  [0.4, 100, 200, 100],     // Green (25-35°F - comfortable)
  [0.6, 100, 255, 100],     // Bright green (35-45°F - humid)
  [0.8, 255, 255, 0],       // Yellow (45-55°F - very humid)
  [1.0, 255, 100, 0],       // Orange (55-70°F - oppressive, high dew risk)
];

/**
 * Named color scales for easy selection
 */
export const COLOR_SCALES = {
  temperature: TEMPERATURE_SCALE,
  viridis: VIRIDIS_SCALE,
  plasma: PLASMA_SCALE,
  inferno: INFERNO_SCALE,
  grayscale: GRAYSCALE,
  turbo: TURBO_SCALE,
  reflectivity: REFLECTIVITY_SCALE,
  radarWarm: RADAR_WARM_SCALE,
  humidity: HUMIDITY_SCALE,
  precipitation: PRECIPITATION_SCALE,
  dewpoint: DEWPOINT_SCALE,
} as const;

export type ColorScaleName = keyof typeof COLOR_SCALES;

/**
 * Human-readable names for color scales
 */
export const COLOR_SCALE_LABELS: Record<ColorScaleName, string> = {
  temperature: "Temperature",
  viridis: "Viridis",
  plasma: "Plasma",
  inferno: "Inferno",
  grayscale: "Grayscale",
  turbo: "Turbo",
  reflectivity: "Radar",
  radarWarm: "Radar (Warm)",
  humidity: "Humidity",
  precipitation: "Precipitation",
  dewpoint: "Dew Point",
};

/**
 * Interpolate between two color stops
 */
function lerpColor(
  c1: ColorStop,
  c2: ColorStop,
  t: number
): [number, number, number] {
  const [, r1, g1, b1] = c1;
  const [, r2, g2, b2] = c2;

  return [
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  ];
}

/**
 * Get color for a normalized value (0.0 - 1.0) from a color scale
 *
 * @param value - Normalized value between 0 and 1
 * @param scale - Color scale to use
 * @returns RGB color as [r, g, b] (0-255 each)
 */
export function getColorForValue(
  value: number,
  scale: ColorScale
): [number, number, number] {
  // Clamp value to valid range
  const v = Math.max(0, Math.min(1, value));

  // Find the two stops to interpolate between
  let lower = scale[0];
  let upper = scale[scale.length - 1];

  for (let i = 0; i < scale.length - 1; i++) {
    if (v >= scale[i][0] && v <= scale[i + 1][0]) {
      lower = scale[i];
      upper = scale[i + 1];
      break;
    }
  }

  // Calculate interpolation factor
  const range = upper[0] - lower[0];
  const t = range > 0 ? (v - lower[0]) / range : 0;

  return lerpColor(lower, upper, t);
}

/**
 * Generate a 1D texture data array from a color scale
 * Used for GPU-based colormap lookup
 *
 * @param scale - Color scale to convert
 * @param width - Width of the texture (number of color samples)
 * @returns Uint8Array of RGBA values (width * 4 bytes)
 */
export function generateColorMapTexture(
  scale: ColorScale,
  width: number = 256
): Uint8Array {
  const data = new Uint8Array(width * 4);

  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    const [r, g, b] = getColorForValue(t, scale);
    const offset = i * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255; // Alpha
  }

  return data;
}

/**
 * Convert RGB to CSS color string
 */
export function rgbToCSS(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Generate CSS gradient string from color scale
 * Useful for legend display
 */
export function colorScaleToGradient(
  scale: ColorScale,
  direction: "horizontal" | "vertical" = "horizontal"
): string {
  const angle = direction === "horizontal" ? "to right" : "to top";
  const stops = scale
    .map(([pos, r, g, b]) => `${rgbToCSS(r, g, b)} ${pos * 100}%`)
    .join(", ");

  return `linear-gradient(${angle}, ${stops})`;
}

/**
 * Apply a colormap to grayscale image data
 *
 * Takes raw grayscale pixel data (RGBA format where R=G=B=grayscale value)
 * and applies a color scale, producing new RGBA output.
 *
 * This is a pure function that operates on typed arrays, making it
 * easy to test without DOM dependencies.
 *
 * @param grayscaleData - Source image data in RGBA format (grayscale in R channel)
 * @param scale - Color scale to apply
 * @param alpha - Alpha value (0-255) or function that takes normalized value (0-1) and returns alpha (0-255)
 * @returns New Uint8ClampedArray with colormap applied
 */
export function applyColormapToImageData(
  grayscaleData: Uint8ClampedArray,
  scale: ColorScale,
  alpha: number | ((normalizedValue: number) => number) = 200
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(grayscaleData.length);

  for (let i = 0; i < grayscaleData.length; i += 4) {
    // Normalize grayscale value from R channel (0-255) to 0-1
    const normalizedValue = grayscaleData[i] / 255;
    const [r, g, b] = getColorForValue(normalizedValue, scale);

    output[i] = r; // R
    output[i + 1] = g; // G
    output[i + 2] = b; // B
    
    // Support both fixed alpha and alpha function
    output[i + 3] = typeof alpha === 'function' 
      ? alpha(normalizedValue) 
      : alpha;
  }

  return output;
}

/**
 * Apply a colormap to grayscale image data with stepped/quantized colors
 * Creates discrete color bands instead of smooth gradients
 * 
 * @param grayscaleData - RGBA image data (only R channel is used)
 * @param scale - The color scale to use
 * @param steps - Number of discrete color steps
 * @param alpha - Alpha value (0-255) or function that takes normalized value (0-1) and returns alpha (0-255)
 * @returns New Uint8ClampedArray with stepped colormap applied
 */
export function applySteppedColormapToImageData(
  grayscaleData: Uint8ClampedArray,
  scale: ColorScale,
  steps: number,
  alpha: number | ((normalizedValue: number) => number) = 200
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(grayscaleData.length);

  for (let i = 0; i < grayscaleData.length; i += 4) {
    // Normalize grayscale value from R channel (0-255) to 0-1
    const normalizedValue = grayscaleData[i] / 255;
    
    // Quantize to discrete steps (floor to get step boundaries that align with contour lines)
    const stepSize = 1 / steps;
    const quantizedValue = Math.floor(normalizedValue / stepSize) * stepSize + stepSize / 2;
    const clampedValue = Math.min(Math.max(quantizedValue, 0), 1);
    
    const [r, g, b] = getColorForValue(clampedValue, scale);

    output[i] = r; // R
    output[i + 1] = g; // G
    output[i + 2] = b; // B
    
    // Support both fixed alpha and alpha function
    output[i + 3] = typeof alpha === 'function' 
      ? alpha(normalizedValue) 
      : alpha;
  }

  return output;
}

/**
 * Apply a colormap with stepped colors that align exactly with contour levels
 * Each region between contour lines gets a single solid color
 * 
 * @param grayscaleData - RGBA image data (only R channel is used)
 * @param scale - The color scale to use
 * @param levels - Array of contour levels in data units (e.g., Kelvin for temperature)
 * @param dataMin - Minimum data value (maps to pixel value 0)
 * @param dataMax - Maximum data value (maps to pixel value 255)
 * @param alpha - Alpha value (0-255) or function
 * @returns New Uint8ClampedArray with stepped colormap applied
 */
export function applySteppedColormapWithLevels(
  grayscaleData: Uint8ClampedArray,
  scale: ColorScale,
  levels: number[],
  dataMin: number,
  dataMax: number,
  alpha: number | ((normalizedValue: number) => number) = 200
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(grayscaleData.length);
  const dataRange = dataMax - dataMin;
  
  // Sort levels to ensure they're in ascending order
  const sortedLevels = [...levels].sort((a, b) => a - b);
  
  // Pre-calculate normalized level positions (0-1 scale for color lookup)
  // Also calculate the midpoint of each band for color selection
  const bandColors: [number, number, number][] = [];
  
  // Band below first level
  if (sortedLevels.length > 0) {
    const firstLevelNorm = (sortedLevels[0] - dataMin) / dataRange;
    const belowMid = Math.max(0, firstLevelNorm / 2);
    bandColors.push(getColorForValue(belowMid, scale));
  }
  
  // Bands between levels
  for (let i = 0; i < sortedLevels.length - 1; i++) {
    const lowNorm = (sortedLevels[i] - dataMin) / dataRange;
    const highNorm = (sortedLevels[i + 1] - dataMin) / dataRange;
    const midNorm = (lowNorm + highNorm) / 2;
    bandColors.push(getColorForValue(Math.min(1, Math.max(0, midNorm)), scale));
  }
  
  // Band above last level
  if (sortedLevels.length > 0) {
    const lastLevelNorm = (sortedLevels[sortedLevels.length - 1] - dataMin) / dataRange;
    const aboveMid = Math.min(1, (lastLevelNorm + 1) / 2);
    bandColors.push(getColorForValue(aboveMid, scale));
  }

  for (let i = 0; i < grayscaleData.length; i += 4) {
    // Convert pixel value to data value
    const pixelValue = grayscaleData[i];
    const dataValue = dataMin + (pixelValue / 255) * dataRange;
    const normalizedValue = pixelValue / 255;
    
    // Find which band this value falls into
    let bandIndex = 0;
    for (let j = 0; j < sortedLevels.length; j++) {
      if (dataValue >= sortedLevels[j]) {
        bandIndex = j + 1;
      } else {
        break;
      }
    }
    
    // Get the pre-calculated color for this band
    const [r, g, b] = bandColors[Math.min(bandIndex, bandColors.length - 1)] || [128, 128, 128];

    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
    
    output[i + 3] = typeof alpha === 'function' 
      ? alpha(normalizedValue) 
      : alpha;
  }

  return output;
}

/**
 * Alpha function for radar data - makes low values transparent
 * 
 * This prevents the black/dark areas (no precipitation) from obscuring the map.
 * Values below ~15 dBZ (0.3 normalized) are fully transparent,
 * then fade in gradually to full opacity.
 * 
 * @param normalizedValue - 0-1 value from grayscale data
 * @returns Alpha value 0-255
 */
export function radarAlphaFunction(normalizedValue: number): number {
  // Make values below ~15 dBZ (0.3 normalized) fully transparent
  if (normalizedValue < 0.30) return 0;
  
  // Fade in from 0.30 to 0.40
  if (normalizedValue < 0.40) {
    return Math.round(((normalizedValue - 0.30) / 0.10) * 200);
  }
  
  // Full opacity for higher values
  return 200;
}

/**
 * Absolute temperature ranges for color scale mapping
 * These define the full range of the color scale (position 0-1)
 */
export const ABSOLUTE_TEMP_RANGES = {
  F: { min: -60, max: 130 },  // -60°F to 130°F
  C: { min: -51, max: 54 },   // ~-51°C to ~54°C (equivalent)
};

/**
 * Apply a colormap using absolute temperature mapping
 * 
 * This maps pixel values to actual temperatures, then to positions on an
 * absolute temperature scale, ensuring the color scale is consistent
 * regardless of the data range.
 * 
 * @param grayscaleData - RGBA image data (only R channel is used)
 * @param scale - The color scale to use
 * @param dataMin - Data minimum in Kelvin
 * @param dataMax - Data maximum in Kelvin
 * @param unit - Temperature display unit ('F' or 'C')
 * @param alpha - Alpha value or function
 * @returns New Uint8ClampedArray with colormap applied
 */
export function applyColormapWithAbsoluteTemp(
  grayscaleData: Uint8ClampedArray,
  scale: ColorScale,
  dataMin: number,
  dataMax: number,
  unit: 'F' | 'C' = 'F',
  alpha: number | ((normalizedValue: number) => number) = 200
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(grayscaleData.length);
  const dataRange = dataMax - dataMin;
  const absRange = ABSOLUTE_TEMP_RANGES[unit];
  const absRangeSize = absRange.max - absRange.min;

  for (let i = 0; i < grayscaleData.length; i += 4) {
    // Get pixel value and convert to data value (Kelvin)
    const pixelValue = grayscaleData[i];
    const kelvin = dataMin + (pixelValue / 255) * dataRange;
    
    // Convert Kelvin to display temperature
    const displayTemp = unit === 'F' 
      ? (kelvin - 273.15) * 1.8 + 32  // K to F
      : kelvin - 273.15;               // K to C
    
    // Map display temp to absolute scale position (0-1)
    const absPosition = (displayTemp - absRange.min) / absRangeSize;
    const clampedPosition = Math.max(0, Math.min(1, absPosition));
    
    // Get color at this position
    const [r, g, b] = getColorForValue(clampedPosition, scale);

    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
    
    output[i + 3] = typeof alpha === 'function' 
      ? alpha(pixelValue / 255) 
      : alpha;
  }

  return output;
}

/**
 * Apply stepped colormap using absolute temperature mapping
 * Creates discrete color bands at specified temperature levels
 */
export function applySteppedColormapWithAbsoluteTemp(
  grayscaleData: Uint8ClampedArray,
  scale: ColorScale,
  levels: number[],  // Contour levels in Kelvin
  dataMin: number,
  dataMax: number,
  unit: 'F' | 'C' = 'F',
  alpha: number | ((normalizedValue: number) => number) = 200
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(grayscaleData.length);
  const dataRange = dataMax - dataMin;
  const absRange = ABSOLUTE_TEMP_RANGES[unit];
  const absRangeSize = absRange.max - absRange.min;
  
  // Sort levels
  const sortedLevels = [...levels].sort((a, b) => a - b);
  
  // Pre-calculate colors for each band (using midpoint of each band in absolute temp scale)
  const bandColors: [number, number, number][] = [];
  
  // Band below first level
  if (sortedLevels.length > 0) {
    const firstLevelF = unit === 'F' 
      ? (sortedLevels[0] - 273.15) * 1.8 + 32 
      : sortedLevels[0] - 273.15;
    const belowMidF = (absRange.min + firstLevelF) / 2;
    const belowPos = (belowMidF - absRange.min) / absRangeSize;
    bandColors.push(getColorForValue(Math.max(0, Math.min(1, belowPos)), scale));
  }
  
  // Bands between levels
  for (let i = 0; i < sortedLevels.length - 1; i++) {
    const lowF = unit === 'F'
      ? (sortedLevels[i] - 273.15) * 1.8 + 32
      : sortedLevels[i] - 273.15;
    const highF = unit === 'F'
      ? (sortedLevels[i + 1] - 273.15) * 1.8 + 32
      : sortedLevels[i + 1] - 273.15;
    const midF = (lowF + highF) / 2;
    const midPos = (midF - absRange.min) / absRangeSize;
    bandColors.push(getColorForValue(Math.max(0, Math.min(1, midPos)), scale));
  }
  
  // Band above last level
  if (sortedLevels.length > 0) {
    const lastLevelF = unit === 'F'
      ? (sortedLevels[sortedLevels.length - 1] - 273.15) * 1.8 + 32
      : sortedLevels[sortedLevels.length - 1] - 273.15;
    const aboveMidF = (lastLevelF + absRange.max) / 2;
    const abovePos = (aboveMidF - absRange.min) / absRangeSize;
    bandColors.push(getColorForValue(Math.max(0, Math.min(1, abovePos)), scale));
  }

  for (let i = 0; i < grayscaleData.length; i += 4) {
    // Get pixel value and convert to Kelvin
    const pixelValue = grayscaleData[i];
    const kelvin = dataMin + (pixelValue / 255) * dataRange;
    
    // Find which band this value falls into
    let bandIndex = 0;
    for (let j = 0; j < sortedLevels.length; j++) {
      if (kelvin >= sortedLevels[j]) {
        bandIndex = j + 1;
      } else {
        break;
      }
    }
    
    // Get the pre-calculated color for this band
    const [r, g, b] = bandColors[Math.min(bandIndex, bandColors.length - 1)] || [128, 128, 128];

    output[i] = r;
    output[i + 1] = g;
    output[i + 2] = b;
    
    output[i + 3] = typeof alpha === 'function' 
      ? alpha(pixelValue / 255) 
      : alpha;
  }

  return output;
}
