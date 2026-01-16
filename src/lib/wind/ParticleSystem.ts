/**
 * Wind Particle System
 *
 * Manages particles that flow along wind vectors with trailing paths.
 * Particles are born at random positions, move according to wind velocity,
 * and die after a certain age or when leaving the bounds.
 * 
 * Each particle stores a history of positions to render as a trail.
 */

import { type WindData, sampleWind, windMagnitude } from './wind-data';

export interface ParticleSystemOptions {
  /** Number of particles (default: 65536 for desktop, 16384 for mobile) */
  numParticles?: number;
  /** Speed multiplier for particle movement (default: 0.25) */
  speedFactor?: number;
  /** How fast particles age (0-1 per second, default: 0.2) */
  ageRate?: number;
  /** Maximum particle lifespan in seconds (default: 4) */
  maxAge?: number;
  /** Particle trail length - number of positions to store (default: 12) */
  trailLength?: number;
}

const DEFAULT_OPTIONS: Required<ParticleSystemOptions> = {
  numParticles: 65536,
  speedFactor: 0.25,
  ageRate: 0.2,
  maxAge: 4,
  trailLength: 12,
};

/**
 * Detect if we should use reduced particle count for mobile/weak devices
 */
function detectParticleCount(): number {
  if (typeof window === 'undefined') return DEFAULT_OPTIONS.numParticles;

  const isMobile = /iPhone|iPad|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
  const isLowEndDevice = navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency < 4
    : false;

  if (isMobile || isLowEndDevice) {
    return 16384; // 16K particles for mobile
  }
  return 65536; // 64K particles for desktop
}

export class ParticleSystem {
  // Particle state arrays
  private positions: Float32Array; // [x0, y0, x1, y1, ...] normalized 0-1
  private ages: Float32Array; // 0 = newborn, 1 = dead
  private speeds: Float32Array; // wind magnitude at particle position
  
  // Trail history: stores last N positions for each particle
  // Format: [p0_t0_x, p0_t0_y, p0_t1_x, p0_t1_y, ..., p1_t0_x, p1_t0_y, ...]
  private trailHistory: Float32Array;
  private trailLength: number;

  // Configuration
  private numParticles: number;
  private speedFactor: number;
  private ageRate: number;
  private maxAge: number;

  // Wind data reference
  private windData: WindData | null = null;

  // Bounding box in degrees (for coordinate conversion)
  private bbox: [number, number, number, number] = [-125, 24, -66, 50]; // CONUS default

  constructor(options: ParticleSystemOptions = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    this.numParticles = opts.numParticles ?? detectParticleCount();
    this.speedFactor = opts.speedFactor;
    this.ageRate = opts.ageRate;
    this.maxAge = opts.maxAge;
    this.trailLength = opts.trailLength;

    // Initialize arrays
    this.positions = new Float32Array(this.numParticles * 2);
    this.ages = new Float32Array(this.numParticles);
    this.speeds = new Float32Array(this.numParticles);
    
    // Trail history: each particle has trailLength positions (x, y pairs)
    this.trailHistory = new Float32Array(this.numParticles * this.trailLength * 2);

    // Randomize initial positions and stagger ages
    this.randomizeAll();
  }

  /**
   * Set wind data for particle advection
   */
  setWindData(windData: WindData): void {
    this.windData = windData;
    // Update bbox from wind data metadata
    this.bbox = windData.uMetadata.bbox;
  }

  /**
   * Get current particle positions as Float32Array
   * Format: [x0, y0, x1, y1, ...] in normalized coordinates (0-1)
   */
  getPositions(): Float32Array {
    return this.positions;
  }

  /**
   * Get particle ages (0 = new, 1 = dead)
   */
  getAges(): Float32Array {
    return this.ages;
  }

  /**
   * Get particle speeds (wind magnitude at each particle)
   */
  getSpeeds(): Float32Array {
    return this.speeds;
  }

  /**
   * Get trail history for all particles
   * Format: [p0_t0_x, p0_t0_y, p0_t1_x, p0_t1_y, ..., p1_t0_x, ...]
   * where t0 is newest position, t(trailLength-1) is oldest
   */
  getTrailHistory(): Float32Array {
    return this.trailHistory;
  }

  /**
   * Get trail length (number of positions per particle)
   */
  getTrailLength(): number {
    return this.trailLength;
  }

  /**
   * Get number of particles
   */
  getParticleCount(): number {
    return this.numParticles;
  }

