<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import {
		buildBoard, diamondPoly, edgePoly, shapePoly, polyToPoints, pointInPoly,
		rotatedViewBox, geoFor, rotStepFor, grainById,
		GRAINS, SHAPES,
		type Grain, type Shape, type Mode, type EdgeKind
	} from '$lib/grid';
	import PrintPreview from './PrintPreview.svelte';

	const COLS = 5;
	const JMAX = 8;
	const PAD = 14;

	// ---- State ----
	let mode = $state<Mode>('rhombus60');
	let rotation = $state(0);
	let selectedShape = $state<Shape | null>(null);
	let selectedGrain = $state<Grain | null>(null);
	let showPrint = $state(false);

	// Placed pieces. Diamond keys: "d:i,j" or "d:i,j:sub". Edge keys: "e:i,j".
	type Placed =
		| { t: 'd'; i: number; j: number; shape: Shape; grain: Grain }
		| { t: 'e'; i: number; j: number; kind: EdgeKind; grain: Grain };
	const pieces = new SvelteMap<string, Placed>();

	let hover = $state<{ kind: 'd' | 'e'; i: number; j: number; edge?: EdgeKind } | null>(null);
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
	function diamondConflicts(i: number, j: number, shape: Shape): string[] {
		const base = `d:${i},${j}`;
		if (shape === 'diamond') {
			return [base, `${base}:top`, `${base}:bottom`, `${base}:left`, `${base}:right`];
		}
		const sub = shape.replace('tri-', '');
		const keys = [base];
		if (sub === 'top' || sub === 'bottom') keys.push(`${base}:left`, `${base}:right`);
		else keys.push(`${base}:top`, `${base}:bottom`);
		return keys;
	}

	function placeDiamond(i: number, j: number, shape: Shape, grain: Grain) {
		for (const ck of diamondConflicts(i, j, shape)) pieces.delete(ck);
		const key = shape === 'diamond' ? `d:${i},${j}` : `d:${i},${j}:${shape.replace('tri-', '')}`;
		pieces.set(key, { t: 'd', i, j, shape, grain });
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

	// ---- Palette ----
	function selectPiece(shape: Shape, grain: Grain) {
		if (selectedShape === shape && selectedGrain === grain) {
			selectedShape = null;
			selectedGrain = null;
		} else {
			selectedShape = shape;
			selectedGrain = grain;
		}
	}

	function deselect() {
		selectedShape = null;
		selectedGrain = null;
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
		if (!selectedGrain) {
			hover = null;
			return;
		}
		const { x, y } = localPoint(e);
		hover = hitSlot(x, y);
	}

	function handleBoardClick(e: PointerEvent) {
		if (!selectedGrain) return;
		const { x, y } = localPoint(e);
		const hit = hitSlot(x, y);
		if (!hit) return;
		if (hit.kind === 'd') {
			placeDiamond(hit.i, hit.j, selectedShape ?? 'diamond', selectedGrain);
		} else if (hit.edge) {
			placeEdge(hit.i, hit.j, hit.edge, selectedGrain);
		}
		hover = null;
	}

	function handleBoardLeave() {
		hover = null;
	}

	function handlePieceClick(key: string, e: Event) {
		e.stopPropagation();
		removePiece(key);
	}

	function handlePieceKey(key: string, e: KeyboardEvent) {
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
		if (p.t === 'd') {
			const cx = p.i * geo.halfW;
			const cy = p.j * geo.halfH;
			return polyToPoints(shapePoly(p.shape, cx, cy, geo));
		}
		const cx = p.i * geo.halfW;
		const cy = p.j * geo.halfH;
		return polyToPoints(edgePoly(p.kind, cx, cy, geo));
	}

	// Preview polygon points for the hovered slot
	const previewPoints = $derived.by(() => {
		if (!hover || !selectedGrain) return null;
		if (hover.kind === 'd') {
			const cx = hover.i * geo.halfW;
			const cy = hover.j * geo.halfH;
			return polyToPoints(shapePoly(selectedShape ?? 'diamond', cx, cy, geo));
		}
		if (hover.edge) {
			const cx = hover.i * geo.halfW;
			const cy = hover.j * geo.halfH;
			return polyToPoints(edgePoly(hover.edge, cx, cy, geo));
		}
		return null;
	});
</script>

<div class="parquetry-app">
	<div class="palette">
		<h3>Grid</h3>
		<div class="mode-toggle">
			<button class:active={mode === 'rhombus60'} onclick={() => setMode('rhombus60')}>
				30° / 60° Diamonds
			</button>
			<button class:active={mode === 'square'} onclick={() => setMode('square')}>
				45° Squares
			</button>
		</div>

		<div class="rotate-controls">
			<button onclick={() => rotateBy(-rotStep)} title="Rotate left {rotStep}°">⟲</button>
			<span class="rot-readout">{rotation}°</span>
			<button onclick={() => rotateBy(rotStep)} title="Rotate right {rotStep}°">⟳</button>
			<button class="rot-reset" onclick={resetRotation} disabled={rotation === 0}>Reset</button>
		</div>

		<h3>Pieces</h3>
		<div class="palette-grid">
			{#each GRAINS as grain (grain.id)}
				<div class="palette-col">
					<span class="grain-label">{grain.label}</span>
					{#each SHAPES as shape (shape.id)}
						<button
							class="palette-piece"
							class:selected={selectedShape === shape.id && selectedGrain === grain.id}
							onclick={() => selectPiece(shape.id, grain.id)}
							title="{grain.label} {shape.label}"
						>
							<svg viewBox="-36 -36 72 72" width="42" height="42">
								<defs>
									{#if grain.spacing > 0}
										<pattern
											id="pal-{grain.id}"
											width={grain.spacing}
											height={grain.spacing}
											patternUnits="userSpaceOnUse"
											patternTransform="rotate({grain.angle})"
										>
											<rect width={grain.spacing} height={grain.spacing} fill={grain.base} />
											<line x1="0" y1="0" x2={grain.spacing} y2="0" stroke={grain.stroke} stroke-width={grain.strokeWidth} />
										</pattern>
									{/if}
								</defs>
								<polygon
									points={polyToPoints(shapePoly(shape.id, 0, 0, geo))}
									fill={grain.id === 'none' ? grain.base : `url(#pal-${grain.id})`}
									stroke="black"
									stroke-width="1.5"
								/>
							</svg>
							<span class="piece-label">{shape.label}</span>
						</button>
					{/each}
				</div>
			{/each}
		</div>
		<p class="edge-note">Edge and corner triangles around the border are fillable too. Pick any grain, then click them.</p>

		<div class="palette-actions">
			<button class="btn-deselect" onclick={deselect}>Deselect</button>
			<button class="btn-clear" onclick={clearAll}>Clear All</button>
		</div>
		<button class="btn-print" onclick={() => (showPrint = true)}>Print / Export…</button>

		{#if selectedGrain}
			<p class="hint">Click any slot to place. Click a placed piece to remove it.</p>
		{:else}
			<p class="hint">Select a piece above, then click on the board to place it.</p>
		{/if}
	</div>

	<div class="board-container">
		<svg
			{viewBox}
			class="board"
			class:has-selection={selectedGrain !== null}
			onpointermove={handleBoardMove}
			onpointerup={handleBoardClick}
			onpointerleave={handleBoardLeave}
			role="application"
			aria-label="Parquetry design board"
		>
			<defs>
				{#each GRAINS as grain (grain.id)}
					{#if grain.spacing > 0}
						<pattern
							id="grain-{grain.id}"
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

			<g bind:this={gridEl} transform="rotate({rotation} {pivotX} {pivotY})">
				<!-- Slot outlines -->
				<g class="grid-layer">
					{#each board.diamonds as d (d.key)}
						<polygon points={polyToPoints(diamondPoly(d.cx, d.cy, geo))} class="grid-cell" />
					{/each}
					{#each board.edges as ed (ed.key)}
						<polygon points={polyToPoints(edgePoly(ed.kind, ed.cx, ed.cy, geo))} class="grid-cell edge-cell" />
					{/each}
				</g>

				<!-- Placed pieces -->
				<g class="pieces-layer">
					{#each placedEntries as [key, p] (key)}
						<polygon
							points={placedPoints(p)}
							fill={grainFill(p.grain)}
							stroke="black"
							stroke-width="0.8"
							class="placed-piece"
							onclick={(e) => handlePieceClick(key, e)}
							onkeydown={(e) => handlePieceKey(key, e)}
							role="button"
							tabindex="0"
							aria-label="Placed piece, click to remove"
						/>
					{/each}
				</g>

				<!-- Hover preview -->
				{#if previewPoints && selectedGrain}
					<polygon
						points={previewPoints}
						fill={grainFill(selectedGrain)}
						stroke="dodgerblue"
						stroke-width="1.2"
						opacity="0.5"
						pointer-events="none"
					/>
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

	.mode-toggle {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.75rem;
	}

	.mode-toggle button {
		flex: 1;
		padding: 0.45rem 0.4rem;
		font-size: 0.72rem;
		border: 1px solid #ccc;
		border-radius: 5px;
		background: white;
		cursor: pointer;
		transition: all 0.15s;
	}

	.mode-toggle button.active {
		border-color: dodgerblue;
		background: #e8f0ff;
		color: #1565c0;
		font-weight: 600;
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

	.palette-grid {
		display: flex;
		gap: 0.25rem;
	}

	.palette-col {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		flex: 1;
	}

	.grain-label {
		font-size: 0.65rem;
		font-weight: 600;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.palette-piece {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 4px;
		border: 2px solid transparent;
		border-radius: 6px;
		background: none;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}

	.palette-piece:hover {
		background: #f0ede8;
	}

	.palette-piece.selected {
		border-color: dodgerblue;
		background: #e8f0ff;
	}

	.piece-label {
		font-size: 0.55rem;
		color: #888;
	}

	.edge-note {
		margin: 0.6rem 0 0;
		font-size: 0.7rem;
		color: #999;
		line-height: 1.4;
	}

	.palette-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.palette-actions button {
		flex: 1;
		padding: 0.4rem 0.5rem;
		font-size: 0.75rem;
		border: 1px solid #ccc;
		border-radius: 4px;
		cursor: pointer;
		background: white;
	}

	.btn-clear {
		color: #c33;
		border-color: #c33 !important;
	}

	.btn-clear:hover {
		background: #fef0f0 !important;
	}

	.btn-deselect:hover {
		background: #f0f0f0;
	}

	.btn-print {
		width: 100%;
		margin-top: 0.5rem;
		padding: 0.5rem;
		font-size: 0.8rem;
		border: 1px solid #1565c0;
		border-radius: 5px;
		background: #e8f0ff;
		color: #1565c0;
		font-weight: 600;
		cursor: pointer;
	}

	.btn-print:hover {
		background: #d8e8ff;
	}

	.hint {
		margin-top: 0.75rem;
		font-size: 0.75rem;
		color: #888;
		line-height: 1.4;
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
	}

	.board.has-selection {
		cursor: crosshair;
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

		.palette-grid {
			flex-wrap: wrap;
			justify-content: center;
		}
	}
</style>