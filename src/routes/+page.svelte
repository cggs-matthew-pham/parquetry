<h1>Welcome to SvelteKit</h1>
<p>Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read the documentation</p>
<script lang="ts">
	import ParquetryBoard from '$lib/components/ParquetryBoard.svelte';
</script>

<svelte:head>
	<title>Paper Parquetry</title>
</svelte:head>

<ParquetryBoard />

<style>
	:global(body) {
		margin: 0;
		overflow: hidden;
	}
</style>