<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import {
		centre, diamondPoints, shapePoints,
		nearestSlot, buildSlots, slotsBBox, rotatedViewBox,
		geoFor, rotStepFor,
		GRAINS, SHAPES,
		type Grain, type Shape, type Mode
	} from '$lib/grid';

	const COLS = 6;
	const HALF_ROWS = 8;
	const PAD = 12;

	// ---- State ----
	let mode = $state<Mode>('rhombus60');
	let rotation = $state(0);

	let selectedShape = $state<Shape | null>(null);
	let selectedGrain = $state<Grain | null>(null);

	const pieces = new SvelteMap<string, { shape: Shape; grain: Grain }>();

	let hoverSlot = $state<{ row: number; col: number } | null>(null);

	let gridEl: SVGGElement;

	// ---- Derived geometry ----
	const geo = $derived(geoFor(mode));
	const gridSlots = $derived(buildSlots(COLS, HALF_ROWS, geo));
	const bbox = $derived(slotsBBox(gridSlots, geo));
	const viewBox = $derived(rotatedViewBox(bbox, rotation, PAD));
	const pivotX = $derived((bbox.minX + bbox.maxX) / 2);
	const pivotY = $derived((bbox.minY + bbox.maxY) / 2);
	const rotStep = $derived(rotStepFor(mode));
	const placedEntries = $derived(Array.from(pieces.entries()));

	// ---- Piece key logic ----
	function pieceKey(row: number, col: number, shape: Shape): string {
		if (shape === 'diamond') return `${row},${col}`;
		const sub = shape.replace('tri-', '');
		return `${row},${col},${sub}`;
	}

	function conflictKeys(row: number, col: number, shape: Shape): string[] {
		const base = `${row},${col}`;
		if (shape === 'diamond') {
			return [base, `${base},top`, `${base},bottom`, `${base},left`, `${base},right`];
		}
		const sub = shape.replace('tri-', '');
		const keys = [base];
		if (sub === 'top' || sub === 'bottom') {
			keys.push(`${base},left`, `${base},right`);
		} else {
			keys.push(`${base},top`, `${base},bottom`);
		}
		return keys;
	}

	function placePiece(row: number, col: number, shape: Shape, grain: Grain) {
		const key = pieceKey(row, col, shape);
		for (const ck of conflictKeys(row, col, shape)) {
			pieces.delete(ck);
		}
		pieces.set(key, { shape, grain });
	}

	function removePiece(key: string) {
		pieces.delete(key);
	}

	function clearAll() {
		pieces.clear();
	}

	// ---- Palette selection ----
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

	// ---- Mode + rotation controls ----
	function setMode(m: Mode) {
		if (m === mode) return;
		mode = m;
		// Snap rotation onto the new mode's step grid
		const step = rotStepFor(m);
		rotation = (Math.round(rotation / step) * step) % 360;
	}

	function rotateBy(delta: number) {
		rotation = (((rotation + delta) % 360) + 360) % 360;
	}

	function resetRotation() {
		rotation = 0;
	}

	// ---- Board interaction ----
	function svgPoint(e: PointerEvent): { x: number; y: number } {
		// gridEl's CTM already includes the rotation transform, so this maps
		// the pointer straight into grid-local (unrotated) coordinates.
		const ctm = gridEl.getScreenCTM();
		if (!ctm) return { x: 0, y: 0 };
		const svg = gridEl.ownerSVGElement!;
		const pt = svg.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const p = pt.matrixTransform(ctm.inverse());
		return { x: p.x, y: p.y };
	}

	function handleBoardMove(e: PointerEvent) {
		if (!selectedShape || !selectedGrain) {
			hoverSlot = null;
			return;
		}
		const { x, y } = svgPoint(e);
		const slot = nearestSlot(x, y, COLS, HALF_ROWS, geo);
		if (slot && slot.dist < geo.halfH) {
			hoverSlot = { row: slot.row, col: slot.col };
		} else {
			hoverSlot = null;
		}
	}

	function handleBoardClick(e: PointerEvent) {
		if (!selectedShape || !selectedGrain) return;
		const { x, y } = svgPoint(e);
		const slot = nearestSlot(x, y, COLS, HALF_ROWS, geo);
		if (!slot || slot.dist > geo.halfH) return;
		placePiece(slot.row, slot.col, selectedShape, selectedGrain);
		hoverSlot = null;
	}

	function handleBoardLeave() {
		hoverSlot = null;
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

	function grainFill(grain: Grain): string {
		if (grain === 'none') {
			const def = GRAINS.find((g) => g.id === 'none');
			return def ? def.base : 'white';
		}
		return `url(#grain-${grain})`;
	}
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
							<svg viewBox="-36 -36 72 72" width="44" height="44">
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
											<line
												x1="0" y1="0" x2={grain.spacing} y2="0"
												stroke={grain.stroke} stroke-width={grain.strokeWidth}
											/>
										</pattern>
									{/if}
								</defs>
								<polygon
									points={shapePoints(shape.id, 0, 0, geo)}
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

		<div class="palette-actions">
			<button class="btn-deselect" onclick={deselect}>Deselect</button>
			<button class="btn-clear" onclick={clearAll}>Clear All</button>
		</div>

		{#if selectedShape && selectedGrain}
			<p class="hint">Click a grid slot to place. Click a placed piece to remove it.</p>
		{:else}
			<p class="hint">Select a piece above, then click on the board to place it.</p>
		{/if}
	</div>

	<div class="board-container">
		<svg
			{viewBox}
			class="board"
			class:has-selection={selectedShape !== null}
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
							<line
								x1="0" y1="0" x2={grain.spacing} y2="0"
								stroke={grain.stroke} stroke-width={grain.strokeWidth}
							/>
						</pattern>
					{/if}
				{/each}
			</defs>

			<g bind:this={gridEl} transform="rotate({rotation} {pivotX} {pivotY})">
				<g class="grid-layer">
					{#each gridSlots as slot (slot.key)}
						<polygon points={diamondPoints(slot.cx, slot.cy, geo)} class="grid-cell" />
					{/each}
				</g>

				<g class="pieces-layer">
					{#each placedEntries as [key, piece] (key)}
						{@const parts = key.split(',')}
						{@const row = parseInt(parts[0])}
						{@const col = parseInt(parts[1])}
						{@const c = centre(row, col, geo)}
						<polygon
							points={shapePoints(piece.shape, c.x, c.y, geo)}
							fill={grainFill(piece.grain)}
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

				{#if hoverSlot && selectedShape && selectedGrain}
					{@const c = centre(hoverSlot.row, hoverSlot.col, geo)}
					<polygon
						points={shapePoints(selectedShape, c.x, c.y, geo)}
						fill={grainFill(selectedGrain)}
						stroke="dodgerblue"
						stroke-width="1.2"
						opacity="0.5"
						class="preview"
						pointer-events="none"
					/>
				{/if}
			</g>
		</svg>
	</div>
</div>

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

	.placed-piece {
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.placed-piece:hover {
		opacity: 0.75;
		stroke: #c33;
		stroke-width: 1.2;
	}

	.preview {
		pointer-events: none;
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