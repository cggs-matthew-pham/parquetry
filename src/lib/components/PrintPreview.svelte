<script lang="ts">
	import { rotStepFor, leaves, grainById, GRAINS, type Board, type Mode, type Region, type Pt, type MergeGroup, type Grain } from '$lib/grid';

	let {
		board,
		mode,
		rotation,
		design,
		merges,
		colours,
		onClose
	}: {
		board: Board;
		mode: Mode;
		rotation: number;
		design: Map<string, Region>;
		merges: Map<string, MergeGroup>;
		colours: Map<string, Grain>;
		onClose: () => void;
	} = $props();

	function grainFill(g: Grain): string {
		const def = grainById(g);
		return def.spacing > 0 ? `url(#pgrain-${g})` : def.base;
	}
	function faceFill(id: string): string {
		const g = colours.get(id);
		return g ? grainFill(g) : 'white';
	}

	// Every leaf face: merge outlines + non-consumed cells' subdivisions.
	const faces = $derived.by(() => {
		const consumed = new Set([...merges.values()].flatMap((g) => g.cellIds));
		const out: { id: string; poly: Pt[] }[] = [];
		for (const g of merges.values()) out.push({ id: g.id, poly: g.poly });
		for (const cell of board.cells) {
			if (consumed.has(cell.id)) continue;
			const region = design.get(cell.id);
			if (!region) out.push({ id: cell.id, poly: cell.poly });
			else leaves(region).forEach((lf, k) => out.push({ id: `${cell.id}#${k}`, poly: lf.poly }));
		}
		return out;
	});

	// Design view shows marked cells; blank view shows all cell outlines for cutting
	let view = $state<'design' | 'blank'>('design');

	// Print starts at the board's current rotation; adjustable here.
	let printRot = $state(rotation);
	const rotStep = $derived(rotStepFor(mode));

	function rotateBy(d: number) {
		printRot = (((printRot + d) % 360) + 360) % 360;
	}

	// Orientation auto-picks from the rotated board's aspect; user can override
	let orientation = $state<'portrait' | 'landscape'>('portrait');
	$effect(() => {
		// initialise once from the rotated footprint
		const fp = rotatedFootprint(board.w, board.h, printRot);
		orientation = fp.w > fp.h ? 'landscape' : 'portrait';
	});

	const pageW = $derived(orientation === 'landscape' ? 297 : 210);
	const pageH = $derived(orientation === 'landscape' ? 210 : 297);
	const A4_W = $derived(pageW - 20);
	const A4_H = $derived(pageH - 20);

	function rotatedFootprint(w: number, h: number, deg: number) {
		const cx = w / 2, cy = h / 2;
		const rad = (deg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
		const corners = [[0, 0], [w, 0], [w, h], [0, h]];
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const [x, y] of corners) {
			const rx = cx + (x - cx) * cos - (y - cy) * sin;
			const ry = cy + (x - cx) * sin + (y - cy) * cos;
			minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
			minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
		}
		return { minX, minY, w: maxX - minX, h: maxY - minY };
	}

	// Fit the rotated board into the printable area, preserving aspect
	const fit = $derived.by(() => {
		const fp = rotatedFootprint(board.w, board.h, printRot);
		const scale = Math.min(A4_W / fp.w, A4_H / fp.h);
		return {
			scale,
			x: (A4_W - fp.w * scale) / 2 - fp.minX * scale,
			y: (A4_H - fp.h * scale) / 2 - fp.minY * scale
		};
	});

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

	function pts(poly: [number, number][]): string {
		return poly.map(([x, y]) => `${x},${y}`).join(' ');
	}

	function doPrint() {
		window.print();
	}
</script>

<div class="overlay" role="dialog" aria-label="Print preview">
	<div class="toolbar no-print">
		<div class="seg">
			<button class:active={view === 'design'} onclick={() => (view = 'design')}>Design</button>
			<button class:active={view === 'blank'} onclick={() => (view = 'blank')}>Blank template</button>
		</div>
		<div class="seg">
			<button class:active={orientation === 'portrait'} onclick={() => (orientation = 'portrait')}>Portrait</button>
			<button class:active={orientation === 'landscape'} onclick={() => (orientation = 'landscape')}>Landscape</button>
		</div>
		<div class="rotbox">
			<button onclick={() => rotateBy(-rotStep)} title="Rotate left">⟲</button>
			<span>{printRot}°</span>
			<button onclick={() => rotateBy(rotStep)} title="Rotate right">⟳</button>
		</div>
		<div class="spacer"></div>
		<button class="print-btn" onclick={doPrint}>Print</button>
		<button class="close-btn" onclick={onClose}>Close</button>
	</div>

	<div class="page-scroll">
		<div class="a4-page" style="--ar: {pageW / pageH}; aspect-ratio: {pageW} / {pageH};">
			<svg viewBox="0 0 {pageW} {pageH}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
				<rect width={pageW} height={pageH} fill="white" />
				<defs>
					{#each GRAINS as g (g.id)}
						{#if g.spacing > 0}
							<pattern id="pgrain-{g.id}" width={g.spacing} height={g.spacing} patternUnits="userSpaceOnUse" patternTransform="rotate({g.angle + printRot})">
								<rect width={g.spacing} height={g.spacing} fill={g.base} />
								<line x1="0" y1="0" x2={g.spacing} y2="0" stroke={g.stroke} stroke-width={g.strokeWidth} />
							</pattern>
						{/if}
					{/each}
				</defs>
				<g transform="translate({(pageW - A4_W) / 2 + fit.x} {(pageH - A4_H) / 2 + fit.y}) scale({fit.scale}) rotate({printRot} {board.w / 2} {board.h / 2})">
					{#each faces as face (face.id)}
						<polygon points={pts(face.poly)} fill={view === 'blank' ? 'white' : faceFill(face.id)} stroke="black" stroke-width={(view === 'blank' ? 0.4 : 0.45) / fit.scale} />
					{/each}
				</g>
			</svg>
		</div>
	</div>

	<p class="tip no-print">Print at 100% scale (no “fit to page”) to keep pieces true to size.</p>
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
		max-width: 940px;
		display: flex;
		align-items: center;
		gap: 0.6rem;
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
		padding: 0.4rem 0.8rem;
		font-size: 0.78rem;
		border: none;
		background: #2f2f2f;
		color: #ddd;
		cursor: pointer;
	}

	.seg button.active { background: #e8f0ff; color: #1565c0; font-weight: 600; }

	.rotbox {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		color: #ddd;
		font-size: 0.78rem;
	}

	.rotbox button {
		padding: 0.25rem 0.5rem;
		background: #2f2f2f;
		color: #ddd;
		border: 1px solid #888;
		border-radius: 5px;
		cursor: pointer;
	}

	.rotbox span { min-width: 2.6rem; text-align: center; font-variant-numeric: tabular-nums; }

	.spacer { flex: 1; }

	.print-btn, .close-btn {
		padding: 0.45rem 1rem;
		font-size: 0.8rem;
		border-radius: 6px;
		border: 1px solid #888;
		cursor: pointer;
	}

	.print-btn { background: #2e7d32; color: white; border-color: #2e7d32; font-weight: 600; }
	.close-btn { background: #2f2f2f; color: #ddd; }

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

	.tip { color: #ccc; font-size: 0.75rem; margin: 0 0 0.75rem; }

	@media print {
		.no-print { display: none !important; }
		.overlay { position: static; background: white; }
		.page-scroll { overflow: visible; padding: 0; }
		.a4-page { width: 100%; height: auto; box-shadow: none; }
	}
</style>