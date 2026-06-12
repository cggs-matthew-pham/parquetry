<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import {
		buildBoard, diamondPoly, edgePoly, shapePoly, polyToPoints, pointInPoly,
		rotatedViewBox, geoFor, rotStepFor, grainById, quadsOverlap,
		GRAINS, SHAPES, MODES,
		type Grain, type Shape, type Mode, type EdgeKind
	} from '$lib/grid';
	import PrintPreview from './PrintPreview.svelte';

	const COLS = 5;
	const JMAX = 8;
	const PAD = 14;

	// ---- State ----
	let mode = $state<Mode>('tall');
	let rotation = $state(0);
	let selectedShape = $state<Shape>('diamond');
	let selectedGrain = $state<Grain>('none');
	let showPrint = $state(false);

	type Placed =
		| { t: 'd'; i: number; j: number; shape: Shape; grain: Grain }
		| { t: 'e'; i: number; j: number; kind: EdgeKind; grain: Grain };
	const pieces = new SvelteMap<string, Placed>();

	// hover = the snapped slot under the cursor (or null); raw = the unsnapped
	// cursor position in board-local coords, used for the free-floating preview
	let hover = $state<{ kind: 'd' | 'e'; i: number; j: number; edge?: EdgeKind } | null>(null);
	let raw = $state<{ x: number; y: number } | null>(null);

	let svgEl: SVGSVGElement;
	let gridEl: SVGGElement;

	// ---- Derived geometry ----
	const geo = $derived(geoFor(mode));
	const board = $derived(buildBoard(COLS, JMAX, geo));
	const viewBox = $derived(rotatedViewBox(board.w, board.h, rotation, PAD));
	const pivotX = $derived(board.w / 2);
	const pivotY = $derived(board.h / 2);
	const rotStep = $derived(rotStepFor(mode));
	const placedEntries = $derived(Array.from(pieces.entries()));

	// ---- Placement ----
	// A diamond cell can hold independent sub-pieces (halves, quarters) as long as
	// their quadrants don't overlap; placing one clears only overlapping pieces.
	function placeDiamond(i: number, j: number, shape: Shape, grain: Grain) {
		const prefix = `d:${i},${j}:`;
		for (const [key, p] of pieces) {
			if (p.t === 'd' && key.startsWith(prefix) && quadsOverlap(shape, p.shape)) {
				pieces.delete(key);
			}
		}
		pieces.set(`d:${i},${j}:${shape}`, { t: 'd', i, j, shape, grain });
	}

	function placeEdge(i: number, j: number, kind: EdgeKind, grain: Grain) {
		pieces.set(`e:${i},${j}`, { t: 'e', i, j, kind, grain });
	}

	function removePiece(key: string) {
		pieces.delete(key);
	}

	function clearAll() {
		pieces.clear();
	}

	// ---- Mode + rotation ----
	function setMode(m: Mode) {
		if (m === mode) return;
		mode = m;
		const step = rotStepFor(m);
		rotation = (Math.round(rotation / step) * step) % 360;
	}

	function rotateBy(delta: number) {
		rotation = (((rotation + delta) % 360) + 360) % 360;
	}

	function resetRotation() {
		rotation = 0;
	}

	// ---- Shape / grain cycling (keyboard + wheel) ----
	function cycleShape(dir: number) {
		const ids = SHAPES.map((s) => s.id);
		const idx = ids.indexOf(selectedShape);
		selectedShape = ids[(idx + dir + ids.length) % ids.length];
	}

	function cycleGrain(dir: number) {
		const ids = GRAINS.map((g) => g.id);
		const idx = ids.indexOf(selectedGrain);
		selectedGrain = ids[(idx + dir + ids.length) % ids.length];
	}

	function handleKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
		if (e.key >= '1' && e.key <= '9') {
			const idx = Number(e.key) - 1;
			if (idx < SHAPES.length) { selectedShape = SHAPES[idx].id; e.preventDefault(); }
		} else if (e.key === ']' || e.key === 'ArrowRight') { cycleShape(1); e.preventDefault(); }
		else if (e.key === '[' || e.key === 'ArrowLeft') { cycleShape(-1); e.preventDefault(); }
		else if (e.key === 'ArrowUp') { cycleGrain(-1); e.preventDefault(); }
		else if (e.key === 'ArrowDown') { cycleGrain(1); e.preventDefault(); }
	}

	// Wheel over the board cycles shapes (non-passive so we can preventDefault)
	$effect(() => {
		const el = svgEl;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			cycleShape(e.deltaY > 0 ? 1 : -1);
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	// ---- Hit testing ----
	function localPoint(e: PointerEvent): { x: number; y: number } {
		const ctm = gridEl.getScreenCTM();
		if (!ctm) return { x: -1e9, y: -1e9 };
		const svg = gridEl.ownerSVGElement!;
		const pt = svg.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const p = pt.matrixTransform(ctm.inverse());
		return { x: p.x, y: p.y };
	}

	function hitSlot(x: number, y: number) {
		for (const d of board.diamonds) {
			if (pointInPoly(x, y, diamondPoly(d.cx, d.cy, geo))) {
				return { kind: 'd' as const, i: d.i, j: d.j };
			}
		}
		for (const ed of board.edges) {
			if (pointInPoly(x, y, edgePoly(ed.kind, ed.cx, ed.cy, geo))) {
				return { kind: 'e' as const, i: ed.i, j: ed.j, edge: ed.kind };
			}
		}
		return null;
	}

	function handleBoardMove(e: PointerEvent) {
		const { x, y } = localPoint(e);
		raw = { x, y };
		hover = hitSlot(x, y);
	}

	function handleBoardClick(e: PointerEvent) {
		const { x, y } = localPoint(e);
		const hit = hitSlot(x, y);
		if (!hit) return;
		if (hit.kind === 'd') placeDiamond(hit.i, hit.j, selectedShape, selectedGrain);
		else if (hit.edge) placeEdge(hit.i, hit.j, hit.edge, selectedGrain);
	}

	function handleBoardLeave() {
		hover = null;
		raw = null;
	}

	function removeOnPointer(key: string, e: Event) {
		e.stopPropagation();
		removePiece(key);
	}

	function removeOnKey(key: string, e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			e.stopPropagation();
			removePiece(key);
		}
	}

	// ---- Fills ----
	function grainFill(grain: Grain): string {
		const def = grainById(grain);
		return def.spacing > 0 ? `url(#grain-${grain})` : def.base;
	}

	function placedPoints(p: Placed): string {
		const cx = p.i * geo.halfW;
		const cy = p.j * geo.halfH;
		return p.t === 'd'
			? polyToPoints(shapePoly(p.shape, cx, cy, geo))
			: polyToPoints(edgePoly(p.kind, cx, cy, geo));
	}

	// Snapped preview points (when over a slot)
	const snapPoints = $derived.by(() => {
		if (!hover) return null;
		const cx = hover.i * geo.halfW;
		const cy = hover.j * geo.halfH;
		return hover.kind === 'd'
			? polyToPoints(shapePoly(selectedShape, cx, cy, geo))
			: hover.edge ? polyToPoints(edgePoly(hover.edge, cx, cy, geo)) : null;
	});

	// Free-floating preview points (cursor not over a slot)
	const floatPoints = $derived.by(() => {
		if (!raw || hover) return null;
		return polyToPoints(shapePoly(selectedShape, raw.x, raw.y, geo));
	});
</script>

<svelte:window onkeydown={handleKey} />

<div class="parquetry-app">
	<div class="palette">
		<h3>Grid</h3>
		<div class="mode-pills">
			{#each MODES as m (m.id)}
				<button class="pill" class:active={mode === m.id} onclick={() => setMode(m.id)}>
					<span class="pill-label">{m.label}</span>
					<span class="pill-sub">{m.sub}</span>
				</button>
			{/each}
		</div>

		<div class="rotate-controls">
			<button onclick={() => rotateBy(-rotStep)} title="Rotate left {rotStep}°">⟲</button>
			<span class="rot-readout">{rotation}°</span>
			<button onclick={() => rotateBy(rotStep)} title="Rotate right {rotStep}°">⟳</button>
			<button class="rot-reset" onclick={resetRotation} disabled={rotation === 0}>Reset</button>
		</div>

		<h3>Shape</h3>
		<div class="shape-grid">
			{#each SHAPES as s, idx (s.id)}
				<button
					class="shape-btn"
					class:active={selectedShape === s.id}
					onclick={() => (selectedShape = s.id)}
					title="{s.label}  ({idx + 1})"
				>
					<svg viewBox="-38 -38 76 76" width="40" height="40">
						<polygon points={polyToPoints(diamondPoly(0, 0, geo))} fill="none" stroke="#ddd" stroke-width="1.5" />
						<polygon points={polyToPoints(shapePoly(s.id, 0, 0, geo))} fill="#e0d2bc" stroke="#555" stroke-width="2.5" />
					</svg>
				</button>
			{/each}
		</div>
		<p class="cycle-note">Keys 1–9, ← →, or scroll over the board to switch shape. ↑ ↓ changes wood.</p>

		<h3>Wood</h3>
		<div class="grain-row">
			{#each GRAINS as grain (grain.id)}
				<button
					class="grain-btn"
					class:active={selectedGrain === grain.id}
					onclick={() => (selectedGrain = grain.id)}
					title={grain.label}
				>
					<svg viewBox="-38 -38 76 76" width="30" height="30">
						<defs>
							{#if grain.spacing > 0}
								<pattern id="pal-{grain.id}" width={grain.spacing} height={grain.spacing} patternUnits="userSpaceOnUse" patternTransform="rotate({grain.angle})">
									<rect width={grain.spacing} height={grain.spacing} fill={grain.base} />
									<line x1="0" y1="0" x2={grain.spacing} y2="0" stroke={grain.stroke} stroke-width={grain.strokeWidth} />
								</pattern>
							{/if}
						</defs>
						<polygon points={polyToPoints(diamondPoly(0, 0, geo))} fill={grain.id === 'none' ? grain.base : `url(#pal-${grain.id})`} stroke="black" stroke-width="2" />
					</svg>
					<span>{grain.label}</span>
				</button>
			{/each}
		</div>

		<p class="edge-note">Edge and corner triangles round the border are fillable too. Just click them.</p>

		<div class="palette-actions">
			<button class="btn-clear" onclick={clearAll}>Clear All</button>
		</div>
		<button class="btn-print" onclick={() => (showPrint = true)}>
			<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polyline points="6 9 6 2 18 2 18 9" />
				<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
				<rect x="6" y="14" width="12" height="8" />
			</svg>
			Print / Export
		</button>
	</div>

	<div class="board-container">
		<svg
			bind:this={svgEl}
			{viewBox}
			class="board"
			onpointermove={handleBoardMove}
			onpointerup={handleBoardClick}
			onpointerleave={handleBoardLeave}
			role="application"
			aria-label="Parquetry design board"
		>
			<defs>
				{#each GRAINS as grain (grain.id)}
					{#if grain.spacing > 0}
						<pattern id="grain-{grain.id}" width={grain.spacing} height={grain.spacing} patternUnits="userSpaceOnUse" patternTransform="rotate({grain.angle + rotation})">
							<rect width={grain.spacing} height={grain.spacing} fill={grain.base} />
							<line x1="0" y1="0" x2={grain.spacing} y2="0" stroke={grain.stroke} stroke-width={grain.strokeWidth} />
						</pattern>
					{/if}
				{/each}
			</defs>

			<g bind:this={gridEl} transform="rotate({rotation} {pivotX} {pivotY})">
				<g class="grid-layer">
					{#each board.diamonds as d (d.key)}
						<polygon points={polyToPoints(diamondPoly(d.cx, d.cy, geo))} class="grid-cell" />
					{/each}
					{#each board.edges as ed (ed.key)}
						<polygon points={polyToPoints(edgePoly(ed.kind, ed.cx, ed.cy, geo))} class="grid-cell edge-cell" />
					{/each}
				</g>

				<g class="pieces-layer">
					{#each placedEntries as [key, p] (key)}
						<polygon
							points={placedPoints(p)}
							fill={grainFill(p.grain)}
							stroke="black"
							stroke-width="0.8"
							class="placed-piece"
							onpointerup={(e) => removeOnPointer(key, e)}
							onkeydown={(e) => removeOnKey(key, e)}
							role="button"
							tabindex="0"
							aria-label="Placed piece, click to remove"
						/>
					{/each}
				</g>

				<!-- Snapped preview: locked, solid blue -->
				{#if snapPoints}
					<polygon points={snapPoints} fill={grainFill(selectedGrain)} stroke="dodgerblue" stroke-width="1.3" opacity="0.6" pointer-events="none" />
				{:else if floatPoints}
					<!-- Free-floating preview: loose, dashed grey -->
					<polygon points={floatPoints} fill={grainFill(selectedGrain)} stroke="#888" stroke-width="1" stroke-dasharray="3 2.5" opacity="0.32" pointer-events="none" />
				{/if}
			</g>
		</svg>
	</div>
</div>

{#if showPrint}
	<PrintPreview
		{board}
		{geo}
		{rotation}
		entries={placedEntries}
		onClose={() => (showPrint = false)}
	/>
{/if}

<style>
	.parquetry-app {
		display: flex;
		gap: 1rem;
		height: 100vh;
		padding: 1rem;
		box-sizing: border-box;
		font-family: system-ui, -apple-system, sans-serif;
		background: #f8f7f5;
	}

	.palette {
		flex: 0 0 280px;
		background: white;
		border-radius: 8px;
		padding: 1rem;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
		overflow-y: auto;
	}

	.palette h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
		color: #333;
	}

	.palette h3:not(:first-child) {
		margin-top: 1.25rem;
	}

	.mode-pills {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.75rem;
	}

	.pill {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		padding: 0.4rem 0.3rem;
		border: 1px solid #ccc;
		border-radius: 999px;
		background: white;
		cursor: pointer;
		transition: all 0.15s;
	}

	.pill-label {
		font-size: 0.74rem;
		font-weight: 600;
		color: #444;
	}

	.pill-sub {
		font-size: 0.6rem;
		color: #999;
		font-variant-numeric: tabular-nums;
	}

	.pill.active {
		border-color: dodgerblue;
		background: #e8f0ff;
	}

	.pill.active .pill-label {
		color: #1565c0;
	}

	.pill.active .pill-sub {
		color: #4a90d9;
	}

	.rotate-controls {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.rotate-controls button {
		padding: 0.35rem 0.6rem;
		font-size: 1rem;
		border: 1px solid #ccc;
		border-radius: 5px;
		background: white;
		cursor: pointer;
		line-height: 1;
	}

	.rotate-controls button:hover {
		background: #f0f0f0;
	}

	.rot-readout {
		min-width: 3rem;
		text-align: center;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		color: #444;
	}

	.rot-reset {
		margin-left: auto;
		font-size: 0.72rem !important;
		padding: 0.35rem 0.5rem !important;
	}

	.rot-reset:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.shape-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.35rem;
	}

	.shape-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2px;
		border: 2px solid transparent;
		border-radius: 6px;
		background: #f5f2ec;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}

	.shape-btn:hover {
		background: #ece6db;
	}

	.shape-btn.active {
		border-color: dodgerblue;
		background: #e8f0ff;
	}

	.cycle-note {
		margin: 0.5rem 0 0;
		font-size: 0.68rem;
		color: #999;
		line-height: 1.4;
	}

	.grain-row {
		display: flex;
		gap: 0.35rem;
	}

	.grain-btn {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 4px 2px;
		border: 2px solid transparent;
		border-radius: 6px;
		background: none;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}

	.grain-btn span {
		font-size: 0.6rem;
		color: #777;
	}

	.grain-btn:hover {
		background: #f0ede8;
	}

	.grain-btn.active {
		border-color: dodgerblue;
		background: #e8f0ff;
	}

	.edge-note {
		margin: 0.7rem 0 0;
		font-size: 0.7rem;
		color: #999;
		line-height: 1.4;
	}

	.palette-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.btn-clear {
		flex: 1;
		padding: 0.4rem 0.5rem;
		font-size: 0.75rem;
		border: 1px solid #c33;
		border-radius: 4px;
		cursor: pointer;
		background: white;
		color: #c33;
	}

	.btn-clear:hover {
		background: #fef0f0;
	}

	.btn-print {
		width: 100%;
		margin-top: 0.6rem;
		padding: 0.6rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		font-size: 0.82rem;
		font-weight: 600;
		border: none;
		border-radius: 6px;
		background: #1565c0;
		color: white;
		cursor: pointer;
		box-shadow: 0 1px 3px rgba(21, 101, 192, 0.35);
		transition: background 0.15s, box-shadow 0.15s;
	}

	.btn-print:hover {
		background: #0f4c98;
		box-shadow: 0 2px 6px rgba(21, 101, 192, 0.45);
	}

	.btn-print:active {
		background: #0d4080;
	}

	.board-container {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		background: white;
		border-radius: 8px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
		overflow: hidden;
	}

	.board {
		width: 100%;
		height: 100%;
		max-height: 100%;
		cursor: crosshair;
		touch-action: none;
	}

	.grid-cell {
		fill: none;
		stroke: #ddd;
		stroke-width: 0.5;
	}

	.edge-cell {
		stroke: #e6ddd0;
		stroke-dasharray: 2 2;
	}

	.placed-piece {
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.placed-piece:hover {
		opacity: 0.75;
		stroke: #c33;
		stroke-width: 1.2;
	}

	@media (max-width: 700px) {
		.parquetry-app {
			flex-direction: column;
			height: auto;
		}

		.palette {
			flex: none;
		}

		.board-container {
			aspect-ratio: 1 / 1;
		}
	}
</style>