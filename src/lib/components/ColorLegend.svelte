<script lang="ts">
  import {
    colorScaleToGradient,
    getColorForValue,
    TEMPERATURE_SCALE,
    type ColorScale,
    type ColorStop,
    rgbToCSS,
  } from "../visualization/color-scales";
  import { kelvinToFahrenheit, kelvinToCelsius } from "../data/edr-client";

  interface Props {
    min: number;
    max: number;
    units?: string;
    scale?: ColorScale;
    preferredUnit?: 'F' | 'C';  // Preferred temperature unit (for Kelvin data)
    dataMin?: number;  // Full data range min (for normalization)
    dataMax?: number;  // Full data range max (for normalization)
    onScaleChange?: (newScale: ColorScale) => void;  // Callback when color picker is closed (apply to all frames)
    onScalePreview?: (newScale: ColorScale) => void;  // Callback for real-time preview while picking
  }

  let { min, max, units = "K", scale = TEMPERATURE_SCALE, preferredUnit = 'F', dataMin, dataMax, onScaleChange, onScalePreview }: Props = $props();

  // Edit mode state
  let editMode = $state(false);
  let popoverAnchor: HTMLDivElement;

  // Color input refs (one per stop)
  let colorInputs: HTMLInputElement[] = [];

  // Absolute temperature ranges for consistent color mapping
  // These define what temperatures map to 0.0-1.0 on the color scale
  const TEMP_SCALE_RANGES = {
    F: { min: -20, max: 110 },  // -20°F (very cold) to 110°F (very hot)
    C: { min: -29, max: 43 },   // -29°C to 43°C (equivalent range)
  };

  // Generate CSS gradient for the legend bar
  // Maps colors based on absolute temperature values, not relative to visible range
  let gradient = $derived.by(() => {
    // Convert min/max to display units for absolute temperature mapping
    const displayMin = convertValue(min);
    const displayMax = convertValue(max);
    
    // Get absolute temperature range for the unit
    const isKelvin = units === 'K';
    const unit = isKelvin ? preferredUnit : 'F';
    const absRange = TEMP_SCALE_RANGES[unit];
    
    // Map display temps to 0-1 scale positions
    const absMin = absRange.min;
    const absMax = absRange.max;
    const fullRange = absMax - absMin;
    
    const minPos = Math.max(0, Math.min(1, (displayMin - absMin) / fullRange));
    const maxPos = Math.max(0, Math.min(1, (displayMax - absMin) / fullRange));
    
    // Generate gradient with color stops for the visible temperature range
    const stops: string[] = [];
    const numStops = 20;
    
    for (let i = 0; i <= numStops; i++) {
      const t = i / numStops;
      // Map gradient position to absolute temperature scale
      const absValue = minPos + (maxPos - minPos) * t;
      const [r, g, b] = getColorForValue(absValue, scale);
      stops.push(`${rgbToCSS(r, g, b)} ${t * 100}%`);
    }
    
    return `linear-gradient(to right, ${stops.join(", ")})`;
  });

  // Convert temperature values if needed
  function convertValue(value: number): number {
    if (units === 'K') {
      return preferredUnit === 'F' ? kelvinToFahrenheit(value) : kelvinToCelsius(value);
    }
    return value;
  }

  // Get display unit symbol
  function getDisplayUnit(): string {
    if (units === 'K') {
      return `°${preferredUnit}`;
    }
    return units;
  }

  function formatValue(value: number): string {
    return convertValue(value).toFixed(0);
  }

  // Get color stops with their actual data values
  let colorStopsWithValues = $derived.by(() => {
    // Use dataMin/dataMax if provided, otherwise use visible min/max
    const rangeMin = dataMin ?? min;
    const rangeMax = dataMax ?? max;
    const range = rangeMax - rangeMin;

    return scale.map(([position, r, g, b]) => {
      // Convert normalized position to actual data value
      const rawValue = rangeMin + position * range;
      const displayValue = convertValue(rawValue);

      return {
        position,
        color: rgbToCSS(r, g, b),
        rawValue,
        displayValue,
        r, g, b
      };
    });
  });

  function toggleEditMode(event?: MouseEvent) {
    event?.stopPropagation();
    editMode = !editMode;
  }

  function handleClickOutside(event: MouseEvent) {
    if (editMode && popoverAnchor && !popoverAnchor.contains(event.target as Node)) {
      editMode = false;
    }
  }

  function formatStopValue(value: number): string {
    // Format based on the magnitude
    if (Math.abs(value) >= 100) {
      return value.toFixed(0);
    } else if (Math.abs(value) >= 10) {
      return value.toFixed(1);
    } else {
      return value.toFixed(2);
    }
  }

  // Convert RGB to hex color string for color input
  function rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // Convert hex color string to RGB
  function hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16)
      ];
    }
    return [0, 0, 0];
  }

  // Handle clicking on a color swatch
  function handleSwatchClick(index: number) {
    colorInputs[index]?.click();
  }

  // Create a new scale with a color changed at a specific index
  function createUpdatedScale(index: number, hexColor: string): ColorScale {
    const [r, g, b] = hexToRgb(hexColor);
    return scale.map((stop, i) => {
      if (i === index) {
        return [stop[0], r, g, b] as ColorStop;
      }
      return stop;
    });
  }

  // Handle real-time preview while color picker is open (oninput)
  function handleColorPreview(index: number, event: Event) {
    const input = event.target as HTMLInputElement;
    const newScale = createUpdatedScale(index, input.value);
    // Preview only updates current frame, not all animation frames
    onScalePreview?.(newScale);
  }

  // Handle final color change when picker is closed (onchange)
  function handleColorChange(index: number, event: Event) {
    const input = event.target as HTMLInputElement;
    const newScale = createUpdatedScale(index, input.value);
    // Final change - apply to all frames
    onScaleChange?.(newScale);
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="color-legend" class:color-legend--editing={editMode} bind:this={popoverAnchor}>
  {#if !editMode}
    <!-- Normal view -->
    <button
      class="color-legend__bar-btn"
      onclick={(e) => toggleEditMode(e)}
      title="Click to edit colors"
    >
      <div class="color-legend__bar" style="background: {gradient}"></div>
    </button>
    <div class="color-legend__labels">
      <span class="color-legend__label">{formatValue(min)}{getDisplayUnit()}</span>
      <span class="color-legend__label">{formatValue(max)}{getDisplayUnit()}</span>
    </div>
  {:else}
    <!-- Edit mode -->
    <div class="color-legend__edit-header">
      <span class="color-legend__edit-title">Edit Colors</span>
      <button class="color-legend__edit-close" onclick={(e) => toggleEditMode(e)} title="Done editing">&times;</button>
    </div>
    <div class="color-legend__stops-bar">
      {#each colorStopsWithValues as stop, index}
        {@const nextStop = colorStopsWithValues[index + 1]}
        {@const width = nextStop ? (nextStop.position - stop.position) * 100 : (1 - stop.position) * 100}
        <button
          class="color-legend__stop-segment"
          style="width: {width}%; background: {stop.color};"
          onclick={() => handleSwatchClick(index)}
          title="{formatStopValue(stop.displayValue)}{getDisplayUnit()} ({(stop.position * 100).toFixed(0)}%)"
        >
          <span class="color-legend__stop-marker"></span>
        </button>
        <input
          type="color"
          class="color-legend__color-input"
          value={rgbToHex(stop.r, stop.g, stop.b)}
          oninput={(e) => handleColorPreview(index, e)}
          onchange={(e) => handleColorChange(index, e)}
          bind:this={colorInputs[index]}
        />
      {/each}
    </div>
    <div class="color-legend__labels">
      <span class="color-legend__label">{formatStopValue(colorStopsWithValues[0]?.displayValue ?? 0)}{getDisplayUnit()}</span>
      <span class="color-legend__label">{formatStopValue(colorStopsWithValues[colorStopsWithValues.length - 1]?.displayValue ?? 0)}{getDisplayUnit()}</span>
    </div>
  {/if}
</div>

<style>
  .color-legend {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    padding: var(--spacing-sm);
    background: var(--color-card);
    border-radius: var(--radius-md);
    box-shadow: 0 2px 4px var(--color-card-shadow);
    min-width: 200px;
    transition: width 0.15s ease, box-shadow 0.15s ease;
  }

  .color-legend--editing {
    width: 200%;
    box-shadow: 0 4px 12px var(--color-card-shadow);
  }

  .color-legend__bar-btn {
    display: block;
    width: 100%;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    transition: transform 0.1s ease;
  }

  .color-legend__bar-btn:hover {
    transform: scaleY(1.2);
  }

  .color-legend__bar-btn:focus {
    outline: 2px solid var(--color-accent, rgb(78, 179, 211));
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }

  .color-legend__bar {
    height: 16px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--color-card-border);
  }

  .color-legend__labels {
    display: flex;
    justify-content: space-between;
  }

  .color-legend__label {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  /* Edit mode header */
  .color-legend__edit-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-xs);
  }

  .color-legend__edit-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .color-legend__edit-close {
    background: none;
    border: none;
    color: var(--color-text-secondary);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .color-legend__edit-close:hover {
    color: var(--color-text);
  }

  .color-legend__stops-bar {
    display: flex;
    height: 24px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--color-card-border);
  }

  .color-legend__stop-segment {
    position: relative;
    height: 100%;
    border: none;
    padding: 0;
    cursor: pointer;
    transition: filter 0.1s ease, transform 0.1s ease;
    min-width: 8px;
  }

  .color-legend__stop-segment:hover {
    filter: brightness(1.2);
    z-index: 1;
  }

  .color-legend__stop-segment:focus {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--color-accent, rgb(78, 179, 211));
    z-index: 2;
  }

  .color-legend__stop-marker {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 1px;
    background: rgba(255, 255, 255, 0.5);
    pointer-events: none;
  }

  .color-legend__stop-segment:first-child .color-legend__stop-marker {
    display: none;
  }

  .color-legend__color-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }
</style>
