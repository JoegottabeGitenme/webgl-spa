# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Multi-handle slider for color legend editor with draggable temperature breakpoints
- Clickable color bands in legend editor to change colors at specific temperature ranges
- Absolute temperature color mapping functions for consistent color scale alignment

### Fixed
- Stepped colors (color fill) now works independently of "Show gradient layer" toggle
- Temperature contour labels now display in user's preferred unit (F/C) instead of hardcoded Celsius
- Isoline interval slider label now shows values in preferred temperature unit
- Contour levels now snap to nice round numbers in display units (e.g., 0°F, 5°F, 10°F)
- Fixed projection mismatch between contour lines and raster layer (contours now use original data, MapLibre handles projection)
- Fixed half-pixel offset in contour coordinates for proper alignment with raster layer
- Color legend editor colors now correctly match map visualization using absolute temperature scale (-60°F to 130°F)

### Changed
- Color legend editor redesigned with larger visual slider (700px wide, 48px track)
- Color scale now uses absolute temperature range mapping instead of relative data range

## [1.0.0-beta] - 2026-01-24

### Added
- Initial project setup with SvelteKit 2 and Svelte 5
- Interactive weather map using MapLibre GL JS
- WebGL wind particle visualization layer
- Multiple weather data layers (temperature, radar, humidity, precipitation, dew point)
- Animation/looping controls for temporal weather data
- Color scale selector with multiple visualization styles
- Wind overlay with customizable particle settings
- Color legend component with temperature unit conversion
- Keyboard shortcut: `W` to toggle wind particles on/off

### Changed
- Animation controls are now always visible (when not in compact mode)
- Animation playback controls are disabled until frames are loaded

### Removed
- "Loop" toggle button (animation bar is now always visible)

## [1.0.0] - 2026-01-15

### Added
- Initial release with map component from existing codebase
