/**
 * Marching Squares Algorithm for Contour Extraction
 * 
 * Extracts smooth contour polylines from a 2D scalar field.
 * Returns GeoJSON-compatible line coordinates.
 */

/**
 * Downsample RGBA data by averaging pixels
 * @param data - Original RGBA pixel data
 * @param width - Original width
 * @param height - Original height
 * @param factor - Downsample factor (2 = half resolution, 4 = quarter)
 * @returns Downsampled data with new dimensions
 */
export function downsampleData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  factor: number
): { data: Uint8ClampedArray; width: number; height: number } {
  if (factor <= 1) {
    return { data, width, height };
  }
  
  const newWidth = Math.floor(width / factor);
  const newHeight = Math.floor(height / factor);
  const newData = new Uint8ClampedArray(newWidth * newHeight * 4);
  
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      // Average the pixels in the factor x factor block
      let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
      let count = 0;
      
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const srcX = x * factor + dx;
          const srcY = y * factor + dy;
          if (srcX < width && srcY < height) {
            const srcIdx = (srcY * width + srcX) * 4;
            sumR += data[srcIdx];
            sumG += data[srcIdx + 1];
            sumB += data[srcIdx + 2];
            sumA += data[srcIdx + 3];
            count++;
          }
        }
      }
      
      const dstIdx = (y * newWidth + x) * 4;
      newData[dstIdx] = Math.round(sumR / count);
      newData[dstIdx + 1] = Math.round(sumG / count);
      newData[dstIdx + 2] = Math.round(sumB / count);
      newData[dstIdx + 3] = Math.round(sumA / count);
    }
  }
  
  return { data: newData, width: newWidth, height: newHeight };
}

export interface ContourLine {
  level: number;
  coordinates: [number, number][];  // [lng, lat] pairs
}

export interface ContourResult {
  lines: ContourLine[];
  levels: number[];
}

/**
 * Display unit configuration for contour level snapping
 */
export interface DisplayUnitConfig {
  unit: 'F' | 'C' | 'K';  // Display unit
  interval: number;       // Interval in display units (e.g., 5 for 5°F)
}

/**
 * Extract contour lines from grayscale data using marching squares
 * 
 * @param data - RGBA pixel data (uses R channel as grayscale)
 * @param width - Grid width
 * @param height - Grid height
 * @param min - Minimum data value in Kelvin (maps to pixel 0)
 * @param max - Maximum data value in Kelvin (maps to pixel 255)
 * @param bbox - [west, south, east, north] in degrees
 * @param interval - Contour interval in Kelvin (used if displayUnit not provided)
 * @param smoothing - Smoothing subdivisions (0 = none, 1-8 = smooth, default 4)
 * @param displayUnit - Optional display unit config for snapping to nice values
 * @returns Array of contour lines with their levels
 */
