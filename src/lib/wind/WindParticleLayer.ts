/**
 * Wind Particle Layer for MapLibre
 *
 * Renders animated wind particles using the Windy.com technique:
 * - Particles are drawn as points
 * - Trails are created by fading the previous frame (not storing trail history)
 * - Screen buffer accumulates particle positions over time
 * - GPU handles all particle updates via texture ping-pong
 */

import type { Map, CustomLayerInterface } from 'maplibre-gl';
import { type WindData, sampleWind, windMagnitude } from './wind-data';

// ============================================================
// SHADERS
// ============================================================

// Fullscreen quad vertex shader (used by fade and composite)
const QUAD_VERT = `
  attribute vec2 a_position;
  varying vec2 v_texCoord;
  void main() {
    v_texCoord = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// Fade shader - multiplies existing screen by fade factor to create trails
const FADE_FRAG = `
  precision highp float;
  uniform sampler2D u_screen;
  uniform float u_opacity;
  varying vec2 v_texCoord;
  
  void main() {
    vec4 color = texture2D(u_screen, v_texCoord);
    // Use floor to ensure trails eventually fade to zero (prevents infinite accumulation)
    gl_FragColor = floor(color * 255.0 * u_opacity) / 255.0;
  }
`;

// Particle drawing vertex shader
// Two modes: screen-space for framebuffer, or world-space for direct rendering
const DRAW_VERT = `
  precision highp float;
  
  attribute vec2 a_position;  // Particle position in normalized coords (0-1)
  attribute float a_speed;    // Wind speed for coloring
  
  uniform mat4 u_matrix;      // MapLibre projection matrix  
  uniform vec4 u_bbox;        // [west, south, east, north]
  uniform int u_useMatrix;    // 1 = use matrix (direct), 0 = screen space (framebuffer)
  uniform float u_pointSize;  // Point size (adjustable)
  
  varying float v_speed;
  
  void main() {
    // Convert normalized coords to lng/lat
    float lng = u_bbox.x + a_position.x * (u_bbox.z - u_bbox.x);
    float lat = u_bbox.w - a_position.y * (u_bbox.w - u_bbox.y);
    
    // Convert to Web Mercator (0-1 range)
    float mercX = (lng + 180.0) / 360.0;
    float latRad = radians(lat);
    float mercY = (1.0 - log(tan(latRad) + 1.0 / cos(latRad)) / 3.141592653589793) / 2.0;
    
    if (u_useMatrix == 1) {
      // Direct rendering: project through MapLibre's matrix
      gl_Position = u_matrix * vec4(mercX, mercY, 0.0, 1.0);
    } else {
      // Framebuffer rendering: use normalized coords directly as screen space
      // Map 0-1 to -1 to 1 (clip space)
      gl_Position = vec4(a_position.x * 2.0 - 1.0, 1.0 - a_position.y * 2.0, 0.0, 1.0);
    }
    
    gl_PointSize = u_pointSize;
    v_speed = a_speed;
  }
