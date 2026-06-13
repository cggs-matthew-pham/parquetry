<script lang="ts">
	import {
		seedInset, insetLeafEntries, splitInsetLeaf, insetLandmarks, boundaryPoint,
		validateCut, cutSeam, type InsetRegion, type Cut
	} from '$lib/marquetry';
	import { pointInPolyGeneral, type Pt } from '$lib/grid';
	import { untrack } from 'svelte';

	let { faceId, poly, inset = null, colourBaseOf, onCut, onBack }: {
		faceId: string;
		poly: Pt[];
		inset: InsetRegion | null;
		colourBaseOf: (id: string) => string;
		onCut: (next: InsetRegion, cutLeafId: string) => void;
		onBack: () => void;
	} = $props();

	const PAD = 8;
	const JOINTOL = 4;

	// Working tree. This component is keyed by faceId upstream, so this inits per
	// drill-in. seedInset gives a single leaf (the whole face) when never cut.
	let tree = $state<InsetRegion>(untrack(() => inset ?? seedInset(poly)));

	let tool = $state<'line' | 'curve'>('line');
	let snapOn = $state(true);

	type Phase = 'idleA' | 'placedA' | 'curveC';
	let phase = $state<Phase>('idleA');
	let A = $state<Pt | null>(null);
	let B = $state<Pt | null>(null);
	let C = $state<Pt | null>(null);
	let activePath = $state('');
	let cand = $state<{ p: Pt; type: string } | null>(null);

	let svgEl: SVGSVGElement;

	const bounds = $derived.by(() => {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const [x, y] of poly) {
			minX = Math.min(minX, x); minY = Math.min(minY, y);
			maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
		}
		return { minX, minY, w: maxX - minX, h: maxY - minY };
	});
	const viewBox = $derived(`${bounds.minX - PAD} ${bounds.minY - PAD} ${bounds.w + PAD * 2} ${bounds.h + PAD * 2}`);

	const pieces = $derived(insetLeafEntries(tree));

	function cutVerts(node: InsetRegion, acc: Pt[] = []): Pt[] {
		if (node.cut) acc.push(node.cut.a, node.cut.b);
		if (node.children) { cutVerts(node.children[0], acc); cutVerts(node.children[1], acc); }
		return acc;
	}
	function leafByPath(node: InsetRegion, path: string): InsetRegion {
		let n = node;
		for (const s of path.split('@').filter((x) => x !== '')) n = n.children![Number(s)];
		return n;
	}
	const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
	const bndDist = (p: Pt, pg: Pt[]) => dist(p, boundaryPoint(p, pg));

	type Piece = { path: string; poly: Pt[]; corner: boolean[] };

	// Snap within one known piece (used for B once the target is resolved).
	function snapToPiece(raw: Pt, pc: Piece): { p: Pt; type: string } {
		let join: Pt | null = null, jd = JOINTOL;
		for (const v of cutVerts(tree)) {
			if (bndDist(v, pc.poly) < 0.5) { const d = dist(raw, v); if (d < jd) { jd = d; join = v; } }
		}
		if (join) return { p: join, type: 'join' };
		if (snapOn) {
			let best: { p: Pt; type: string; d: number } | null = null;
			for (const lm of insetLandmarks(pc.poly, pc.corner)) {
				const d = dist(raw, lm.p);
				if (!best || d < best.d) best = { p: lm.p, type: lm.type, d };
			}
			if (best) return { p: best.p, type: best.type };
		}
		return { p: boundaryPoint(raw, pc.poly), type: 'freeform' };
	}

	// Snap A against every piece. A may land on a vertex shared by several pieces,
	// so we do not commit to one here; the target is resolved at B.
	function snapAll(raw: Pt): { p: Pt; type: string } {
		let join: Pt | null = null, jd = JOINTOL;
		for (const v of cutVerts(tree)) { const d = dist(raw, v); if (d < jd) { jd = d; join = v; } }
		if (join) return { p: join, type: 'join' };
		if (snapOn) {
			let best: { p: Pt; type: string; d: number } | null = null;
			for (const pc of pieces)
				for (const lm of insetLandmarks(pc.poly, pc.corner)) {
					const d = dist(raw, lm.p);
					if (!best || d < best.d) best = { p: lm.p, type: lm.type, d };
				}
			if (best) return { p: best.p, type: best.type };
		}
		let bp: Pt | null = null, bd = Infinity;
		for (const pc of pieces) { const q = boundaryPoint(raw, pc.poly); const d = dist(raw, q); if (d < bd) { bd = d; bp = q; } }
		return { p: bp ?? raw, type: 'freeform' };
	}

	// Pieces whose boundary carries A: one for an edge point, several for a shared
	// vertex or a point on a shared seam.
	function candidatePieces(): Piece[] {
		if (!A) return pieces;
		const a = A;
		const cands = pieces.filter((p) => bndDist(a, p.poly) < 0.5);
		return cands.length ? cands : pieces;
	}

	// Among A's candidate pieces, the one the cursor is in (else nearest). This is
	// what lets a cut from a shared vertex run into whichever face you aim at, and
	// it re-resolves live, so re-aiming the other way switches the target.
	function resolveTarget(raw: Pt): Piece {
		const cands = candidatePieces();
		const inside = cands.find((p) => pointInPolyGeneral(raw[0], raw[1], p.poly));
		if (inside) return inside;
		let best = cands[0], bd = Infinity;
		for (const p of cands) { const d = bndDist(raw, p.poly); if (d < bd) { bd = d; best = p; } }
		return best;
	}

	function toUnit(e: PointerEvent): Pt {
		const ctm = svgEl.getScreenCTM();
		if (!ctm) return [0, 0];
		const pt = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
		const u = pt.matrixTransform(ctm.inverse());
		return [u.x, u.y];
	}

	function activeLeafPoly(): Pt[] {
		const pc = pieces.find((p) => p.path === activePath);
		return pc ? pc.poly : poly;
	}

	function onMove(e: PointerEvent) {
		const raw = toUnit(e);
		if (phase === 'idleA') { cand = snapAll(raw); }
		else if (phase === 'placedA') { const t = resolveTarget(raw); activePath = t.path; cand = snapToPiece(raw, t); }
		else if (phase === 'curveC') { C = raw; }
	}

	function commit(a: Pt, b: Pt, bulge?: Pt) {
		const leaf = leafByPath(tree, activePath);
		const cut: Cut = bulge ? { a, b, bulge } : { a, b };
		const next = splitInsetLeaf(tree, leaf, cut);
		tree = next;
		onCut(next, faceId + activePath);
		phase = 'idleA'; A = B = C = null;
	}

	function onDown(e: PointerEvent) {
		e.preventDefault();
		const raw = toUnit(e);
		if (phase === 'idleA') {
			cand = snapAll(raw); A = cand.p.slice() as Pt; phase = 'placedA';
		} else if (phase === 'placedA') {
			const t = resolveTarget(raw); activePath = t.path; cand = snapToPiece(raw, t);
			B = cand.p.slice() as Pt;
			if (tool === 'line') { if (validateCut(t.poly, A!, B!).ok) commit(A!, B!); }
			else { phase = 'curveC'; C = raw; }
		} else if (phase === 'curveC') {
			if (C && validateCut(activeLeafPoly(), A!, B!, C).ok) commit(A!, B!, C);
		}
	}

	function cancel() { phase = 'idleA'; A = B = C = null; }

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
		if (e.key === 'Escape') { if (phase !== 'idleA') { cancel(); e.preventDefault(); } return; }
		const k = e.key.toLowerCase();
		if (k === 'b') { onBack(); e.preventDefault(); }
		else if (k === 'l') { tool = 'line'; if (phase === 'curveC') cancel(); e.preventDefault(); }
		else if (k === 'c') { tool = 'curve'; e.preventDefault(); }
		else if (k === 's') { snapOn = !snapOn; e.preventDefault(); }
	}

	const seams = $derived.by(() => {
		const out: Pt[][] = [];
		const walk = (n: InsetRegion) => { if (n.cut) out.push(cutSeam(n.cut)); if (n.children) { walk(n.children[0]); walk(n.children[1]); } };
		walk(tree);
		return out;
	});
	const COL: Record<string, string> = { vertex: '#378ADD', midpoint: '#1D9E75', join: '#7F77DD', freeform: '#888780' };
	const pstr = (p: Pt[]) => p.map(([x, y]) => `${x},${y}`).join(' ');

	const livePreview = $derived.by(() => {
		if (phase === 'placedA' && cand && A) {
			const ok = tool === 'line' ? validateCut(activeLeafPoly(), A, cand.p).ok : true;
			return { kind: 'line' as const, a: A, b: cand.p, ok };
		}
		if (phase === 'curveC' && A && B && C) {
			const v = validateCut(activeLeafPoly(), A, B, C);
			return { kind: 'curve' as const, pts: cutSeam({ a: A, b: B, bulge: C }), c: C, ok: v.ok };
		}
		return null;
	});
	const showLandmarks = $derived(snapOn && (phase === 'idleA' || phase === 'placedA'));
	const landmarkPieces = $derived(phase === 'placedA' ? pieces.filter((p) => p.path === activePath) : pieces);
	const targetFace = $derived(phase !== 'idleA' ? activeLeafPoly() : null);

	function hint(): string {
		if (phase === 'idleA') return cand ? `click point A · nearest: ${cand.type}` : 'click point A on a piece edge';
		if (phase === 'placedA') return tool === 'line' ? 'click point B to cut' : 'click point B, then drag the bulge';
		return 'move to shape the curve, click to commit';
	}
