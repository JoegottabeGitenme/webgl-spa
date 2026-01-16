# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