`;

// Particle drawing fragment shader
const DRAW_FRAG = `
  precision highp float;
  
  varying float v_speed;
  uniform float u_maxSpeed;
  uniform float u_brightness;  // Controls particle color intensity (0-1)
  
  // NOAA wind speed color ramp
  // Light cyan -> Green -> Yellow -> Orange -> Red -> Purple -> Magenta
  vec3 speedToColor(float t) {
    vec3 c0 = vec3(0.75, 0.95, 1.0);  // Light cyan (calm)
    vec3 c1 = vec3(0.5, 0.9, 0.5);    // Light green
    vec3 c2 = vec3(0.2, 0.8, 0.2);    // Green
    vec3 c3 = vec3(0.7, 0.9, 0.2);    // Yellow-green
    vec3 c4 = vec3(1.0, 1.0, 0.2);    // Yellow
    vec3 c5 = vec3(1.0, 0.7, 0.0);    // Orange
    vec3 c6 = vec3(1.0, 0.3, 0.0);    // Red-orange
    vec3 c7 = vec3(0.8, 0.0, 0.0);    // Dark red
    vec3 c8 = vec3(0.6, 0.0, 0.4);    // Purple
    vec3 c9 = vec3(0.8, 0.2, 0.8);    // Magenta
    
    t = clamp(t, 0.0, 1.0);
    
    // 10 colors = 9 segments
    if (t < 0.111) return mix(c0, c1, t / 0.111);
    if (t < 0.222) return mix(c1, c2, (t - 0.111) / 0.111);
    if (t < 0.333) return mix(c2, c3, (t - 0.222) / 0.111);
    if (t < 0.444) return mix(c3, c4, (t - 0.333) / 0.111);
    if (t < 0.556) return mix(c4, c5, (t - 0.444) / 0.112);
    if (t < 0.667) return mix(c5, c6, (t - 0.556) / 0.111);
    if (t < 0.778) return mix(c6, c7, (t - 0.667) / 0.111);
    if (t < 0.889) return mix(c7, c8, (t - 0.778) / 0.111);
    return mix(c8, c9, (t - 0.889) / 0.111);
  }
  
  void main() {
    float t = v_speed / u_maxSpeed;
    vec3 color = speedToColor(t);
    // Use brightness as alpha so particles become transparent instead of black
    gl_FragColor = vec4(color, u_brightness);
  }
`;

// Line vertex shader for trail segments
const LINE_VERT = `
  precision highp float;
  
  attribute vec2 a_position;  // Vertex position in normalized coords (0-1)
  attribute float a_speed;    // Wind speed for coloring
  attribute float a_alpha;    // Alpha for fading (1.0 = head, 0.0 = tail)
  
  uniform mat4 u_matrix;
  uniform vec4 u_bbox;        // [west, south, east, north]
  
  varying float v_speed;
  varying float v_alpha;
  
  void main() {
    // Convert normalized coords to lng/lat
    float lng = u_bbox.x + a_position.x * (u_bbox.z - u_bbox.x);
    float lat = u_bbox.w - a_position.y * (u_bbox.w - u_bbox.y);
    
    // Convert to Web Mercator (0-1 range)
    float mercX = (lng + 180.0) / 360.0;
    float latRad = radians(lat);
    float mercY = (1.0 - log(tan(latRad) + 1.0 / cos(latRad)) / 3.141592653589793) / 2.0;
    
    gl_Position = u_matrix * vec4(mercX, mercY, 0.0, 1.0);
    
    v_speed = a_speed;
    v_alpha = a_alpha;
  }
`;

// Line fragment shader
const LINE_FRAG = `
  precision highp float;
  
  varying float v_speed;
  varying float v_alpha;
  uniform float u_maxSpeed;
  uniform float u_brightness;  // Controls particle color intensity (0-1)
  
  // NOAA wind speed color ramp (same as DRAW_FRAG)
  vec3 speedToColor(float t) {
    vec3 c0 = vec3(0.75, 0.95, 1.0);  // Light cyan (calm)
    vec3 c1 = vec3(0.5, 0.9, 0.5);    // Light green
    vec3 c2 = vec3(0.2, 0.8, 0.2);    // Green
    vec3 c3 = vec3(0.7, 0.9, 0.2);    // Yellow-green
    vec3 c4 = vec3(1.0, 1.0, 0.2);    // Yellow
    vec3 c5 = vec3(1.0, 0.7, 0.0);    // Orange
    vec3 c6 = vec3(1.0, 0.3, 0.0);    // Red-orange
    vec3 c7 = vec3(0.8, 0.0, 0.0);    // Dark red
    vec3 c8 = vec3(0.6, 0.0, 0.4);    // Purple
    vec3 c9 = vec3(0.8, 0.2, 0.8);    // Magenta
    
    t = clamp(t, 0.0, 1.0);
    
    if (t < 0.111) return mix(c0, c1, t / 0.111);
    if (t < 0.222) return mix(c1, c2, (t - 0.111) / 0.111);
    if (t < 0.333) return mix(c2, c3, (t - 0.222) / 0.111);
    if (t < 0.444) return mix(c3, c4, (t - 0.333) / 0.111);
    if (t < 0.556) return mix(c4, c5, (t - 0.444) / 0.112);
    if (t < 0.667) return mix(c5, c6, (t - 0.556) / 0.111);
    if (t < 0.778) return mix(c6, c7, (t - 0.667) / 0.111);
    if (t < 0.889) return mix(c7, c8, (t - 0.778) / 0.111);
    return mix(c8, c9, (t - 0.889) / 0.111);
  }
  
  void main() {
    float t = v_speed / u_maxSpeed;
    vec3 color = speedToColor(t);
    // Multiply existing alpha by brightness so particles become transparent
    gl_FragColor = vec4(color, v_alpha * u_brightness);
  }
