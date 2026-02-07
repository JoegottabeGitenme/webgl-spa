/**
 * Global Fixed Scales for Weather Parameters
 * 
 * These scales ensure consistent coloring across tiles and animation frames.
 * Values are based on typical meteorological ranges.
 */

export interface ParameterScale {
  /** Minimum value in native units */
  min: number;
  /** Maximum value in native units */
  max: number;
  /** Unit string */
  unit: string;
  /** Human-readable parameter name */
  name: string;
}

/**
 * Global fixed scales for each weather parameter.
 * Keys match EDR parameter names (e.g., TMP, RH, APCP).
 */
export const PARAMETER_SCALES: Record<string, ParameterScale> = {
  // Temperature (Kelvin)
  TMP: {
    min: 200,   // -73°C / -100°F (extreme cold)
    max: 330,   // 57°C / 134°F (extreme hot)
    unit: 'K',
    name: 'Temperature',
  },
  
  // Relative Humidity (percent)
  RH: {
    min: 0,
    max: 100,
    unit: '%',
    name: 'Relative Humidity',
  },
  
  // Accumulated Precipitation (mm or kg/m²)
  APCP: {
    min: 0,
    max: 100,   // 100mm is heavy rain
    unit: 'mm',
    name: 'Accumulated Precipitation',
  },
  
  // Precipitation Rate (mm/hr)
  PRATE: {
    min: 0,
    max: 50,    // 50mm/hr is very heavy
    unit: 'mm/hr',
    name: 'Precipitation Rate',
  },
  
  // Composite Reflectivity (dBZ)
  REFC: {
    min: -10,
    max: 75,
    unit: 'dBZ',
    name: 'Composite Reflectivity',
  },
  
  // U-component of wind (m/s)
  UGRD: {
    min: -50,
    max: 50,
    unit: 'm/s',
    name: 'U-Wind Component',
  },
  
  // V-component of wind (m/s)
  VGRD: {
    min: -50,
    max: 50,
    unit: 'm/s',
    name: 'V-Wind Component',
  },
  
  // Wind Speed (m/s)
  WIND: {
    min: 0,
    max: 70,    // ~155 mph hurricane
    unit: 'm/s',
    name: 'Wind Speed',
  },
  
  // Geopotential Height (gpm)
  HGT: {
    min: 0,
    max: 15000, // meters
    unit: 'gpm',
    name: 'Geopotential Height',
  },
  
  // Dew Point Temperature (Kelvin)
  DPT: {
    min: 200,
    max: 310,   // Dew point rarely exceeds 35°C
    unit: 'K',
    name: 'Dew Point Temperature',
  },
  
  // Surface Pressure (Pa)
  PRES: {
    min: 87000,  // ~870 hPa (low)
    max: 108000, // ~1080 hPa (high)
    unit: 'Pa',
    name: 'Surface Pressure',
  },
  
  // Mean Sea Level Pressure (Pa)
  PRMSL: {
    min: 87000,
    max: 108000,
    unit: 'Pa',
    name: 'Mean Sea Level Pressure',
  },
  
  // Cloud Cover (percent)
  TCDC: {
    min: 0,
    max: 100,
    unit: '%',
    name: 'Total Cloud Cover',
  },
  
  // Visibility (meters)
  VIS: {
    min: 0,
    max: 50000,  // 50km max visibility
    unit: 'm',
    name: 'Visibility',
  },
  
  // Convective Available Potential Energy (J/kg)
  CAPE: {
    min: 0,
    max: 5000,   // >4000 is extreme instability
    unit: 'J/kg',
    name: 'CAPE',
  },
  
  // Convective Inhibition (J/kg)
  CIN: {
    min: -500,
    max: 0,
    unit: 'J/kg',
    name: 'CIN',
  },
};

/**
 * Get the global fixed scale for a parameter.
 * Returns a default scale if parameter is unknown.
 */
export function getParameterScale(parameter: string): ParameterScale {
  const scale = PARAMETER_SCALES[parameter];
  if (scale) {
    return scale;
  }
  
  // Default scale for unknown parameters (0-255 for grayscale range)
  console.warn(`Unknown parameter "${parameter}", using default scale`);
  return {
    min: 0,
    max: 255,
    unit: '',
    name: parameter,
  };
}

/**
 * Normalize a data value to 0-1 range using the global fixed scale.
 */
export function normalizeValue(value: number, parameter: string): number {
  const scale = getParameterScale(parameter);
  return (value - scale.min) / (scale.max - scale.min);
}

/**
 * Denormalize a 0-1 value back to the parameter's native range.
 */
export function denormalizeValue(normalized: number, parameter: string): number {
  const scale = getParameterScale(parameter);
  return normalized * (scale.max - scale.min) + scale.min;
}

/**
 * Convert a grayscale byte (0-255) to the actual data value using
 * the tile's metadata (from server headers).
 */
export function grayscaleToDataValue(
  grayscale: number,
  tileMin: number,
  tileMax: number
): number {
  return tileMin + (grayscale / 255) * (tileMax - tileMin);
}

/**
 * Convert an actual data value to a grayscale byte (0-255) using
 * the global fixed scale for consistent coloring across tiles.
 */
export function dataValueToGrayscale(value: number, parameter: string): number {
  const scale = getParameterScale(parameter);
  const normalized = (value - scale.min) / (scale.max - scale.min);
  const clamped = Math.max(0, Math.min(1, normalized));
  return Math.round(clamped * 255);
}

/**
 * Renormalize tile grayscale data from tile-local range to global fixed scale.
 * This ensures consistent coloring across tiles with different min/max values.
 */
export function renormalizeToGlobalScale(
  grayscaleData: Uint8ClampedArray,
  tileMin: number,
  tileMax: number,
  parameter: string
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(grayscaleData.length);
  const scale = getParameterScale(parameter);
  
  for (let i = 0; i < grayscaleData.length; i += 4) {
    // Get grayscale value (assuming R=G=B)
    const localGrayscale = grayscaleData[i];
    
    // Convert to actual data value using tile's local range
    const dataValue = tileMin + (localGrayscale / 255) * (tileMax - tileMin);
    
    // Convert to grayscale using global fixed scale
    const globalNormalized = (dataValue - scale.min) / (scale.max - scale.min);
    const globalGrayscale = Math.round(Math.max(0, Math.min(1, globalNormalized)) * 255);
    
    // Write to result (grayscale = R=G=B)
    result[i] = globalGrayscale;     // R
    result[i + 1] = globalGrayscale; // G
    result[i + 2] = globalGrayscale; // B
    result[i + 3] = grayscaleData[i + 3]; // Preserve alpha
  }
  
  return result;
}
