<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import {
		buildBoard, pointInPoly, pointInPolyGeneral, rotatedViewBox, rotStepFor, polyCentroid,
		makeRoot, seedRegion, applyTool, leaves, previewTool, findLeaf, toolsForMode,
		unionOutline, mergeId, grainById,
		regionToLean, rebuildRegion, isGrain, DOC_VERSION, stateKeyOf, ORIENTATIONS, MM_PER_UNIT,
		MODES, GRAINS,
		type Mode, type Orientation, type Cell, type Tool, type Division, type Region, type Pt, type MergeGroup, type Grain,
		type DesignDoc, type LeanMode, type LeanCell, type StateKey, type LeanInset
	} from '$lib/grid';
	import { insetLeafEntries, insetToLean, rebuildInset, type InsetRegion } from '$lib/marquetry';
	import PrintPreview from './PrintPreview.svelte';
	import MarquetryEditor from './MarquetryEditor.svelte';

	const PAD = 14;
	// Screen scale for "actual size": CSS px per unit ≈ true physical size, since
	// units → mm via MM_PER_UNIT and CSS assumes ~96px/inch. Keeps a cell the same
	// on-screen size across every mode and orientation.
	const PX_PER_UNIT = MM_PER_UNIT * (96 / 25.4);
	const MODE_IDS: Mode[] = ['square', 'diamond', 'tall', 'flat'];
	type EditMode = 'subdivide' | 'merge' | 'colour' | 'marquetry';
	type Paint = Grain | 'erase';

	// ---- State ----
	let mode = $state<Mode>('square');         // grid tessellation
	let orientation = $state<Orientation>('landscape');
	let editMode = $state<EditMode>('subdivide'); // working mode
	let rotation = $state(0);
	let tool = $state<Tool>('half');
	let halfAxis = $state<'h' | 'v'>('h');
	let paint = $state<Paint>('mid');          // selected wood (or erase) for colour mode
	let zoom = $state<'actual' | 'fit'>('actual'); // actual = consistent size (scrolls); fit = whole board
	let showPrint = $state(false);

	// Per (mode × orientation) persistence: subdivisions, merges, face colours.
	// Eight independent state slots, keyed "mode:orientation".
	function emptyState<V>(): Record<string, SvelteMap<string, V>> {
		const r: Record<string, SvelteMap<string, V>> = {};
		for (const m of MODE_IDS) for (const o of ORIENTATIONS) r[stateKeyOf(m, o)] = new SvelteMap<string, V>();
		return r;
	}
	const designs = emptyState<Region>();
	const mergeGroups = emptyState<MergeGroup>();
	const colourMaps = emptyState<Grain>();
	const insetMaps = emptyState<InsetRegion>();
	// Transient merge selection (cleared on commit / mode switch).
	const selection = new SvelteSet<string>();

	// Marquetry drill-in: the face currently open for cut work, or null.
	let drill = $state<{ id: string; poly: Pt[] } | null>(null);

	let hover = $state<{ x: number; y: number } | null>(null);
	let gridEl: SVGGElement;

	// ---- Derived ----
	const stateKey = $derived(stateKeyOf(mode, orientation) as StateKey);
	const board = $derived(buildBoard(mode, orientation));
	const viewBox = $derived(rotatedViewBox(board.w, board.h, rotation, PAD));
	// viewBox is "minX minY w h"; at actual size the SVG renders at a fixed px/unit.
	const vbDims = $derived(viewBox.split(' ').map(Number));
	const pxW = $derived(vbDims[2] * PX_PER_UNIT);
	const pxH = $derived(vbDims[3] * PX_PER_UNIT);
	const pivotX = $derived(board.w / 2);
	const pivotY = $derived(board.h / 2);
	const rotStep = $derived(rotStepFor(mode));
	const design = $derived(designs[stateKey]);
	const merges = $derived(mergeGroups[stateKey]);
	const colours = $derived(colourMaps[stateKey]);
	const insets = $derived(insetMaps[stateKey]);
	const tools = $derived(toolsForMode(mode));

	function grainFill(g: Grain): string {
		const def = grainById(g);
		return def.spacing > 0 ? `url(#grain-${g})` : def.base;
	}
	function faceFill(id: string): string {
		const g = colours.get(id);
		return g ? grainFill(g) : 'white';
	}
	// Flat base colour (no grain pattern) for the drill-in editor's fills.
	function faceBaseFill(id: string): string {
		const g = colours.get(id);
		return g ? grainById(g).base : 'white';
	}

	// When a face's structure changes, its leaf-face ids change, so drop any
	// colours AND any marquetry inset bound to it. The prefix cascade covers both
	// subdivision leaves (id#k) and marquetry sub-pieces (id@path) under it.
	function pruneFace(rootId: string) {
		const hit = (key: string) =>
			key === rootId || key.startsWith(`${rootId}#`) || key.startsWith(`${rootId}@`);
		for (const key of [...colours.keys()]) if (hit(key)) colours.delete(key);
		for (const key of [...insets.keys()]) if (hit(key)) insets.delete(key);
	}

	// Cells consumed by a merge group → not rendered/handled individually.
	const consumed = $derived(
		new Set([...merges.values()].flatMap((g) => g.cellIds))
	);

	// All leaf faces: merge-group outlines + non-consumed cells' subdivisions.
	// Base faces: merge outlines + non-consumed cells' subdivisions (before
	// marquetry). A marquetry inset attaches to one of these ids.
	const baseFaces = $derived.by(() => {
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

	// Rendered faces: base faces, with any that carry an inset expanded into the
	// inset's sub-piece leaves (ids like `${faceId}@0`).
	const faces = $derived.by(() => {
		const out: { id: string; poly: Pt[] }[] = [];
		for (const f of baseFaces) {
			const inset = insets.get(f.id);
			if (inset) for (const e of insetLeafEntries(inset)) out.push({ id: f.id + e.path, poly: e.poly });
			else out.push(f);
		}
		return out;
	});

	const basePolyById = $derived(new Map(baseFaces.map((f) => [f.id, f.poly])));

	// A cell can join a merge if it's a full cell, not subdivided, not consumed.
	function eligible(cell: Cell): boolean {
		return cell.kind === 'cell' && !consumed.has(cell.id) && !design.has(cell.id);
	}

	const selectionUnion = $derived.by(() => {
		if (selection.size < 2) return null;
		const polys = board.cells.filter((c) => selection.has(c.id)).map((c) => c.poly);
		return unionOutline(polys);
	});
	const canMerge = $derived(selectionUnion !== null);

	// ---- Mode + rotation ----
	function setMode(m: Mode) {
		if (m === mode) return;
		mode = m;
		const step = rotStepFor(m);
		rotation = (Math.round(rotation / step) * step) % 360;
		if (!tools.some((t) => t.id === tool)) tool = 'half';
		selection.clear();
		drill = null;
	}

	function setOrientation(o: Orientation) {
		if (o === orientation) return;
		orientation = o;
		selection.clear();
		drill = null;
	}

	function setEditMode(em: EditMode) {
		editMode = em;
		selection.clear();
		drill = null;
	}

	function rotateBy(d: number) { rotation = (((rotation + d) % 360) + 360) % 360; }
	function resetRotation() { rotation = 0; }

	function clearBoard() {
		design.clear();
		merges.clear();
		colours.clear();
		insets.clear();
		selection.clear();
		drill = null;
	}

	// ---- Lean JSON export / import (whole document, all modes) ----
	let fileInput: HTMLInputElement;

	function buildDoc(): DesignDoc {
		const states: Record<string, LeanMode> = {};
		for (const m of MODE_IDS) {
			for (const o of ORIENTATIONS) {
				const key = stateKeyOf(m, o);
				const cells: Record<string, LeanCell> = {};
				for (const [id, region] of designs[key]) {
					const lean = regionToLean(region);
					if (lean) cells[id] = lean;
				}
				const insetsOut: Record<string, LeanInset> = {};
				for (const [id, reg] of insetMaps[key]) {
					const lean = insetToLean(reg);
					if (lean) insetsOut[id] = lean;
				}
				states[key] = {
					cells,
					merges: [...mergeGroups[key].values()].map((g) => g.cellIds),
					colours: Object.fromEntries(colourMaps[key]),
					insets: insetsOut
				};
			}
		}
		return { version: DOC_VERSION, states };
	}

	function exportDoc() {
		const blob = new Blob([JSON.stringify(buildDoc(), null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'parquetry-design.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	function loadState(m: Mode, o: Orientation, lm: LeanMode | undefined) {
		const key = stateKeyOf(m, o);
		const cellById = new Map(buildBoard(m, o).cells.map((c) => [c.id, c]));

		// Mutate the existing reactive maps so the deriveds update.
		designs[key].clear();
		mergeGroups[key].clear();
		colourMaps[key].clear();
		insetMaps[key].clear();
		if (!lm || typeof lm !== 'object') return;

		for (const [id, lean] of Object.entries(lm.cells ?? {})) {
			const cell = cellById.get(id);
			if (cell && lean && typeof lean.op === 'string') designs[key].set(id, rebuildRegion(cell, lean));
		}
		for (const ids of lm.merges ?? []) {
			const polys = ids.map((id) => cellById.get(id)?.poly).filter((p): p is Pt[] => !!p);
			if (polys.length === ids.length && ids.length >= 2) {
				const ring = unionOutline(polys);
				if (ring) { const id = mergeId(ids); mergeGroups[key].set(id, { id, cellIds: ids, poly: ring }); }
			}
		}
		for (const [id, g] of Object.entries(lm.colours ?? {})) {
			if (isGrain(g)) colourMaps[key].set(id, g);
		}

		// Rebuild marquetry insets by replaying their cuts on the recomputed faces.
		const consumedL = new Set([...mergeGroups[key].values()].flatMap((g) => g.cellIds));
		const polyById = new Map<string, Pt[]>();
		for (const g of mergeGroups[key].values()) polyById.set(g.id, g.poly);
		for (const cell of cellById.values()) {
			if (consumedL.has(cell.id)) continue;
			const region = designs[key].get(cell.id);
			if (!region) polyById.set(cell.id, cell.poly);
			else leaves(region).forEach((lf, k) => polyById.set(`${cell.id}#${k}`, lf.poly));
		}
		for (const [id, lean] of Object.entries(lm.insets ?? {})) {
			const poly = polyById.get(id);
			if (poly && lean) insetMaps[key].set(id, rebuildInset(poly, lean));
		}
	}

	function loadDoc(doc: any): boolean {
		if (!doc || typeof doc !== 'object') return false;

		// v2: states keyed "mode:orientation". v1: modes keyed by mode → load as landscape.
		let states: Record<string, LeanMode> | null = null;
		if (doc.version === DOC_VERSION && doc.states) {
			states = doc.states;
		} else if (doc.version === 1 && doc.modes) {
			states = {};
			for (const m of MODE_IDS) if (doc.modes[m]) states[stateKeyOf(m, 'landscape')] = doc.modes[m];
		}
		if (!states) return false;

		for (const m of MODE_IDS) {
			for (const o of ORIENTATIONS) loadState(m, o, states[stateKeyOf(m, o)]);
		}
		selection.clear();
		return true;
	}

	function onImportFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-importing the same file
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const doc = JSON.parse(String(reader.result));
				if (!loadDoc(doc)) alert('That file is not a valid parquetry design.');
			} catch {
				alert('Could not read that file as JSON.');
			}
		};
		reader.readAsText(file);
	}

	// ---- Cycling (keyboard) ----
	const EDIT_MODES: EditMode[] = ['subdivide', 'merge', 'colour', 'marquetry'];
	const PAINTS: Paint[] = [...GRAINS.map((g) => g.id), 'erase'];

	function cycleTool(dir: number) {
		const ids = tools.map((t) => t.id);
		const i = ids.indexOf(tool);
		tool = ids[(i + dir + ids.length) % ids.length];
	}
	function cyclePaint(dir: number) {
		const i = PAINTS.indexOf(paint);
		paint = PAINTS[(i + dir + PAINTS.length) % PAINTS.length];
	}
	function cycleEditMode(dir: number) {
		const i = EDIT_MODES.indexOf(editMode);
		setEditMode(EDIT_MODES[(i + dir + EDIT_MODES.length) % EDIT_MODES.length]);
	}

	function handleKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

		// Up/down switch the working mode (matches the vertical mode list).
		if (e.key === 'ArrowUp') { cycleEditMode(-1); e.preventDefault(); return; }
		if (e.key === 'ArrowDown') { cycleEditMode(1); e.preventDefault(); return; }

		// Left/right (and [ ]) cycle within the current mode.
		const back = e.key === 'ArrowLeft' || e.key === '[';
		const fwd = e.key === 'ArrowRight' || e.key === ']';
		if (back || fwd) {
			const dir = fwd ? 1 : -1;
			if (editMode === 'subdivide') { cycleTool(dir); e.preventDefault(); }
			else if (editMode === 'colour') { cyclePaint(dir); e.preventDefault(); }
			return;
		}

		// Number keys pick directly: subdivide tools, or colour swatches.
		if (e.key >= '1' && e.key <= '9') {
			const i = Number(e.key) - 1;
			if (editMode === 'subdivide' && i < tools.length) { tool = tools[i].id; e.preventDefault(); }
			else if (editMode === 'colour' && i < PAINTS.length) { paint = PAINTS[i]; e.preventDefault(); }
		}
	}

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

	function mergeAt(x: number, y: number): MergeGroup | null {
		for (const g of merges.values()) if (pointInPolyGeneral(x, y, g.poly)) return g;
		return null;
	}

	function divisionFor(t: Exclude<Tool, 'whole'>): Division {
		if (t === 'half') return halfAxis === 'h' ? 'half-h' : 'half-v';
		return t;
	}

	function updateHalfAxis(x: number, y: number, cell: Cell) {
		const region = design.get(cell.id) ?? seedRegion(cell);
		const leaf = findLeaf(region, x, y);
		if (!leaf || !leaf.root) return;
		const [lx, ly] = polyCentroid(leaf.poly);
		const dx = Math.abs(x - lx), dy = Math.abs(y - ly);
		if (dy > dx * 1.15) halfAxis = 'h';
		else if (dx > dy * 1.15) halfAxis = 'v';
	}

	function handleMove(e: PointerEvent) {
		const p = localPoint(e);
		hover = p;
		if (editMode === 'subdivide' && tool === 'half') {
			const cell = cellAt(p.x, p.y);
			if (cell && !consumed.has(cell.id)) updateHalfAxis(p.x, p.y, cell);
		}
	}

	// Which rendered face is under the cursor (leaf faces are convex, merge
	// regions can be non-convex, so use the general test for everything).
	function faceAt(x: number, y: number): string | null {
		for (const f of faces) if (pointInPolyGeneral(x, y, f.poly)) return f.id;
		return null;
	}

	function handleClick(e: PointerEvent) {
		const { x, y } = localPoint(e);

		if (editMode === 'marquetry') {
			const id = faceAt(x, y);
			if (!id) return;
			const owner = id.split('@')[0]; // a sub-piece maps back to its inset owner
			const poly = basePolyById.get(owner);
			if (poly) drill = { id: owner, poly };
			return;
		}

		if (editMode === 'colour') {
			const id = faceAt(x, y);
			if (!id) return;
			if (paint === 'erase') colours.delete(id);
			else colours.set(id, paint);
			return;
		}

		if (editMode === 'merge') {
			const g = mergeAt(x, y);
			if (g) { merges.delete(g.id); pruneFace(g.id); return; } // unmerge
			const cell = cellAt(x, y);
			if (!cell || !eligible(cell)) return;
			if (selection.has(cell.id)) selection.delete(cell.id);
			else selection.add(cell.id);
			return;
		}

		// subdivide mode
		const cell = cellAt(x, y);
		if (!cell || consumed.has(cell.id)) return;
		pruneFace(cell.id); // structure is changing → drop stale face colours
		if (tool === 'whole') { design.delete(cell.id); return; }
		if (tool === 'half') updateHalfAxis(x, y, cell);
		const current = design.get(cell.id) ?? seedRegion(cell);
		design.set(cell.id, applyTool(current, x, y, divisionFor(tool)));
	}

	function handleLeave() { hover = null; }

	// Store the updated inset and drop the fill of the piece that was just cut
	// (drop-on-cut: a sub-piece starts blank, recolour it in Colour mode).
	function onMarquetryCut(next: InsetRegion, cutLeafId: string) {
		if (!drill) return;
		insets.set(drill.id, next);
		colours.delete(cutLeafId);
	}
	function closeDrill() { drill = null; }

	function commitMerge() {
		const ring = selectionUnion;
		if (!ring) return;
		const ids = [...selection];
		ids.forEach(pruneFace); // member cells' colours and insets no longer apply
		const id = mergeId(ids);
		merges.set(id, { id, cellIds: ids, poly: ring });
		selection.clear();
	}

	// ---- Preview (subdivide mode) ----
	const preview = $derived.by((): { reset: true; poly: Pt[] }
		| { reset: false; faces: { poly: Pt[]; active: boolean }[] }
		| null => {
		if (editMode !== 'subdivide' || !hover) return null;
		const cell = cellAt(hover.x, hover.y);
		if (!cell || consumed.has(cell.id)) return null;
		if (tool === 'whole') return { reset: true, poly: cell.poly };
		const region = design.get(cell.id) ?? seedRegion(cell);
		const result = previewTool(region, hover.x, hover.y, divisionFor(tool));
		if (!result) return null;
		const fs = result.map((poly) => ({ poly, active: pointInPoly(hover!.x, hover!.y, poly) }));
		return { reset: false, faces: fs };
	});

	// Hover highlight (merge mode): which cell/merge is under the cursor
	const hoverCellId = $derived.by(() => {
		if (editMode !== 'merge' || !hover) return null;
		const cell = cellAt(hover.x, hover.y);
		return cell && eligible(cell) ? cell.id : null;
	});

	// Hover face (colour mode): preview the selected paint on the face under cursor
	const hoverFace = $derived.by(() => {
		if (editMode !== 'colour' || !hover) return null;
		const id = faceAt(hover.x, hover.y);
		if (!id) return null;
		return faces.find((f) => f.id === id) ?? null;
	});

	// Tool icons from live mode geometry
	function toolIcon(t: Tool): Pt[][] {
		const sample = mode === 'square'
			? [[-30, -30], [30, -30], [30, 30], [-30, 30]] as Pt[]
			: [[0, -34], [30, 0], [0, 34], [-30, 0]] as Pt[];
		if (t === 'whole') return [sample];
		const div: Division = t === 'half' ? 'half-h' : t;
		return leaves(applyTool(makeRoot(sample), 0, 0, div)).map((l) => l.poly);
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

		<div class="orient-toggle">
			<button class:active={orientation === 'landscape'} onclick={() => setOrientation('landscape')} title="Landscape">
				<svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true"><rect x="1.5" y="3.5" width="17" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
				Landscape
			</button>
			<button class:active={orientation === 'portrait'} onclick={() => setOrientation('portrait')} title="Portrait">
				<svg width="16" height="16" viewBox="0 0 16 20" aria-hidden="true"><rect x="3.5" y="1.5" width="9" height="17" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
				Portrait
			</button>
		</div>

		<div class="rotate-controls">
			<button onclick={() => rotateBy(-rotStep)} title="Rotate left {rotStep}°">⟲</button>
			<span class="rot-readout">{rotation}°</span>
			<button onclick={() => rotateBy(rotStep)} title="Rotate right {rotStep}°">⟳</button>
			<button class="rot-reset" onclick={resetRotation} disabled={rotation === 0}>Reset</button>
		</div>

		<div class="zoom-toggle">
			<button class:active={zoom === 'actual'} onclick={() => (zoom = 'actual')} title="Show cells at a consistent (≈ actual) size; scroll to pan">Actual size</button>
			<button class:active={zoom === 'fit'} onclick={() => (zoom = 'fit')} title="Scale the whole board to fit">Fit</button>
		</div>

		<h3>Mode</h3>
		<div class="editmode-toggle">
			<button class:active={editMode === 'subdivide'} onclick={() => setEditMode('subdivide')}>
				<span class="em-label">Subdivide</span><span class="em-axis">within a cell</span>
			</button>
			<button class:active={editMode === 'merge'} onclick={() => setEditMode('merge')}>
				<span class="em-label">Merge</span><span class="em-axis">across cells</span>
			</button>
			<button class:active={editMode === 'colour'} onclick={() => setEditMode('colour')}>
				<span class="em-label">Colour</span><span class="em-axis">fill faces</span>
			</button>
			<button class:active={editMode === 'marquetry'} onclick={() => setEditMode('marquetry')}>
				<span class="em-label">Marquetry</span><span class="em-axis">cut within a face</span>
			</button>
		</div>
		<p class="key-hint">↑ ↓ switch mode</p>

		{#if editMode === 'subdivide'}
			<h3>Within a cell</h3>
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
				Click a cell to subdivide it; click a half to split it once more. Keys 1–{tools.length}
				or ← → switch tool. Whole resets a cell.
			</p>
		{:else if editMode === 'merge'}
			<h3>Across cells</h3>
			<p class="cycle-note">
				Click whole cells to select them (they must connect). Then Merge fuses them into one
				region. Click a merged region to unmerge it.
			</p>
			<div class="merge-actions">
				<button class="btn-merge" disabled={!canMerge} onclick={commitMerge}>
					Merge {selection.size > 0 ? `(${selection.size})` : ''}
				</button>
				<button class="btn-ghost" disabled={selection.size === 0} onclick={() => selection.clear()}>Clear selection</button>
			</div>
			{#if selection.size >= 2 && !canMerge}
				<p class="warn">Those cells aren't all connected — pick an adjoining group.</p>
			{/if}
		{:else if editMode === 'colour'}
			<h3>Wood</h3>
			<div class="swatch-grid">
				{#each GRAINS as g (g.id)}
					<button class="swatch" class:active={paint === g.id} onclick={() => (paint = g.id)} title={g.label}>
						<svg viewBox="-20 -20 40 40" width="34" height="34">
							<defs>
								{#if g.spacing > 0}
									<pattern id="sw-{g.id}" width={g.spacing} height={g.spacing} patternUnits="userSpaceOnUse" patternTransform="rotate({g.angle})">
										<rect width={g.spacing} height={g.spacing} fill={g.base} />
										<line x1="0" y1="0" x2={g.spacing} y2="0" stroke={g.stroke} stroke-width={g.strokeWidth} />
									</pattern>
								{/if}
							</defs>
							<rect x="-18" y="-18" width="36" height="36" rx="3" fill={g.spacing > 0 ? `url(#sw-${g.id})` : g.base} stroke="#888" stroke-width="1" />
						</svg>
						<span>{g.label}</span>
					</button>
				{/each}
				<button class="swatch" class:active={paint === 'erase'} onclick={() => (paint = 'erase')} title="Erase">
					<svg viewBox="-20 -20 40 40" width="34" height="34">
						<rect x="-18" y="-18" width="36" height="36" rx="3" fill="white" stroke="#888" stroke-width="1" />
						<line x1="-12" y1="12" x2="12" y2="-12" stroke="#c33" stroke-width="2.5" />
					</svg>
					<span>Erase</span>
				</button>
			</div>
			<p class="cycle-note">Click any face to paint it. Keys 1–{PAINTS.length} or ← → pick a wood; Erase clears a face back to blank.</p>
		{:else}
			<h3>Within a face</h3>
			<p class="cycle-note">
				Click a face to open it for cut work. Inside, draw straight or curved cuts that split
				it into pieces. Colour the pieces back in Colour mode.
			</p>
		{/if}

		<div class="palette-actions">
			<button class="btn-clear" onclick={clearBoard}>Clear {mode}</button>
		</div>
		<div class="io-actions">
			<button class="btn-ghost" onclick={exportDoc}>Export JSON</button>
			<button class="btn-ghost" onclick={() => fileInput.click()}>Import JSON</button>
			<input bind:this={fileInput} type="file" accept="application/json,.json" onchange={onImportFile} hidden />
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

	<div class="board-container" class:scroll={zoom === 'actual' && !drill}>
		{#if drill}
			{#key drill.id}
				<MarquetryEditor
					faceId={drill.id}
					poly={drill.poly}
					inset={insets.get(drill.id) ?? null}
					colourBaseOf={faceBaseFill}
					onCut={onMarquetryCut}
					onBack={closeDrill}
				/>
			{/key}
		{:else}
		<svg
			{viewBox}
			class="board"
			class:fit={zoom === 'fit'}
			class:merge-mode={editMode === 'merge'}
			style={zoom === 'actual' ? `width:${pxW}px;height:${pxH}px;` : ''}
			onpointermove={handleMove}
			onpointerup={handleClick}
			onpointerleave={handleLeave}
			role="application"
			aria-label="Parquetry design board"
		>
			<defs>
				{#each GRAINS as g (g.id)}
					{#if g.spacing > 0}
						<pattern id="grain-{g.id}" width={g.spacing} height={g.spacing} patternUnits="userSpaceOnUse" patternTransform="rotate({g.angle + rotation})">
							<rect width={g.spacing} height={g.spacing} fill={g.base} />
							<line x1="0" y1="0" x2={g.spacing} y2="0" stroke={g.stroke} stroke-width={g.strokeWidth} />
						</pattern>
					{/if}
				{/each}
			</defs>

			<g bind:this={gridEl} transform="rotate({rotation} {pivotX} {pivotY})">
				{#each faces as face (face.id)}
					<polygon points={face.poly.map(([x, y]) => `${x},${y}`).join(' ')} fill={faceFill(face.id)} class="face" />
				{/each}

				{#if editMode === 'merge'}
					{#each board.cells as cell (cell.id)}
						{#if selection.has(cell.id)}
							<polygon points={cell.poly.map(([x, y]) => `${x},${y}`).join(' ')} class="sel" pointer-events="none" />
						{:else if hoverCellId === cell.id}
							<polygon points={cell.poly.map(([x, y]) => `${x},${y}`).join(' ')} class="sel-hover" pointer-events="none" />
						{/if}
					{/each}
					{#if selectionUnion}
						<polygon points={selectionUnion.map(([x, y]) => `${x},${y}`).join(' ')} class="sel-union" pointer-events="none" />
					{/if}
				{/if}

				{#if hoverFace}
					<polygon points={hoverFace.poly.map(([x, y]) => `${x},${y}`).join(' ')}
						fill={paint === 'erase' ? 'white' : grainFill(paint)}
						class="colour-hover" pointer-events="none" />
				{/if}

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
		{/if}
	</div>
</div>

{#if showPrint}
	<PrintPreview {board} {mode} {orientation} {rotation} {design} merges={merges} colours={colours} insets={insets} onClose={() => (showPrint = false)} />
{/if}

<style>
	.parquetry-app {
		display: flex; gap: 1rem; height: 100vh; padding: 1rem; box-sizing: border-box;
		font-family: system-ui, -apple-system, sans-serif; background: #f8f7f5;
	}
	.palette {
		flex: 0 0 280px; background: white; border-radius: 8px; padding: 1rem;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1); overflow-y: auto;
	}
	.palette h3 { margin: 0 0 0.5rem; font-size: 1rem; color: #333; }
	.palette h3:not(:first-child) { margin-top: 1.25rem; }

	.mode-pills { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; }

	.orient-toggle { display: flex; gap: 0.4rem; margin-bottom: 0.75rem; }
	.orient-toggle button {
		flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem;
		padding: 0.35rem; font-size: 0.72rem; font-weight: 600; border: 1px solid #ccc;
		border-radius: 6px; background: white; color: #666; cursor: pointer; transition: all 0.15s;
	}
	.orient-toggle button.active { border-color: dodgerblue; background: #e8f0ff; color: #1565c0; }
	.pill {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px;
		padding: 0.4rem 0.3rem; border: 1px solid #ccc; border-radius: 999px; background: white;
		cursor: pointer; transition: all 0.15s;
	}
	.pill-label { font-size: 0.74rem; font-weight: 600; color: #444; }
	.pill-sub { font-size: 0.6rem; color: #999; }
	.pill.active { border-color: dodgerblue; background: #e8f0ff; }
	.pill.active .pill-label { color: #1565c0; }
	.pill.active .pill-sub { color: #4a90d9; }

	.rotate-controls { display: flex; align-items: center; gap: 0.4rem; }
	.rotate-controls button {
		padding: 0.35rem 0.6rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 5px;
		background: white; cursor: pointer; line-height: 1;
	}
	.rotate-controls button:hover { background: #f0f0f0; }
	.rot-readout { min-width: 3rem; text-align: center; font-size: 0.85rem; font-variant-numeric: tabular-nums; color: #444; }
	.rot-reset { margin-left: auto; font-size: 0.72rem !important; padding: 0.35rem 0.5rem !important; }
	.rot-reset:disabled { opacity: 0.4; cursor: default; }

	.editmode-toggle { display: flex; flex-direction: column; gap: 0.4rem; }
	.editmode-toggle button {
		display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem;
		width: 100%; padding: 0.5rem 0.7rem; font-size: 0.82rem; font-weight: 600;
		border: 1px solid #ccc; border-radius: 6px; background: white; color: #555;
		cursor: pointer; transition: all 0.15s; text-align: left;
	}
	.editmode-toggle .em-axis { font-size: 0.62rem; font-weight: 500; color: #aaa; }
	.editmode-toggle button.active { border-color: dodgerblue; background: #e8f0ff; color: #1565c0; }
	.editmode-toggle button.active .em-axis { color: #7aa7e0; }
	.key-hint { margin: 0.4rem 0 0; font-size: 0.66rem; color: #aaa; text-align: center; }

	.swatch-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.4rem; }
	.swatch {
		display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 2px;
		border: 2px solid transparent; border-radius: 6px; background: #f5f2ec; cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}
	.swatch span { font-size: 0.6rem; color: #777; }
	.swatch:hover { background: #ece6db; }
	.swatch.active { border-color: dodgerblue; background: #e8f0ff; }
	.swatch.active span { color: #1565c0; }

	.tool-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.35rem; }
	.tool-btn {
		display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 2px;
		border: 2px solid transparent; border-radius: 6px; background: #f5f2ec; cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}
	.tool-btn span { font-size: 0.62rem; color: #777; }
	.tool-btn:hover { background: #ece6db; }
	.tool-btn.active { border-color: dodgerblue; background: #e8f0ff; }
	.tool-btn.active span { color: #1565c0; }

	.cycle-note { margin: 0.6rem 0 0; font-size: 0.7rem; color: #999; line-height: 1.5; }
	.warn { margin: 0.5rem 0 0; font-size: 0.7rem; color: #c67; line-height: 1.4; }

	.merge-actions { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.75rem; }
	.btn-merge {
		padding: 0.5rem; font-size: 0.82rem; font-weight: 600; border: none; border-radius: 6px;
		background: #6b4423; color: white; cursor: pointer;
	}
	.btn-merge:disabled { background: #d8cfc4; color: #fff; cursor: default; }
	.btn-ghost {
		padding: 0.4rem; font-size: 0.72rem; border: 1px solid #ccc; border-radius: 5px;
		background: white; color: #666; cursor: pointer;
	}
	.btn-ghost:disabled { opacity: 0.4; cursor: default; }

	.palette-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
	.io-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
	.io-actions .btn-ghost { flex: 1; text-align: center; }
	.btn-clear {
		flex: 1; padding: 0.4rem 0.5rem; font-size: 0.75rem; border: 1px solid #c33; border-radius: 4px;
		cursor: pointer; background: white; color: #c33; text-transform: capitalize;
	}
	.btn-clear:hover { background: #fef0f0; }

	.btn-print {
		width: 100%; margin-top: 0.6rem; padding: 0.6rem; display: inline-flex; align-items: center;
		justify-content: center; gap: 0.4rem; font-size: 0.82rem; font-weight: 600; border: none;
		border-radius: 6px; background: #1565c0; color: white; cursor: pointer;
		box-shadow: 0 1px 3px rgba(21, 101, 192, 0.35);
	}
	.btn-print:hover { background: #0f4c98; }

	.board-container {
		flex: 1; display: flex; align-items: center; justify-content: center; background: white;
		border-radius: 8px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1); overflow: hidden;
	}
	/* Actual-size: fixed px board that overflows and scrolls; margin auto keeps it
	   centred when smaller than the viewport and fully scrollable when larger. */
	.board-container.scroll { overflow: auto; }
	.board-container.scroll .board { margin: auto; flex: none; }

	.board { cursor: crosshair; touch-action: none; display: block; }
	.board.fit { width: 100%; height: 100%; max-height: 100%; }
	.board.merge-mode { cursor: pointer; }

	.zoom-toggle { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
	.zoom-toggle button {
		flex: 1; padding: 0.35rem; font-size: 0.72rem; font-weight: 600; border: 1px solid #ccc;
		border-radius: 6px; background: white; color: #666; cursor: pointer; transition: all 0.15s;
	}
	.zoom-toggle button.active { border-color: dodgerblue; background: #e8f0ff; color: #1565c0; }

	.face { stroke: #bbb; stroke-width: 0.7; }
	.preview-face { fill: rgba(30, 120, 220, 0.08); stroke: dodgerblue; stroke-width: 1.1; }
	.preview-face-active { fill: rgba(30, 120, 220, 0.26); stroke: dodgerblue; stroke-width: 1.1; }
	.preview-reset { fill: rgba(200, 60, 60, 0.06); stroke: #c33; stroke-width: 1.1; stroke-dasharray: 3 2; }

	.sel { fill: rgba(107, 68, 35, 0.28); stroke: #6b4423; stroke-width: 1; }
	.sel-hover { fill: rgba(107, 68, 35, 0.1); stroke: #6b4423; stroke-width: 0.8; stroke-dasharray: 2 2; }
	.sel-union { fill: none; stroke: #6b4423; stroke-width: 1.8; }
	.colour-hover { opacity: 0.55; stroke: dodgerblue; stroke-width: 1.3; }

	@media (max-width: 700px) {
		.parquetry-app { flex-direction: column; height: auto; }
		.palette { flex: none; }
		.board-container { aspect-ratio: 1 / 1; }
	}
</style>