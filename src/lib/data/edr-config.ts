/**
 * EDR API Configuration
 *
 * Manages the EDR endpoint URL and API key for authentication.
 * These values can be changed at runtime via the UI.
 */

// Default EDR endpoint
const DEFAULT_EDR_URL = "https://folkweather.com";
const DEFAULT_DEPTH = "8";

// Current configuration (mutable at runtime)
let edrBaseUrl = DEFAULT_EDR_URL;
let edrApiKey: string | null = null;
let edrDepth: string | null = DEFAULT_DEPTH; // null means omit the parameter

/**
 * Get the current EDR base URL
 */
export function getEdrBaseUrl(): string {
  return edrBaseUrl;
}

/**
 * Set the EDR base URL
 */
export function setEdrBaseUrl(url: string): void {
  // Remove trailing slash if present
  edrBaseUrl = url.replace(/\/$/, '');
  console.log('[EDR Config] Base URL set to:', edrBaseUrl);
}

/**
 * Get the current API key
 */
export function getEdrApiKey(): string | null {
  return edrApiKey;
}

/**
 * Set the API key for basic auth
 */
export function setEdrApiKey(key: string | null): void {
  edrApiKey = key;
  console.log('[EDR Config] API key', key ? 'set' : 'cleared');
}

/**
 * Get the current depth parameter value
 * Returns null if depth should be omitted from requests
 */
export function getEdrDepth(): string | null {
  return edrDepth;
}

/**
 * Set the depth parameter value
 * Pass null to omit the parameter from requests
 */
export function setEdrDepth(depth: string | null): void {
  edrDepth = depth;
  console.log('[EDR Config] Depth', depth !== null ? `set to ${depth}` : 'disabled');
}

/**
 * Get the default depth value
 */
export function getDefaultDepth(): string {
  return DEFAULT_DEPTH;
}

/**
 * Get fetch options with auth headers if API key is set
 */
export function getAuthHeaders(): HeadersInit {
  if (!edrApiKey) {
    return {};
  }

  return {
    'X-API-KEY': edrApiKey,
  };
}

/**
 * Reset to default configuration
 */
export function resetEdrConfig(): void {
  edrBaseUrl = DEFAULT_EDR_URL;
  edrApiKey = null;
  edrDepth = DEFAULT_DEPTH;
  console.log('[EDR Config] Reset to defaults');
}

/**
 * Get the default EDR URL
 */
export function getDefaultEdrUrl(): string {
  return DEFAULT_EDR_URL;
}
