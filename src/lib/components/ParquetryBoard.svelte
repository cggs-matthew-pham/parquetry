<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import {
		buildBoard, pointInPoly, rotatedViewBox, rotStepFor, polyCentroid,
		makeRoot, seedRegion, applyTool, leaves, previewTool, findLeaf, toolsForMode,
		MODES,
		type Mode, type Cell, type Tool, type Division, type Region, type Pt
	} from '$lib/grid';
	import PrintPreview from './PrintPreview.svelte';

	const PAD = 14;

	// ---- State ----
	let mode = $state<Mode>('square');
	let rotation = $state(0);
	let tool = $state<Tool>('half');
	let halfAxis = $state<'h' | 'v'>('h'); // resolved live from cursor for the Half tool
	let showPrint = $state(false);

	// Mode-independent persistence: each mode keeps its own design — a map of
	// cell id -> region tree. Absent = undivided.
	const designs: Record<Mode, SvelteMap<string, Region>> = {
		square: new SvelteMap(),
		tall: new SvelteMap(),
		flat: new SvelteMap()
	};

	let hover = $state<{ x: number; y: number } | null>(null);
	let svgEl: SVGSVGElement;
	let gridEl: SVGGElement;

	// ---- Derived ----
	const board = $derived(buildBoard(mode));
	const viewBox = $derived(rotatedViewBox(board.w, board.h, rotation, PAD));
	const pivotX = $derived(board.w / 2);
	const pivotY = $derived(board.h / 2);
	const rotStep = $derived(rotStepFor(mode));
	const design = $derived(designs[mode]);
	const tools = $derived(toolsForMode(mode));

	// A render-ready list of every leaf face on the board.
	const faces = $derived.by(() => {
		const out: { id: string; poly: Pt[] }[] = [];
		for (const cell of board.cells) {
			const region = design.get(cell.id);
			if (!region) {
				out.push({ id: cell.id, poly: cell.poly });
			} else {
				leaves(region).forEach((lf, k) => out.push({ id: `${cell.id}#${k}`, poly: lf.poly }));
			}
		}
		return out;
	});

	// ---- Mode + rotation ----
	function setMode(m: Mode) {
		if (m === mode) return;
		mode = m;
		const step = rotStepFor(m);
		rotation = (Math.round(rotation / step) * step) % 360;
		if (!tools.some((t) => t.id === tool)) tool = 'half';
	}

	function rotateBy(d: number) {
		rotation = (((rotation + d) % 360) + 360) % 360;
	}
	function resetRotation() { rotation = 0; }
	function clearBoard() { design.clear(); }

	// ---- Tool cycling (keyboard + wheel) ----
	function cycleTool(dir: number) {
		const ids = tools.map((t) => t.id);
		const i = ids.indexOf(tool);
		tool = ids[(i + dir + ids.length) % ids.length];
	}

	function handleKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
		if (e.key >= '1' && e.key <= '9') {
			const i = Number(e.key) - 1;
			if (i < tools.length) { tool = tools[i].id; e.preventDefault(); }
		} else if (e.key === ']' || e.key === 'ArrowRight') { cycleTool(1); e.preventDefault(); }
		else if (e.key === '[' || e.key === 'ArrowLeft') { cycleTool(-1); e.preventDefault(); }
	}

	$effect(() => {
		const el = svgEl;
		if (!el) return;
		const onWheel = (e: WheelEvent) => { e.preventDefault(); cycleTool(e.deltaY > 0 ? 1 : -1); };
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	// ---- Hit testing ----
	function localPoint(e: PointerEvent): { x: number; y: number } {
		const ctm = gridEl.getScreenCTM();
		if (!ctm) return { x: -1e9, y: -1e9 };
		const svg = gridEl.ownerSVGElement!;
		const pt = svg.createSVGPoint();
		pt.x = e.clientX; pt.y = e.clientY;
		const p = pt.matrixTransform(ctm.inverse());
		return { x: p.x, y: p.y };
	}

	function cellAt(x: number, y: number): Cell | null {
		for (const cell of board.cells) if (pointInPoly(x, y, cell.poly)) return cell;
		return null;
	}

	// Resolve the UI tool to an actual geometric division. For 'half', use the
	// live hover-resolved axis; for the others it's direct.
	function divisionFor(t: Exclude<Tool, 'whole'>): Division {
		if (t === 'half') return halfAxis === 'h' ? 'half-h' : 'half-v';
		return t;
	}

	// Update the Half axis from cursor position, but only when hovering an
	// undivided full cell (a half/quarter/edge has a forced or no cut). A small
	// margin gives hysteresis so the preview doesn't flicker near the diagonal.
	function updateHalfAxis(x: number, y: number, cell: Cell) {
		const region = design.get(cell.id) ?? seedRegion(cell);
		const leaf = findLeaf(region, x, y);
		if (!leaf || !leaf.root) return; // only undivided full cells have a choice
		const [lx, ly] = polyCentroid(leaf.poly);
		const dx = Math.abs(x - lx), dy = Math.abs(y - ly);
		if (dy > dx * 1.15) halfAxis = 'h';
		else if (dx > dy * 1.15) halfAxis = 'v';
	}

	function handleMove(e: PointerEvent) {
		const p = localPoint(e);
		hover = p;
		if (tool === 'half') {
			const cell = cellAt(p.x, p.y);
			if (cell) updateHalfAxis(p.x, p.y, cell);
		}
	}

	function handleClick(e: PointerEvent) {
		const { x, y } = localPoint(e);
		const cell = cellAt(x, y);
		if (!cell) return;

		if (tool === 'whole') {
			design.delete(cell.id); // reset whole cell
			return;
		}
		if (tool === 'half') updateHalfAxis(x, y, cell); // ensure axis matches click point
		const current = design.get(cell.id) ?? seedRegion(cell);
		const next = applyTool(current, x, y, divisionFor(tool));
		design.set(cell.id, next);
	}

	function handleLeave() { hover = null; }

	// ---- Preview ----
	const preview = $derived.by((): { reset: true; poly: Pt[] }
		| { reset: false; faces: { poly: Pt[]; active: boolean }[] }
		| null => {
		if (!hover) return null;
		const cell = cellAt(hover.x, hover.y);
		if (!cell) return null;
		if (tool === 'whole') {
			return { reset: true, poly: cell.poly };
		}
		const region = design.get(cell.id) ?? seedRegion(cell);
		const result = previewTool(region, hover.x, hover.y, divisionFor(tool));
		if (!result) return null;
		const faces = result.map((poly) => ({ poly, active: pointInPoly(hover!.x, hover!.y, poly) }));
		return { reset: false, faces };
	});

	// Icons: subdivide a sample cell of the current mode to show each tool's result
	function toolIcon(t: Tool): Pt[][] {
		const sample = mode === 'square'
			? [[-30, -30], [30, -30], [30, 30], [-30, 30]] as Pt[]
			: [[0, -34], [30, 0], [0, 34], [-30, 0]] as Pt[];
		if (t === 'whole') return [sample];
		const div: Division = t === 'half' ? 'half-h' : t;
		const r = applyTool(makeRoot(sample), 0, 0, div);
		return leaves(r).map((l) => l.poly);
	}
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

		<h3>Subdivide</h3>
		<div class="tool-grid">
			{#each tools as t, idx (t.id)}
				<button class="tool-btn" class:active={tool === t.id} onclick={() => (tool = t.id)} title="{t.label}  ({idx + 1})">
					<svg viewBox="-38 -40 76 80" width="42" height="42">
						<polygon points={(mode === 'square'
							? [[-30,-30],[30,-30],[30,30],[-30,30]]
							: [[0,-34],[30,0],[0,34],[-30,0]]).map((p) => p.join(',')).join(' ')}
							fill="none" stroke="#ddd" stroke-width="1.5" />
						{#each toolIcon(t.id) as f, fi (fi)}
							<polygon points={f.map((p) => p.join(',')).join(' ')} fill="#e8e0d2" stroke="#666" stroke-width="2" />
						{/each}
					</svg>
					<span>{t.label}</span>
				</button>
			{/each}
		</div>
		<p class="cycle-note">
			Click a cell to subdivide it. Click a half to split it once more. Keys 1–{tools.length},
			← →, or scroll to switch tool. "Whole" resets a cell.
		</p>

		<div class="palette-actions">
			<button class="btn-clear" onclick={clearBoard}>Clear {mode}</button>
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
			onpointermove={handleMove}
			onpointerup={handleClick}
			onpointerleave={handleLeave}
			role="application"
			aria-label="Parquetry design board"
		>
			<g bind:this={gridEl} transform="rotate({rotation} {pivotX} {pivotY})">
				{#each faces as face (face.id)}
					<polygon points={face.poly.map(([x, y]) => `${x},${y}`).join(' ')} class="face" />
				{/each}

				{#if preview}
					{#if preview.reset}
						<polygon points={preview.poly.map(([x, y]) => `${x},${y}`).join(' ')} class="preview-reset" pointer-events="none" />
					{:else}
						{#each preview.faces as f, fi (fi)}
							<polygon points={f.poly.map(([x, y]) => `${x},${y}`).join(' ')} class:preview-face={!f.active} class:preview-face-active={f.active} pointer-events="none" />
						{/each}
					{/if}
				{/if}
			</g>
		</svg>
	</div>
</div>

{#if showPrint}
	<PrintPreview {board} {mode} {rotation} {design} onClose={() => (showPrint = false)} />
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

	.palette h3 { margin: 0 0 0.5rem; font-size: 1rem; color: #333; }
	.palette h3:not(:first-child) { margin-top: 1.25rem; }

	.mode-pills { display: flex; gap: 0.4rem; margin-bottom: 0.75rem; }

	.pill {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px;
		padding: 0.4rem 0.3rem; border: 1px solid #ccc; border-radius: 999px;
		background: white; cursor: pointer; transition: all 0.15s;
	}
	.pill-label { font-size: 0.74rem; font-weight: 600; color: #444; }
	.pill-sub { font-size: 0.6rem; color: #999; }
	.pill.active { border-color: dodgerblue; background: #e8f0ff; }
	.pill.active .pill-label { color: #1565c0; }
	.pill.active .pill-sub { color: #4a90d9; }

	.rotate-controls { display: flex; align-items: center; gap: 0.4rem; }
	.rotate-controls button {
		padding: 0.35rem 0.6rem; font-size: 1rem; border: 1px solid #ccc;
		border-radius: 5px; background: white; cursor: pointer; line-height: 1;
	}
	.rotate-controls button:hover { background: #f0f0f0; }
	.rot-readout { min-width: 3rem; text-align: center; font-size: 0.85rem; font-variant-numeric: tabular-nums; color: #444; }
	.rot-reset { margin-left: auto; font-size: 0.72rem !important; padding: 0.35rem 0.5rem !important; }
	.rot-reset:disabled { opacity: 0.4; cursor: default; }

	.tool-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.35rem; }

	.tool-btn {
		display: flex; flex-direction: column; align-items: center; gap: 2px;
		padding: 4px 2px; border: 2px solid transparent; border-radius: 6px;
		background: #f5f2ec; cursor: pointer; transition: border-color 0.15s, background 0.15s;
	}
	.tool-btn span { font-size: 0.62rem; color: #777; }
	.tool-btn:hover { background: #ece6db; }
	.tool-btn.active { border-color: dodgerblue; background: #e8f0ff; }
	.tool-btn.active span { color: #1565c0; }

	.cycle-note { margin: 0.6rem 0 0; font-size: 0.7rem; color: #999; line-height: 1.5; }

	.palette-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
	.btn-clear {
		flex: 1; padding: 0.4rem 0.5rem; font-size: 0.75rem; border: 1px solid #c33;
		border-radius: 4px; cursor: pointer; background: white; color: #c33; text-transform: capitalize;
	}
	.btn-clear:hover { background: #fef0f0; }

	.btn-print {
		width: 100%; margin-top: 0.6rem; padding: 0.6rem; display: inline-flex;
		align-items: center; justify-content: center; gap: 0.4rem; font-size: 0.82rem;
		font-weight: 600; border: none; border-radius: 6px; background: #1565c0; color: white;
		cursor: pointer; box-shadow: 0 1px 3px rgba(21, 101, 192, 0.35);
	}
	.btn-print:hover { background: #0f4c98; }

	.board-container {
		flex: 1; display: flex; align-items: center; justify-content: center;
		background: white; border-radius: 8px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1); overflow: hidden;
	}
	.board { width: 100%; height: 100%; max-height: 100%; cursor: crosshair; touch-action: none; }

	.face { fill: white; stroke: #bbb; stroke-width: 0.7; }
	.preview-face { fill: rgba(30, 120, 220, 0.08); stroke: dodgerblue; stroke-width: 1.1; }
	.preview-face-active { fill: rgba(30, 120, 220, 0.26); stroke: dodgerblue; stroke-width: 1.1; }
	.preview-reset { fill: rgba(200, 60, 60, 0.06); stroke: #c33; stroke-width: 1.1; stroke-dasharray: 3 2; }

	@media (max-width: 700px) {
		.parquetry-app { flex-direction: column; height: auto; }
		.palette { flex: none; }
		.board-container { aspect-ratio: 1 / 1; }
	}
</style>