`;

// Composite shader - blends trail buffer over map
const COMPOSITE_FRAG = `
  precision highp float;
  uniform sampler2D u_screen;
  uniform float u_opacity;
  varying vec2 v_texCoord;
  
  void main() {
    vec4 color = texture2D(u_screen, v_texCoord);
    gl_FragColor = vec4(color.rgb, color.a * u_opacity);
  }
`;

// ============================================================
// CONFIGURATION
// ============================================================

export interface WindParticleLayerOptions {
  id?: string;
  numParticles?: number;
  fadeOpacity?: number;    // 0.97 = long trails, 0.9 = short trails
  speedFactor?: number;
  dropRate?: number;       // Random respawn rate
  dropRateBump?: number;   // Extra respawn in slow wind
  maxSpeed?: number;
  opacity?: number;
  brightness?: number;     // 0.0 - 1.0, controls particle color intensity
}

const DEFAULT_CONFIG = {
  numParticles: 4000,
  fadeOpacity: 0.934,    // Trail length - higher = longer trails
  speedFactor: 0.4,      // Particle movement speed
  dropRate: 0.008,       // Respawn rate
  dropRateBump: 0.01,
  maxSpeed: 30,
  opacity: 1.0,
  pointSize: 4.5,        // Particle size in pixels
  brightness: 0.80,      // Opacity (0-1), lower = more transparent particles
};

// ============================================================
// MAIN CLASS
// ============================================================

export class WindParticleLayer implements CustomLayerInterface {
  id: string;
  type: 'custom' = 'custom';
  renderingMode: '2d' = '2d';

  private map: Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  
  // Programs
  private fadeProgram: WebGLProgram | null = null;
  private drawProgram: WebGLProgram | null = null;
  private lineProgram: WebGLProgram | null = null;  // For trail lines
  private compositeProgram: WebGLProgram | null = null;
  
  // Buffers
  private quadBuffer: WebGLBuffer | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private speedBuffer: WebGLBuffer | null = null;
  private lineBuffer: WebGLBuffer | null = null;     // For trail line vertices
  private lineSpeedBuffer: WebGLBuffer | null = null;
  private lineAlphaBuffer: WebGLBuffer | null = null;
  
  // Textures for trail effect (ping-pong)
  private screenTexture0: WebGLTexture | null = null;
  private screenTexture1: WebGLTexture | null = null;
  private framebuffer0: WebGLFramebuffer | null = null;
  private framebuffer1: WebGLFramebuffer | null = null;
  private currentScreen = 0;
  
  // Particle state (CPU-side for simplicity with MapLibre integration)
  private positions: Float32Array;
  private prevPositions: Float32Array;  // Previous positions for trail lines
  private speeds: Float32Array;
  
  // Wind data
  private windData: WindData | null = null;
  private bbox: [number, number, number, number] = [-125, 24, -66, 50];
  
  // Config
  private config: typeof DEFAULT_CONFIG;
  private numParticles: number;
  
  // State
  private animating = true;
  private lastTime = 0;
  private textureSize = { width: 0, height: 0 };
  private lastMatrix: Float32Array | null = null;  // Track camera for clearing trails on pan/zoom

  constructor(options: WindParticleLayerOptions = {}) {
    this.id = options.id ?? 'wind-particles';
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.numParticles = this.config.numParticles;
    
    // Initialize particle arrays
    this.positions = new Float32Array(this.numParticles * 2);
    this.prevPositions = new Float32Array(this.numParticles * 2);
    this.speeds = new Float32Array(this.numParticles);
    
    // Random initial positions
    for (let i = 0; i < this.numParticles; i++) {
      const x = Math.random();
      const y = Math.random();
      this.positions[i * 2] = x;
      this.positions[i * 2 + 1] = y;
      this.prevPositions[i * 2] = x;
      this.prevPositions[i * 2 + 1] = y;
      this.speeds[i] = 0;
    }
  }

  setWindData(windData: WindData): void {
    this.windData = windData;
    this.bbox = windData.uMetadata.bbox;
  }
  
  /** Update speed factor at runtime */
  setSpeedFactor(speedFactor: number): void {
    this.config.speedFactor = speedFactor;
  }
  
  /** Get current speed factor */
  getSpeedFactor(): number {
    return this.config.speedFactor;
  }
  
  /** Update fade opacity at runtime (controls trail length) */
  setFadeOpacity(fadeOpacity: number): void {
    this.config.fadeOpacity = fadeOpacity;
  }
  
  /** Update point size at runtime */
  private pointSize = DEFAULT_CONFIG.pointSize;
  setPointSize(size: number): void {
    this.pointSize = size;
  }

  /** Update drop rate at runtime */
  setDropRate(dropRate: number): void {
    this.config.dropRate = dropRate;
  }

  /** Update brightness at runtime (0-1, controls opacity) */
  private brightness = DEFAULT_CONFIG.brightness;
  setBrightness(brightness: number): void {
    this.brightness = Math.max(0, Math.min(1, brightness));
  }
  
  /** Get current brightness */
  getBrightness(): number {
    return this.brightness;
  }

  // Track if map is currently moving (pan/zoom)
  private isMapMoving = false;
  private moveStartHandler: (() => void) | null = null;
  private moveEndHandler: (() => void) | null = null;

  onAdd(map: Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.gl = gl;
    
    // Create shader programs
    this.fadeProgram = this.createProgram(gl, QUAD_VERT, FADE_FRAG);
    this.drawProgram = this.createProgram(gl, DRAW_VERT, DRAW_FRAG);
    this.lineProgram = this.createProgram(gl, LINE_VERT, LINE_FRAG);
    this.compositeProgram = this.createProgram(gl, QUAD_VERT, COMPOSITE_FRAG);
    
    // Create quad buffer for fullscreen passes
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1
    ]), gl.STATIC_DRAW);
    
    // Create particle buffers
    this.positionBuffer = gl.createBuffer();
    this.speedBuffer = gl.createBuffer();
    
    // Create line buffers for trails
    this.lineBuffer = gl.createBuffer();
    this.lineSpeedBuffer = gl.createBuffer();
    this.lineAlphaBuffer = gl.createBuffer();
    
    // Create screen textures for trail effect
    this.createScreenTextures(gl);
    
    // Listen for map movement to pause rendering during pan/zoom
    this.moveStartHandler = () => {
      this.isMapMoving = true;
    };
    this.moveEndHandler = () => {
      this.isMapMoving = false;
      // Clear trail buffer when movement ends to avoid stale trails
      if (this.gl) {
        this.clearTrailBuffer(this.gl);
      }
      // Resume animation
      this.map?.triggerRepaint();
    };
    map.on('movestart', this.moveStartHandler);
    map.on('moveend', this.moveEndHandler);
    
    this.lastTime = performance.now();
    
    console.log(`Wind layer initialized: ${this.numParticles} particles, fade=${this.config.fadeOpacity}`);
  }

  private createScreenTextures(gl: WebGLRenderingContext): void {
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    
    this.textureSize = { width, height };
    
    // Create two textures for ping-pong
    this.screenTexture0 = this.createTexture(gl, width, height);
    this.screenTexture1 = this.createTexture(gl, width, height);
    
    // Create framebuffers
    this.framebuffer0 = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.screenTexture0, 0);
    
    this.framebuffer1 = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer1);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.screenTexture1, 0);
    
    // Clear both framebuffers
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private createTexture(gl: WebGLRenderingContext, width: number, height: number): WebGLTexture {
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return texture;
  }

  onRemove(): void {
    this.animating = false;
    
    // Remove map event listeners
    if (this.map) {
      if (this.moveStartHandler) this.map.off('movestart', this.moveStartHandler);
      if (this.moveEndHandler) this.map.off('moveend', this.moveEndHandler);
    }
    
    if (this.gl) {
      const gl = this.gl;
      if (this.fadeProgram) gl.deleteProgram(this.fadeProgram);
      if (this.drawProgram) gl.deleteProgram(this.drawProgram);
      if (this.compositeProgram) gl.deleteProgram(this.compositeProgram);
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.speedBuffer) gl.deleteBuffer(this.speedBuffer);
      if (this.screenTexture0) gl.deleteTexture(this.screenTexture0);
      if (this.screenTexture1) gl.deleteTexture(this.screenTexture1);
      if (this.framebuffer0) gl.deleteFramebuffer(this.framebuffer0);
      if (this.framebuffer1) gl.deleteFramebuffer(this.framebuffer1);
    }
    
    this.map = null;
    this.gl = null;
  }

  private renderCount = 0;

  render(gl: WebGLRenderingContext, matrix: ArrayLike<number>): void {
    if (!this.animating || !this.drawProgram || !this.fadeProgram || !this.compositeProgram) {
      if (this.renderCount === 0) console.log("Wind render: missing programs or not animating");
      return;
    }
    if (!this.windData) {
      if (this.renderCount === 0) console.log("Wind render: no wind data");
      return;
    }

    // Skip rendering while map is panning/zooming
    if (this.isMapMoving) return;

    this.renderCount++;
    if (this.renderCount === 1 || this.renderCount % 120 === 0) {
      console.log(`Wind render frame ${this.renderCount}, canvas: ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`);
    }

    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    // Check if canvas size changed
    if (gl.drawingBufferWidth !== this.textureSize.width ||
        gl.drawingBufferHeight !== this.textureSize.height) {
      this.createScreenTextures(gl);
    }

    // 1. Update particle positions (CPU-side)
    this.updateParticles(dt);

    // 2. Convert particle positions to screen coordinates for this frame
    this.computeScreenPositions(matrix);

    // 3. WINDY TECHNIQUE:
    //    a) Fade the trail buffer (multiply by fadeOpacity) - old positions fade out
    //    b) Draw particles as points onto the trail buffer (screen space)
    //    c) Composite trail buffer onto MapLibre's canvas

    this.fadeTrailBuffer(gl);
    this.drawParticlesToTrailBuffer(gl);
    this.compositeTrailsToScreen(gl);

    // Request next frame
    if (this.map && this.animating) {
      this.map.triggerRepaint();
    }
  }
  
  // Screen-space positions computed each frame
  private screenPositions: Float32Array | null = null;
  
  /** Convert particle world positions to screen positions using current matrix */
  private computeScreenPositions(matrix: ArrayLike<number>): void {
    if (!this.screenPositions || this.screenPositions.length !== this.positions.length) {
      this.screenPositions = new Float32Array(this.positions.length);
    }
    
    const [west, south, east, north] = this.bbox;
    
    for (let i = 0; i < this.numParticles; i++) {
      const idx = i * 2;
      const nx = this.positions[idx];
      const ny = this.positions[idx + 1];
      
      // Convert normalized coords to lng/lat
      const lng = west + nx * (east - west);
      const lat = north - ny * (north - south);
      
      // Convert to Web Mercator (0-1 range)
      const mercX = (lng + 180) / 360;
      const latRad = lat * Math.PI / 180;
      const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
      
      // Apply MapLibre's matrix to get clip space coordinates
      const x = mercX * matrix[0] + mercY * matrix[4] + matrix[12];
      const y = mercX * matrix[1] + mercY * matrix[5] + matrix[13];
      const w = mercX * matrix[3] + mercY * matrix[7] + matrix[15];
      
      // Perspective divide to get NDC (-1 to 1)
      const ndcX = x / w;
      const ndcY = y / w;
      
      // Convert to screen space (0-1) for our framebuffer
      this.screenPositions[idx] = (ndcX + 1) / 2;
      this.screenPositions[idx + 1] = (1 - ndcY) / 2;  // Flip Y
    }
  }
  
  /** Fade the trail buffer - this creates the trail effect */
  private fadeTrailBuffer(gl: WebGLRenderingContext): void {
    const srcTexture = this.currentScreen === 0 ? this.screenTexture0 : this.screenTexture1;
    const dstFramebuffer = this.currentScreen === 0 ? this.framebuffer1 : this.framebuffer0;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFramebuffer);
    gl.viewport(0, 0, this.textureSize.width, this.textureSize.height);
    gl.disable(gl.BLEND);
    
    gl.useProgram(this.fadeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexture);
    gl.uniform1i(gl.getUniformLocation(this.fadeProgram!, 'u_screen'), 0);
    gl.uniform1f(gl.getUniformLocation(this.fadeProgram!, 'u_opacity'), this.config.fadeOpacity);
    
    this.drawQuad(gl, this.fadeProgram!);
    
    // Swap buffers
    this.currentScreen = 1 - this.currentScreen;
  }
  
  /** Draw particles onto trail buffer in screen space */
  private drawParticlesToTrailBuffer(gl: WebGLRenderingContext): void {
    if (!this.screenPositions) return;
    
    const dstFramebuffer = this.currentScreen === 0 ? this.framebuffer0 : this.framebuffer1;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFramebuffer);
    gl.viewport(0, 0, this.textureSize.width, this.textureSize.height);
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    gl.useProgram(this.drawProgram);
    
    // Upload screen-space positions
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.screenPositions, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(this.drawProgram!, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.speedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.speeds, gl.DYNAMIC_DRAW);
    const speedLoc = gl.getAttribLocation(this.drawProgram!, 'a_speed');
    gl.enableVertexAttribArray(speedLoc);
    gl.vertexAttribPointer(speedLoc, 1, gl.FLOAT, false, 0, 0);
    
    // Use screen-space mode (u_useMatrix = 0)
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, 'u_useMatrix'), 0);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_maxSpeed'), this.config.maxSpeed);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_pointSize'), this.pointSize);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_brightness'), this.brightness);
    // bbox not needed in screen space mode, but set dummy values
    gl.uniform4f(gl.getUniformLocation(this.drawProgram!, 'u_bbox'), 0, 0, 1, 1);
    
    gl.drawArrays(gl.POINTS, 0, this.numParticles);
    
    gl.disableVertexAttribArray(posLoc);
    gl.disableVertexAttribArray(speedLoc);
    gl.disable(gl.BLEND);
  }
  
  /** Composite trail buffer onto MapLibre's canvas */
  private compositeTrailsToScreen(gl: WebGLRenderingContext): void {
    const srcTexture = this.currentScreen === 0 ? this.screenTexture0 : this.screenTexture1;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    gl.useProgram(this.compositeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram!, 'u_screen'), 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram!, 'u_opacity'), this.config.opacity);
    
    this.drawQuad(gl, this.compositeProgram!);
    
    gl.disable(gl.BLEND);
  }
  
  /** Draw particles directly to MapLibre's canvas */
  private drawParticlesDirect(gl: WebGLRenderingContext, matrix: ArrayLike<number>): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    gl.useProgram(this.drawProgram);
    
    // Upload particle data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(this.drawProgram!, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.speedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.speeds, gl.DYNAMIC_DRAW);
    const speedLoc = gl.getAttribLocation(this.drawProgram!, 'a_speed');
    gl.enableVertexAttribArray(speedLoc);
    gl.vertexAttribPointer(speedLoc, 1, gl.FLOAT, false, 0, 0);
    
    // Set uniforms - use matrix mode for direct rendering
    gl.uniformMatrix4fv(gl.getUniformLocation(this.drawProgram!, 'u_matrix'), false, matrix as Float32Array);
    gl.uniform4f(gl.getUniformLocation(this.drawProgram!, 'u_bbox'), 
      this.bbox[0], this.bbox[1], this.bbox[2], this.bbox[3]);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_maxSpeed'), this.config.maxSpeed);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_brightness'), this.brightness);
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, 'u_useMatrix'), 1);  // Use MapLibre's matrix
    
    gl.drawArrays(gl.POINTS, 0, this.numParticles);
    
    gl.disableVertexAttribArray(posLoc);
    gl.disableVertexAttribArray(speedLoc);
    gl.disable(gl.BLEND);
  }
  
  /** Fade the previous frame - this is what creates trails */
  private fadeScreen(gl: WebGLRenderingContext): void {
    // Read from current texture, write faded version to other texture
    const srcTexture = this.currentScreen === 0 ? this.screenTexture0 : this.screenTexture1;
    const dstFramebuffer = this.currentScreen === 0 ? this.framebuffer1 : this.framebuffer0;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFramebuffer);
    gl.viewport(0, 0, this.textureSize.width, this.textureSize.height);
    
    // Disable blending - we want to replace, not blend
    gl.disable(gl.BLEND);
    
    gl.useProgram(this.fadeProgram);
    
    // Bind source texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexture);
    gl.uniform1i(gl.getUniformLocation(this.fadeProgram!, 'u_screen'), 0);
    gl.uniform1f(gl.getUniformLocation(this.fadeProgram!, 'u_opacity'), this.config.fadeOpacity);
    
    // Draw fullscreen quad to apply fade
    this.drawQuad(gl, this.fadeProgram!);
    
    // Swap: now the "current" buffer is the one we just wrote to
    this.currentScreen = 1 - this.currentScreen;
  }
  
  /** Draw particles onto the trail buffer in screen space */
  private drawParticlesToBuffer(gl: WebGLRenderingContext, matrix: ArrayLike<number>): void {
    // Draw to current framebuffer (the one we just faded into)
    const dstFramebuffer = this.currentScreen === 0 ? this.framebuffer0 : this.framebuffer1;
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFramebuffer);
    gl.viewport(0, 0, this.textureSize.width, this.textureSize.height);
    
    // Enable blending so particles appear on top of faded trails
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    gl.useProgram(this.drawProgram);
    
    // Upload particle data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(this.drawProgram!, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.speedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.speeds, gl.DYNAMIC_DRAW);
    const speedLoc = gl.getAttribLocation(this.drawProgram!, 'a_speed');
    gl.enableVertexAttribArray(speedLoc);
    gl.vertexAttribPointer(speedLoc, 1, gl.FLOAT, false, 0, 0);
    
    // Set uniforms - use screen space mode for framebuffer
    gl.uniformMatrix4fv(gl.getUniformLocation(this.drawProgram!, 'u_matrix'), false, matrix as Float32Array);
    gl.uniform4f(gl.getUniformLocation(this.drawProgram!, 'u_bbox'), 
      this.bbox[0], this.bbox[1], this.bbox[2], this.bbox[3]);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_maxSpeed'), this.config.maxSpeed);
    gl.uniform1f(gl.getUniformLocation(this.drawProgram!, 'u_brightness'), this.brightness);
    gl.uniform1i(gl.getUniformLocation(this.drawProgram!, 'u_useMatrix'), 0);  // Screen space
    
    // Draw points
    gl.drawArrays(gl.POINTS, 0, this.numParticles);
    
    gl.disableVertexAttribArray(posLoc);
    gl.disableVertexAttribArray(speedLoc);
    gl.disable(gl.BLEND);
  }
  
  /** Composite the trail buffer onto MapLibre's canvas */
  private compositeToScreen(gl: WebGLRenderingContext): void {
    const srcTexture = this.currentScreen === 0 ? this.screenTexture0 : this.screenTexture1;
    
    // Draw to MapLibre's canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    
    // Enable blending to overlay trails on top of the map
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    
    gl.useProgram(this.compositeProgram);
    
    // Bind trail texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram!, 'u_screen'), 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram!, 'u_opacity'), this.config.opacity);
    
    // Draw fullscreen quad
    this.drawQuad(gl, this.compositeProgram!);
    
    gl.disable(gl.BLEND);
  }
  
  /** Helper to draw a fullscreen quad */
  private drawQuad(gl: WebGLRenderingContext, program: WebGLProgram): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(posLoc);
  }
  
  private hasMatrixChanged(matrix: ArrayLike<number>): boolean {
    if (!this.lastMatrix) {
      this.lastMatrix = new Float32Array(matrix);
      return false;  // First frame, don't clear
    }
    
    // Check if matrix has changed significantly (camera moved)
    // Use a larger threshold to avoid false positives from floating point jitter
    let maxDiff = 0;
    for (let i = 0; i < 16; i++) {
      const diff = Math.abs(this.lastMatrix[i] - matrix[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    
    // Only consider it changed if there's significant movement
    // Matrix values can be large (1e7+), so use relative threshold
    const changed = maxDiff > 1e-6;
    
    // Update stored matrix
    if (changed) {
      for (let i = 0; i < 16; i++) {
        this.lastMatrix[i] = matrix[i];
      }
    }
    
    return changed;
  }
  
  private clearTrailBuffer(gl: WebGLRenderingContext): void {
    // Clear both framebuffers to remove stale trails
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private debugCounter = 0;
  
  private updateParticles(dt: number): void {
    if (!this.windData) return;
    
    const { speedFactor, dropRate, dropRateBump } = this.config;
    
    // DEBUG: Log every 60 frames
    const shouldLog = this.debugCounter++ % 60 === 0;
    
    for (let i = 0; i < this.numParticles; i++) {
      const idx = i * 2;
      
      // Save previous position for trail rendering
      this.prevPositions[idx] = this.positions[idx];
      this.prevPositions[idx + 1] = this.positions[idx + 1];
      
      let x = this.positions[idx];
      let y = this.positions[idx + 1];
      
      // Sample wind
      const [u, v] = sampleWind(this.windData, x, y);
      const speed = windMagnitude(u, v);
      this.speeds[i] = speed;
      
      // Simplified movement calculation like Windy:
      // Normalize wind to screen space directly
      // Wind in m/s, we want movement as fraction of screen per frame
      // Typical max wind ~30 m/s should move noticeably
      // speedFactor controls overall speed, divide by reference speed (e.g. 100)
      const dx = (u / 100.0) * dt * speedFactor;
      const dy = (-v / 100.0) * dt * speedFactor;  // Negative because y increases downward in texture coords
      
      // DEBUG: Log first particle's wind data (disabled for performance)
      // if (shouldLog && i === 0) {
      //   console.log(`Particle 0: pos=(${x.toFixed(3)}, ${y.toFixed(3)}), wind=(${u.toFixed(2)}, ${v.toFixed(2)}) m/s, speed=${speed.toFixed(2)}`);
      // }
      
      x += dx;
      y += dy;
      
      // Respawn logic
      const outOfBounds = x < 0 || x > 1 || y < 0 || y > 1;
      const randomDrop = Math.random() < (dropRate + speed * dropRateBump * 0.01);
      
      if (outOfBounds || randomDrop) {
        x = Math.random();
        y = Math.random();
      }
      
      this.positions[idx] = x;
      this.positions[idx + 1] = y;
    }
  }

  private createProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
    const vert = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vert));
      return null;
    }
    
    const frag = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(frag));
      return null;
    }
    
    const program = gl.createProgram()!;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    
    return program;
  }

  start(): void {
    this.animating = true;
    this.lastTime = performance.now();
    this.map?.triggerRepaint();
  }

  pause(): void {
    this.animating = false;
  }

  isAnimating(): boolean {
    return this.animating;
  }
}