export function extractContours(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  min: number,
  max: number,
  bbox: [number, number, number, number],
  interval: number,
  smoothing: number = 4,
  displayUnit?: DisplayUnitConfig
): ContourResult {
  const [west, south, east, north] = bbox;
  
  // Cell dimensions - bbox represents pixel EDGES, so we have 'width' pixels
  // spanning the full extent (not width-1 cell intervals)
  const cellWidth = (east - west) / width;
  const cellHeight = (north - south) / height;
  
  // Convert pixel value to data value (Kelvin)
  const toDataValue = (pixel: number): number => {
    return min + (pixel / 255) * (max - min);
  };
  
  // Get pixel value at grid position (uses R channel)
  const getPixel = (x: number, y: number): number => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    const idx = (y * width + x) * 4;
    return data[idx];
  };
  
  // Convert grid position to geographic coordinates
  // Use pixel CENTER (add 0.5) since bbox represents pixel EDGES
  // This matches how the raster layer places images
  const toGeo = (x: number, y: number): [number, number] => {
    const lng = west + (x + 0.5) * cellWidth;
    const lat = north - (y + 0.5) * cellHeight;  // Y is inverted (0 = top = north)
    return [lng, lat];
  };
  
  // Temperature conversion helpers
  const kelvinToDisplay = (k: number): number => {
    if (!displayUnit) return k;
    if (displayUnit.unit === 'F') return (k - 273.15) * 1.8 + 32;
    if (displayUnit.unit === 'C') return k - 273.15;
    return k;
  };
  
  const displayToKelvin = (d: number): number => {
    if (!displayUnit) return d;
    if (displayUnit.unit === 'F') return (d - 32) / 1.8 + 273.15;
    if (displayUnit.unit === 'C') return d + 273.15;
    return d;
  };
  
  // Calculate contour levels
  const dataMin = toDataValue(0);
  const dataMax = toDataValue(255);
  const levels: number[] = [];
  
  if (displayUnit) {
    // Snap to nice round numbers in display units
    const displayMin = kelvinToDisplay(dataMin);
    const displayMax = kelvinToDisplay(dataMax);
    const displayInterval = displayUnit.interval;
    
    // Start from a clean multiple of the display interval
    const startDisplayLevel = Math.ceil(displayMin / displayInterval) * displayInterval;
    
    for (let displayLevel = startDisplayLevel; displayLevel <= displayMax; displayLevel += displayInterval) {
      // Convert back to Kelvin for contour extraction
      const kelvinLevel = displayToKelvin(displayLevel);
      levels.push(kelvinLevel);
    }
  } else {
    // Original behavior: snap to Kelvin multiples
    const startLevel = Math.ceil(dataMin / interval) * interval;
    for (let level = startLevel; level <= dataMax; level += interval) {
      levels.push(level);
    }
  }
  
  const allLines: ContourLine[] = [];
  
  // Process each contour level
  for (const level of levels) {
    const threshold = ((level - min) / (max - min)) * 255;
    const segments = marchingSquares(data, width, height, threshold, getPixel);
    
    // Convert segments to geographic coordinates and join into polylines
    const polylines = joinSegments(segments);
    
    for (const polyline of polylines) {
      if (polyline.length < 2) continue;
      
      // Convert to geographic coordinates
      const coordinates = polyline.map(([x, y]) => toGeo(x, y));
      
      // Smooth the line using Catmull-Rom interpolation
      // More subdivisions = smoother lines but more points
      // smoothing=0 means no smoothing (raw marching squares output)
      const smoothed = smoothing > 0 ? smoothLine(coordinates, smoothing) : coordinates;
      
      allLines.push({
        level,
        coordinates: smoothed
      });
    }
  }
  
  return { lines: allLines, levels };
}

/**
 * Marching squares implementation
 * Returns line segments as pairs of [x, y] coordinates
 */
function marchingSquares(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  getPixel: (x: number, y: number) => number
): Array<[[number, number], [number, number]]> {
  const segments: Array<[[number, number], [number, number]]> = [];
  
  // Process each cell (2x2 pixels)
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      // Get corner values
      const tl = getPixel(x, y);
      const tr = getPixel(x + 1, y);
      const br = getPixel(x + 1, y + 1);
      const bl = getPixel(x, y + 1);
      
      // Determine cell configuration (4-bit index)
      const config = 
        (tl >= threshold ? 8 : 0) |
        (tr >= threshold ? 4 : 0) |
        (br >= threshold ? 2 : 0) |
        (bl >= threshold ? 1 : 0);
      
      // Skip empty or full cells
      if (config === 0 || config === 15) continue;
      
      // Interpolate edge crossing positions
      const interpTop = interpolate(tl, tr, threshold);
      const interpRight = interpolate(tr, br, threshold);
      const interpBottom = interpolate(bl, br, threshold);
      const interpLeft = interpolate(tl, bl, threshold);
      
      // Edge midpoints with interpolation
      const top: [number, number] = [x + interpTop, y];
      const right: [number, number] = [x + 1, y + interpRight];
      const bottom: [number, number] = [x + interpBottom, y + 1];
      const left: [number, number] = [x, y + interpLeft];
      
      // Generate line segments based on configuration
      switch (config) {
        case 1: segments.push([left, bottom]); break;
        case 2: segments.push([bottom, right]); break;
        case 3: segments.push([left, right]); break;
        case 4: segments.push([top, right]); break;
        case 5: 
          // Saddle point - use average to determine
          const avg = (tl + tr + br + bl) / 4;
          if (avg >= threshold) {
            segments.push([top, left]);
            segments.push([bottom, right]);
          } else {
            segments.push([top, right]);
            segments.push([left, bottom]);
          }
          break;
        case 6: segments.push([top, bottom]); break;
        case 7: segments.push([top, left]); break;
        case 8: segments.push([top, left]); break;
        case 9: segments.push([top, bottom]); break;
        case 10:
          // Saddle point
          const avg2 = (tl + tr + br + bl) / 4;
          if (avg2 >= threshold) {
            segments.push([top, right]);
            segments.push([left, bottom]);
          } else {
            segments.push([top, left]);
            segments.push([bottom, right]);
          }
          break;
        case 11: segments.push([top, right]); break;
        case 12: segments.push([left, right]); break;
        case 13: segments.push([bottom, right]); break;
        case 14: segments.push([left, bottom]); break;
      }
    }
  }
  
  return segments;
}

