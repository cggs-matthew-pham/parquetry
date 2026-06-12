<script lang="ts">
	import {
		diamondPoly, edgePoly, shapePoly, polyToPoints,
		GRAINS, grainById,
		type Board, type Geo, type Grain, type Shape, type EdgeKind
	} from '$lib/grid';

	type Placed =
		| { t: 'd'; i: number; j: number; shape: Shape; grain: Grain }
		| { t: 'e'; i: number; j: number; kind: EdgeKind; grain: Grain };

	let {
		board,
		geo,
		rotation,
		entries,
		onClose
	}: {
		board: Board;
		geo: Geo;
		rotation: number;
		entries: [string, Placed][];
		onClose: () => void;
	} = $props();

	// View toggle: the finished design, or a blank grid for cutting practice
	let view = $state<'design' | 'blank'>('design');

	// Orientation defaults to whatever fits the board best (flat boards are wide)
	let orientation = $state<'portrait' | 'landscape'>(
		board.w > board.h ? 'landscape' : 'portrait'
	);

	const pageW = $derived(orientation === 'landscape' ? 297 : 210);
	const pageH = $derived(orientation === 'landscape' ? 210 : 297);
	const A4_W = $derived(pageW - 20); // ~10mm margins each side
	const A4_H = $derived(pageH - 20);

	// Drive the actual print page size/orientation
	$effect(() => {
		let el = document.getElementById('pq-page-style') as HTMLStyleElement | null;
		if (!el) {
			el = document.createElement('style');
			el.id = 'pq-page-style';
			document.head.appendChild(el);
		}
		el.textContent = `@page { size: A4 ${orientation}; margin: 0; }`;
		return () => el?.remove();
	});

	// Fit the board rectangle into the printable area, preserving aspect
	const fit = $derived.by(() => {
		const scale = Math.min(A4_W / board.w, A4_H / board.h);
		const w = board.w * scale;
		const h = board.h * scale;
		return { scale, w, h, x: (A4_W - w) / 2, y: (A4_H - h) / 2 };
	});

	function grainFill(grain: Grain): string {
		const def = grainById(grain);
		return def.spacing > 0 ? `url(#pgrain-${grain})` : def.base;
	}

	function placedPoints(p: Placed): string {
		const cx = p.i * geo.halfW;
		const cy = p.j * geo.halfH;
		return p.t === 'd'
			? polyToPoints(shapePoly(p.shape, cx, cy, geo))
			: polyToPoints(edgePoly(p.kind, cx, cy, geo));
	}

	function doPrint() {
		window.print();
	}
</script>

<div class="overlay" role="dialog" aria-label="Print preview">
	<div class="toolbar no-print">
		<div class="seg">
			<button class:active={view === 'design'} onclick={() => (view = 'design')}>Finished design</button>
			<button class:active={view === 'blank'} onclick={() => (view = 'blank')}>Blank template</button>
		</div>
		<div class="seg">
			<button class:active={orientation === 'portrait'} onclick={() => (orientation = 'portrait')}>Portrait</button>
			<button class:active={orientation === 'landscape'} onclick={() => (orientation = 'landscape')}>Landscape</button>
		</div>
		<div class="spacer"></div>
		<button class="print-btn" onclick={doPrint}>Print</button>
		<button class="close-btn" onclick={onClose}>Close</button>
	</div>

	<div class="page-scroll">
		<div class="a4-page" style="--ar: {pageW / pageH}; aspect-ratio: {pageW} / {pageH};">
			<svg viewBox="0 0 {pageW} {pageH}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
				<defs>
					{#each GRAINS as grain (grain.id)}
						{#if grain.spacing > 0}
							<pattern
								id="pgrain-{grain.id}"
								width={grain.spacing}
								height={grain.spacing}
								patternUnits="userSpaceOnUse"
								patternTransform="rotate({grain.angle + rotation})"
							>
								<rect width={grain.spacing} height={grain.spacing} fill={grain.base} />
								<line x1="0" y1="0" x2={grain.spacing} y2="0" stroke={grain.stroke} stroke-width={grain.strokeWidth} />
							</pattern>
						{/if}
					{/each}
				</defs>

				<rect width={pageW} height={pageH} fill="white" />

				<g transform="translate({(pageW - A4_W) / 2 + fit.x} {(pageH - A4_H) / 2 + fit.y}) scale({fit.scale}) rotate({rotation} {board.w / 2} {board.h / 2})">
					{#if view === 'blank'}
						<!-- Cutting template: every slot as a thin outline -->
						{#each board.diamonds as d (d.key)}
							<polygon points={polyToPoints(diamondPoly(d.cx, d.cy, geo))} fill="white" stroke="black" stroke-width={0.4 / fit.scale} />
						{/each}
						{#each board.edges as ed (ed.key)}
							<polygon points={polyToPoints(edgePoly(ed.kind, ed.cx, ed.cy, geo))} fill="white" stroke="black" stroke-width={0.4 / fit.scale} />
						{/each}
					{:else}
						<!-- Finished design: faint grid under placed pieces -->
						{#each board.diamonds as d (d.key)}
							<polygon points={polyToPoints(diamondPoly(d.cx, d.cy, geo))} fill="none" stroke="#eee" stroke-width={0.3 / fit.scale} />
						{/each}
						{#each entries as [key, p] (key)}
							<polygon points={placedPoints(p)} fill={grainFill(p.grain)} stroke="black" stroke-width={0.5 / fit.scale} />
						{/each}
					{/if}
				</g>
			</svg>
		</div>
	</div>

	<p class="tip no-print">
		Print at 100% scale (no "fit to page") so the pieces stay true to size for cutting.
	</p>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: #4a4a4a;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.toolbar {
		width: 100%;
		max-width: 900px;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		box-sizing: border-box;
	}

	.seg {
		display: flex;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid #888;
	}

	.seg button {
		padding: 0.45rem 0.9rem;
		font-size: 0.8rem;
		border: none;
		background: #2f2f2f;
		color: #ddd;
		cursor: pointer;
	}

	.seg button.active {
		background: #e8f0ff;
		color: #1565c0;
		font-weight: 600;
	}

	.spacer {
		flex: 1;
	}

	.print-btn,
	.close-btn {
		padding: 0.45rem 1rem;
		font-size: 0.8rem;
		border-radius: 6px;
		border: 1px solid #888;
		cursor: pointer;
	}

	.print-btn {
		background: #2e7d32;
		color: white;
		border-color: #2e7d32;
		font-weight: 600;
	}

	.close-btn {
		background: #2f2f2f;
		color: #ddd;
	}

	.page-scroll {
		flex: 1;
		width: 100%;
		overflow: auto;
		display: flex;
		justify-content: center;
		padding: 0 1rem 1rem;
		box-sizing: border-box;
	}

	.a4-page {
		background: white;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
		height: min(78vh, calc(90vw / var(--ar)));
		width: auto;
	}

	.tip {
		color: #ccc;
		font-size: 0.75rem;
		margin: 0 0 0.75rem;
	}

	/* ---- Print: show only the A4 page, full size ---- */
	@media print {
		.no-print {
			display: none !important;
		}

		.overlay {
			position: static;
			background: white;
		}

		.page-scroll {
			overflow: visible;
			padding: 0;
		}

		.a4-page {
			width: 100%;
			height: auto;
			box-shadow: none;
		}
	}
</style>