<script lang="ts">
  import MapView from '$lib/map/MapView.svelte';
  import '../app.css';
</script>

<svelte:head>
  <title>Weather Map</title>
  <meta name="description" content="Interactive weather visualization with WebGL" />
</svelte:head>

<main class="app">
  <MapView />
</main>

<style>
  .app {
    width: 100%;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
</style>