</script>

<svelte:window onkeydown={onKey} />

<div class="mq-editor">
	<div class="mq-bar">
		<button class="mq-back" onclick={onBack}>← Back (b)</button>
		<div class="mq-seg">
			<button class:active={tool === 'line'} onclick={() => { tool = 'line'; if (phase === 'curveC') cancel(); }}>Line (l)</button>
			<button class:active={tool === 'curve'} onclick={() => (tool = 'curve')}>Curve (c)</button>
		</div>
		<button class="mq-snap" class:active={snapOn} onclick={() => (snapOn = !snapOn)}>Snap: {snapOn ? 'on' : 'off'} (s)</button>
		{#if phase !== 'idleA'}<button class="mq-cancel" onclick={cancel}>Cancel cut (esc)</button>{/if}
		<span class="mq-hint">{hint()}</span>
	</div>

	<div class="mq-canvas">
		<svg bind:this={svgEl} {viewBox} onpointermove={onMove} onpointerdown={onDown}
			role="application" aria-label="Marquetry cut editor">
			{#each pieces as pc (pc.path)}
				<polygon points={pstr(pc.poly)} fill={colourBaseOf(faceId + pc.path)} stroke="#bbb" stroke-width="0.6" />
			{/each}

			{#if targetFace}
				<polygon points={pstr(targetFace)} fill="rgba(46,110,78,0.08)" stroke="#2e6e4e" stroke-width="0.5" stroke-dasharray="2 2" pointer-events="none" />
			{/if}

			{#each seams as s, i (i)}
				<polyline points={pstr(s)} fill="none" stroke="#2e6e4e" stroke-width="0.9" />
			{/each}

			{#if showLandmarks}
				{#each landmarkPieces as pc (pc.path)}
					{#each insetLandmarks(pc.poly, pc.corner) as lm, li (li)}
						<circle cx={lm.p[0]} cy={lm.p[1]} r="0.9" fill="#999" opacity="0.6" />
					{/each}
				{/each}
			{/if}

			{#if livePreview}
				{#if livePreview.kind === 'line'}
					<line x1={livePreview.a[0]} y1={livePreview.a[1]} x2={livePreview.b[0]} y2={livePreview.b[1]}
						stroke={livePreview.ok ? '#2e6e4e' : '#cc3f3f'} stroke-width="1" />
				{:else}
					<polyline points={pstr(livePreview.pts)} fill="none"
						stroke={livePreview.ok ? '#2e6e4e' : '#cc3f3f'} stroke-width="1.1" />
					<circle cx={livePreview.c[0]} cy={livePreview.c[1]} r="1.4" fill={livePreview.ok ? '#2e6e4e' : '#cc3f3f'} />
				{/if}
			{/if}

			{#if A}<circle cx={A[0]} cy={A[1]} r="1.3" fill="#2e6e4e" />{/if}
			{#if B && phase === 'curveC'}<circle cx={B[0]} cy={B[1]} r="1.3" fill="#2e6e4e" />{/if}
			{#if cand && (phase === 'idleA' || phase === 'placedA')}
				<circle cx={cand.p[0]} cy={cand.p[1]} r="1.8" fill="none" stroke={COL[cand.type]} stroke-width="1" />
			{/if}
		</svg>
	</div>
</div>

<style>
	.mq-editor { display: flex; flex-direction: column; width: 100%; height: 100%; }
	.mq-bar {
		display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.25rem; flex-wrap: wrap;
		font-size: 0.8rem;
	}
	.mq-bar button {
		padding: 0.35rem 0.6rem; font-size: 0.78rem; border: 1px solid #ccc; border-radius: 6px;
		background: white; color: #555; cursor: pointer;
	}
	.mq-back { font-weight: 600; }
	.mq-seg { display: flex; gap: 0.3rem; }
	.mq-seg button.active, .mq-snap.active { border-color: #2e6e4e; background: #eaf3ee; color: #2e6e4e; }
	.mq-cancel { color: #c33; border-color: #e0b4b4; }
	.mq-hint { margin-left: auto; color: #999; }
	.mq-canvas { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
	.mq-canvas svg { width: 100%; height: 100%; max-height: 70vh; touch-action: none; cursor: crosshair; display: block; }
</style>