/**
 * Linear interpolation for edge crossing position
 */
function interpolate(v1: number, v2: number, threshold: number): number {
  if (Math.abs(v2 - v1) < 0.0001) return 0.5;
  return (threshold - v1) / (v2 - v1);
}

/**
 * Join line segments into continuous polylines
 */
function joinSegments(
  segments: Array<[[number, number], [number, number]]>
): Array<Array<[number, number]>> {
  if (segments.length === 0) return [];
  
  const tolerance = 0.001;  // Tolerance for point matching
  const used = new Set<number>();
  const polylines: Array<Array<[number, number]>> = [];
  
  const pointsMatch = (p1: [number, number], p2: [number, number]): boolean => {
    return Math.abs(p1[0] - p2[0]) < tolerance && Math.abs(p1[1] - p2[1]) < tolerance;
  };
  
  // Start with each unused segment
  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    
    const polyline: [number, number][] = [...segments[i]];
    used.add(i);
    
    // Try to extend in both directions
    let extended = true;
    while (extended) {
      extended = false;
      
      for (let j = 0; j < segments.length; j++) {
        if (used.has(j)) continue;
        
        const seg = segments[j];
        const start = polyline[0];
        const end = polyline[polyline.length - 1];
        
        if (pointsMatch(seg[1], start)) {
          polyline.unshift(seg[0]);
          used.add(j);
          extended = true;
        } else if (pointsMatch(seg[0], start)) {
          polyline.unshift(seg[1]);
          used.add(j);
          extended = true;
        } else if (pointsMatch(seg[0], end)) {
          polyline.push(seg[1]);
          used.add(j);
          extended = true;
        } else if (pointsMatch(seg[1], end)) {
          polyline.push(seg[0]);
          used.add(j);
          extended = true;
        }
      }
    }
    
    polylines.push(polyline);
  }
  
  return polylines;
}

/**
 * Smooth a polyline using Catmull-Rom spline interpolation
 */
function smoothLine(
  points: [number, number][],
  subdivisions: number = 2
): [number, number][] {
  if (points.length < 3) return points;
  
  const result: [number, number][] = [];
  
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    
    result.push(p1);
    
    // Add interpolated points
    for (let j = 1; j < subdivisions; j++) {
      const t = j / subdivisions;
      const point = catmullRom(p0, p1, p2, p3, t);
      result.push(point);
    }
  }
  
  result.push(points[points.length - 1]);
  
  return result;
}

/**
 * Catmull-Rom spline interpolation
 */
function catmullRom(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number
): [number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  
  const x = 0.5 * (
    2 * p1[0] +
    (-p0[0] + p2[0]) * t +
    (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
    (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
  );
  
  const y = 0.5 * (
    2 * p1[1] +
    (-p0[1] + p2[1]) * t +
    (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
    (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
  );
  
  return [x, y];
}

/**
 * Convert contour lines to GeoJSON FeatureCollection
 */
export function contoursToGeoJSON(contours: ContourResult): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = contours.lines.map(line => ({
    type: 'Feature',
    properties: {
      level: line.level
    },
    geometry: {
      type: 'LineString',
      coordinates: line.coordinates
    }
  }));
  
  return {
    type: 'FeatureCollection',
    features
  };
}
