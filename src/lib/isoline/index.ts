/**
 * Isoline Module
 * 
 * Contour line extraction and rendering for scalar fields.
 */

export { extractContours, contoursToGeoJSON, downsampleData } from './marching-squares';
export type { ContourLine, ContourResult, DisplayUnitConfig } from './marching-squares';