  /**
   * Get bounding box [west, south, east, north]
   */
  getBbox(): [number, number, number, number] {
    return this.bbox;
  }

  /**
   * Update all particles based on wind field
   *
   * @param dt - Time delta in seconds
   */
  update(dt: number): void {
    if (!this.windData) return;

    const [west, south, east, north] = this.bbox;
    const lngRange = east - west;
    const latRange = north - south;
    const trailStride = this.trailLength * 2; // positions per particle in trail

    for (let i = 0; i < this.numParticles; i++) {
      const idx = i * 2;
      const trailBase = i * trailStride;
      let nx = this.positions[idx];
      let ny = this.positions[idx + 1];

      // Shift trail history (move positions back, newest at front)
      for (let t = this.trailLength - 1; t > 0; t--) {
        const dstIdx = trailBase + t * 2;
        const srcIdx = trailBase + (t - 1) * 2;
        this.trailHistory[dstIdx] = this.trailHistory[srcIdx];
        this.trailHistory[dstIdx + 1] = this.trailHistory[srcIdx + 1];
      }
      // Store current position at front of trail
      this.trailHistory[trailBase] = nx;
      this.trailHistory[trailBase + 1] = ny;

      // Sample wind at current position
      const [u, v] = sampleWind(this.windData, nx, ny);
      const speed = windMagnitude(u, v);
      this.speeds[i] = speed;

      // Convert wind velocity (m/s) to position change
      // Approximate: 1 degree longitude ≈ 111km * cos(lat), 1 degree latitude ≈ 111km
      // We work in normalized coordinates, so divide by range
      const lat = south + ny * latRange;
      const metersPerDegreeLng = 111000 * Math.cos((lat * Math.PI) / 180);
      const metersPerDegreeLat = 111000;

      // Position change in normalized coordinates
      const dx = ((u * dt * this.speedFactor) / metersPerDegreeLng) * (1 / lngRange);
      const dy = ((-v * dt * this.speedFactor) / metersPerDegreeLat) * (1 / latRange);

      // Update position
      nx += dx;
      ny += dy;

      // Age the particle
      this.ages[i] += (dt / this.maxAge) * this.ageRate * (1 + speed * 0.1);

      // Check if particle should be respawned
      const outOfBounds = nx < 0 || nx > 1 || ny < 0 || ny > 1;
      const tooOld = this.ages[i] >= 1;

      if (outOfBounds || tooOld) {
        this.respawnParticle(i);
      } else {
        this.positions[idx] = nx;
        this.positions[idx + 1] = ny;
      }
    }
  }

  /**
   * Respawn a particle at a random position
   */
  private respawnParticle(index: number): void {
    const idx = index * 2;
    const newX = Math.random();
    const newY = Math.random();
    
    this.positions[idx] = newX;
    this.positions[idx + 1] = newY;
    this.ages[index] = 0;
    this.speeds[index] = 0;
    
    // Reset trail history to new position (all trail points at same spot)
    const trailBase = index * this.trailLength * 2;
    for (let t = 0; t < this.trailLength; t++) {
      this.trailHistory[trailBase + t * 2] = newX;
      this.trailHistory[trailBase + t * 2 + 1] = newY;
    }
  }

  /**
   * Randomize all particle positions and stagger ages
   */
  private randomizeAll(): void {
    for (let i = 0; i < this.numParticles; i++) {
      const idx = i * 2;
      const x = Math.random();
      const y = Math.random();
      
      this.positions[idx] = x;
      this.positions[idx + 1] = y;
      // Stagger ages so particles don't all die at once
      this.ages[i] = Math.random();
      this.speeds[i] = 0;
      
      // Initialize trail history to current position
      const trailBase = i * this.trailLength * 2;
      for (let t = 0; t < this.trailLength; t++) {
        this.trailHistory[trailBase + t * 2] = x;
        this.trailHistory[trailBase + t * 2 + 1] = y;
      }
    }
  }

  /**
   * Convert normalized position to longitude/latitude
   */
  normalizedToLngLat(nx: number, ny: number): [number, number] {
    const [west, south, east, north] = this.bbox;
    const lng = west + nx * (east - west);
    const lat = north - ny * (north - south); // Y is inverted
    return [lng, lat];
  }

  /**
   * Convert longitude/latitude to normalized position
   */
  lngLatToNormalized(lng: number, lat: number): [number, number] {
    const [west, south, east, north] = this.bbox;
    const nx = (lng - west) / (east - west);
    const ny = (north - lat) / (north - south); // Y is inverted
    return [nx, ny];
  }
}
