<script lang="ts">
	import { onMount } from 'svelte';
	import './layout.css';

	let { children } = $props();
	let isDark = $state(false);

	onMount(() => {
		const saved = localStorage.getItem('theme');
		const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		isDark = saved ? saved === 'dark' : prefersDark;
		document.documentElement.classList.toggle('dark', isDark);
	});

	function toggleTheme() {
		isDark = !isDark;
		document.documentElement.classList.toggle('dark', isDark);
		localStorage.setItem('theme', isDark ? 'dark' : 'light');
	}
</script>

<div class="flex h-screen flex-col bg-bg font-sans text-foreground">
	<!-- Header -->
	<header class="border-b border-border bg-surface px-4 py-2.5 sm:px-6">
		<div class="flex items-center justify-between gap-4">
			<div class="flex items-center gap-4">
				<a href="/" class="font-semibold text-accent no-underline">✦ Marquetry Parquetry Studio</a>
				<!-- Nav links go here as the app grows -->
				<nav class="hidden items-center gap-4 text-sm text-muted sm:flex">
					<!-- <a href="/gallery" class="transition-colors hover:text-foreground">Gallery</a> -->
				</nav>
			</div>
			<div class="flex items-center gap-2">
				<button
					onclick={toggleTheme}
					class="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-accent"
					title="Toggle light / dark"
					aria-label="Toggle light or dark theme"
				>
					{isDark ? '☀ Light' : '☾ Dark'}
				</button>
			</div>
		</div>
	</header>

	<!-- Main: full-bleed, holds the board -->
	<main class="min-h-0 flex-1">
		{@render children()}
	</main>
</div>

<style>
	:global(html) {
		background-color: var(--color-bg);
	}
</style>