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
    preferredUnit?: 'F' | 'C';
    dataMin?: number;
    dataMax?: number;
    onScaleChange?: (newScale: ColorScale) => void;
    onScalePreview?: (newScale: ColorScale) => void;
  }

  let { min, max, units = "K", scale = TEMPERATURE_SCALE, preferredUnit = 'F', dataMin, dataMax, onScaleChange, onScalePreview }: Props = $props();

  // Edit mode state
  let editMode = $state(false);
  let popoverAnchor: HTMLDivElement;
  let sliderTrack: HTMLDivElement;

  // Dragging state
  let draggingIndex = $state<number | null>(null);

  // Color input refs
  let colorInputs: HTMLInputElement[] = [];

  // Temperature range for the slider (in display units)
  const TEMP_SCALE_RANGES = {
    F: { min: -60, max: 130 },
    C: { min: -51, max: 54 },
  };

  // Get the temperature range for current unit
  function getTempRange() {
    const isKelvin = units === 'K';
    const unit = isKelvin ? preferredUnit : 'F';
    return TEMP_SCALE_RANGES[unit];
  }

  // Convert position (0-1) to display temperature
  function positionToDisplayTemp(position: number): number {
    const range = getTempRange();
    return range.min + position * (range.max - range.min);
  }

  // Convert display temperature to position (0-1)
  function displayTempToPosition(displayTemp: number): number {
    const range = getTempRange();
    return Math.max(0, Math.min(1, (displayTemp - range.min) / (range.max - range.min)));
  }

  // Generate CSS gradient for the legend bar
  let gradient = $derived.by(() => {
    const displayMin = convertValue(min);
    const displayMax = convertValue(max);
    const range = getTempRange();
    const fullRange = range.max - range.min;
    
    const minPos = Math.max(0, Math.min(1, (displayMin - range.min) / fullRange));
    const maxPos = Math.max(0, Math.min(1, (displayMax - range.min) / fullRange));
    
    const stops: string[] = [];
    const numStops = 20;
    
    for (let i = 0; i <= numStops; i++) {
      const t = i / numStops;
      const absValue = minPos + (maxPos - minPos) * t;
      const [r, g, b] = getColorForValue(absValue, scale);
      stops.push(`${rgbToCSS(r, g, b)} ${t * 100}%`);
    }
    
    return `linear-gradient(to right, ${stops.join(", ")})`;
  });

  // Generate full gradient for edit mode slider
  let fullGradient = $derived.by(() => {
    const stops: string[] = [];
    for (const [position, r, g, b] of scale) {
      stops.push(`${rgbToCSS(r, g, b)} ${position * 100}%`);
    }
    return `linear-gradient(to right, ${stops.join(", ")})`;
  });

  function convertValue(value: number): number {
    if (units === 'K') {
      return preferredUnit === 'F' ? kelvinToFahrenheit(value) : kelvinToCelsius(value);
    }
    return value;
  }

  function getDisplayUnit(): string {
    if (units === 'K') {
      return `°${preferredUnit}`;
    }
    return units;
  }

  function formatValue(value: number): string {
    return convertValue(value).toFixed(0);
  }

  // Get color stops with display values
  let colorStopsWithValues = $derived.by(() => {
    return scale.map(([position, r, g, b], index) => {
      const displayTemp = positionToDisplayTemp(position);
      return {
        index,
        position,
        displayTemp,
        color: rgbToCSS(r, g, b),
        r, g, b
      };
    });
  });

  function toggleEditMode(event?: MouseEvent) {
    event?.stopPropagation();
    editMode = !editMode;
    draggingIndex = null;
  }

  function handleClickOutside(event: MouseEvent) {
    if (editMode && popoverAnchor && !popoverAnchor.contains(event.target as Node)) {
      editMode = false;
      draggingIndex = null;
    }
  }

  // RGB/Hex conversion
  function rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function hexToRgb(hex: string): [number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
    }
    return [0, 0, 0];
  }

  // Handle dragging
  function handleMouseDown(index: number, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    draggingIndex = index;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }

  function handleMouseMove(event: MouseEvent) {
    if (draggingIndex === null || !sliderTrack) return;

    const rect = sliderTrack.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const newPosition = Math.max(0, Math.min(1, x / rect.width));

    // Get bounds from neighboring stops
    const prevPosition = draggingIndex > 0 ? scale[draggingIndex - 1][0] : 0;
    const nextPosition = draggingIndex < scale.length - 1 ? scale[draggingIndex + 1][0] : 1;

    // Clamp with margin to prevent overlap
    const margin = 0.01;
    const clampedPosition = Math.max(prevPosition + margin, Math.min(nextPosition - margin, newPosition));

    // Create updated scale
    const newScale: ColorScale = scale.map((stop, i) => {
      if (i === draggingIndex) {
        return [clampedPosition, stop[1], stop[2], stop[3]] as ColorStop;
      }
      return stop;
    });

    onScalePreview?.(newScale);
  }

  function handleMouseUp() {
    if (draggingIndex !== null) {
      // Commit the change
      onScaleChange?.(scale);
    }
    draggingIndex = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }

  // Handle color band click - open color picker for that band
  function handleBandClick(index: number, event: MouseEvent) {
    event.stopPropagation();
    colorInputs[index]?.click();
  }

  function handleColorPreview(index: number, event: Event) {
    const input = event.target as HTMLInputElement;
    const [r, g, b] = hexToRgb(input.value);
    const newScale: ColorScale = scale.map((stop, i) => {
      if (i === index) {
        return [stop[0], r, g, b] as ColorStop;
      }
      return stop;
    });
    onScalePreview?.(newScale);
  }

  function handleColorChange(index: number, event: Event) {
    const input = event.target as HTMLInputElement;
    const [r, g, b] = hexToRgb(input.value);
    const newScale: ColorScale = scale.map((stop, i) => {
      if (i === index) {
        return [stop[0], r, g, b] as ColorStop;
      }
      return stop;
    });
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
    <!-- Edit mode with multi-handle slider -->
    <div class="color-legend__edit-header">
      <span class="color-legend__edit-title">Edit Colors</span>
      <button class="color-legend__edit-close" onclick={(e) => toggleEditMode(e)} title="Done editing">&times;</button>
    </div>
    
    <!-- Multi-handle slider -->
    <div class="color-legend__slider">
      <!-- Track with gradient background -->
      <div class="color-legend__slider-track" bind:this={sliderTrack}>
        <!-- Color bands (clickable) -->
        {#each colorStopsWithValues as stop, index}
          {@const nextStop = colorStopsWithValues[index + 1]}
          {@const bandWidth = nextStop ? (nextStop.position - stop.position) * 100 : (1 - stop.position) * 100}
          {@const bandLeft = stop.position * 100}
          <button
            class="color-legend__band"
            style="left: {bandLeft}%; width: {bandWidth}%; background: {stop.color};"
            onclick={(e) => handleBandClick(index, e)}
            title="Click to change color"
          ></button>
          <input
            type="color"
            class="color-legend__color-input"
            value={rgbToHex(stop.r, stop.g, stop.b)}
            oninput={(e) => handleColorPreview(index, e)}
            onchange={(e) => handleColorChange(index, e)}
            bind:this={colorInputs[index]}
          />
        {/each}
        
        <!-- Handles (draggable) -->
        {#each colorStopsWithValues as stop, index}
          <button
            class="color-legend__handle"
            class:color-legend__handle--dragging={draggingIndex === index}
            style="left: {stop.position * 100}%;"
            onmousedown={(e) => handleMouseDown(index, e)}
            title="{Math.round(stop.displayTemp)}{getDisplayUnit()}"
          >
            <span class="color-legend__handle-grip"></span>
          </button>
        {/each}
      </div>
      
      <!-- Temperature labels below slider -->
      <div class="color-legend__slider-labels">
        {#each colorStopsWithValues as stop}
          <span 
            class="color-legend__slider-label"
            style="left: {stop.position * 100}%;"
          >
            {Math.round(stop.displayTemp)}{getDisplayUnit()}
          </span>
        {/each}
      </div>
    </div>
    
    <!-- Scale range labels -->
    <div class="color-legend__range-labels">
      <span>{getTempRange().min}{getDisplayUnit()}</span>
      <span>{getTempRange().max}{getDisplayUnit()}</span>
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
    width: 700px;
    min-width: 700px;
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
    margin-bottom: var(--spacing-sm);
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

  /* Multi-handle slider */
  .color-legend__slider {
    position: relative;
    padding: 16px 12px 48px 12px;
  }

  .color-legend__slider-track {
    position: relative;
    height: 48px;
    border-radius: var(--radius-sm);
    overflow: visible;
    border: 1px solid var(--color-card-border);
  }

  /* Color bands */
  .color-legend__band {
    position: absolute;
    top: 0;
    height: 100%;
    border: none;
    padding: 0;
    cursor: pointer;
    transition: filter 0.1s ease;
  }

  .color-legend__band:hover {
    filter: brightness(1.15);
  }

  .color-legend__band:focus {
    outline: none;
    box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.5);
  }

  /* Handles */
  .color-legend__handle {
    position: absolute;
    top: -6px;
    width: 18px;
    height: 60px;
    transform: translateX(-50%);
    background: var(--color-card);
    border: 2px solid var(--color-card-border);
    border-radius: 4px;
    cursor: ew-resize;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.1s ease, box-shadow 0.1s ease;
    padding: 0;
  }

  .color-legend__handle:hover {
    border-color: var(--color-accent, rgb(78, 179, 211));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .color-legend__handle--dragging {
    border-color: var(--color-accent, rgb(78, 179, 211));
    box-shadow: 0 2px 12px rgba(78, 179, 211, 0.5);
    z-index: 20;
  }

  .color-legend__handle:focus {
    outline: none;
    border-color: var(--color-accent, rgb(78, 179, 211));
  }

  .color-legend__handle-grip {
    width: 6px;
    height: 24px;
    background: repeating-linear-gradient(
      to bottom,
      var(--color-text-secondary) 0px,
      var(--color-text-secondary) 2px,
      transparent 2px,
      transparent 5px
    );
    border-radius: 1px;
  }

  /* Temperature labels below handles */
  .color-legend__slider-labels {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    height: 28px;
  }

  .color-legend__slider-label {
    position: absolute;
    transform: translateX(-50%);
    font-size: 11px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    margin-top: 8px;
  }

  /* Range labels */
  .color-legend__range-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.6;
    margin-top: 8px;
    padding: 0 12px;
  }

  /* Hidden color input */
  .color-legend__color-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }
</style>
