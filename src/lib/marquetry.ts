// Marquetry: freeform boundary-to-boundary cuts inside a single face.
//
// A face (a cell, a subdivision leaf, or a merged region) can carry one inset:
// a binary tree where each node was split by one cut (a straight line or a
// single-bulge quadratic) into two children. Leaves are the cuttable, fillable
// sub-pieces. This mirrors the Region subdivision tree in grid.ts, but the split
// is an arbitrary cut rather than a preset division.
//
// Sub-piece ids are tree paths off the face id: "@0" / "@1", then "@1@0" / "@1@1"
// if a piece is cut again. Cutting one piece never renumbers another, so Colour
// bindings on untouched pieces stay stable. The geometry (splitFace) is the same
// function proven in the Python mock; only the tree, ids, and serialisation here
// are new.

import { pointInPolyGeneral, type Pt } from './grid';

const EPS = 1e-7;
const AREA_EPS = 1e-4;
const BND_EPS = 1e-6;
export const SEAM_SAMPLES = 24; // quadratic -> polyline for stored seam / fills
const VAL_SAMPLES = 48;         // denser sampling used only by the validity test

// ---- A cut, and the live inset tree ----

export interface Cut {
	a: Pt;          // endpoint A, on the sub-piece boundary at cut time
	b: Pt;          // endpoint B
	bulge?: Pt;     // quadratic control point; absent for a straight cut
}

/**
 * A node in a face's inset tree. A leaf (no children) is a fillable sub-piece.
 * `corner` runs parallel to `poly`: true for a real vertex or a cut endpoint,
 * false for an interior sample of a curved seam. Snapping uses it so that
 * straight segments offer a midpoint landmark and curved ones do not.
 */
export interface InsetRegion {
	poly: Pt[];
	corner: boolean[];
	cut?: Cut;
	children?: [InsetRegion, InsetRegion];
}

export function seedInset(facePoly: Pt[]): InsetRegion {
	return { poly: facePoly.map((p) => p.slice() as Pt), corner: facePoly.map(() => true) };
}

// ---- Geometry helpers (not already in grid.ts) ----

export function polyArea(poly: Pt[]): number {
	let s = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i], b = poly[(i + 1) % poly.length];
		s += a[0] * b[1] - b[0] * a[1];
	}
	return Math.abs(s) / 2;
}

function project(p: Pt, a: Pt, b: Pt): { t: number; q: Pt; d: number } {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const L2 = dx * dx + dy * dy;
	let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
	t = Math.max(0, Math.min(1, t));
	const q: Pt = [a[0] + t * dx, a[1] + t * dy];
	return { t, q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

/** Which boundary edge a point lies on, plus parameter and the on-edge point. */
export function locateOnRing(p: Pt, poly: Pt[]): { i: number; t: number; q: Pt; d: number } {
	let best: { i: number; t: number; q: Pt; d: number } | null = null;
	for (let i = 0; i < poly.length; i++) {
		const r = project(p, poly[i], poly[(i + 1) % poly.length]);
		if (!best || r.d < best.d) best = { i, t: r.t, q: r.q, d: r.d };
	}
	return best as { i: number; t: number; q: Pt; d: number };
}

/** Closest point on the face boundary, for freeform (snap-off) placement. */
export function boundaryPoint(p: Pt, poly: Pt[]): Pt {
	return locateOnRing(p, poly).q;
}

function quad(a: Pt, c: Pt, b: Pt, n: number): Pt[] {
	const out: Pt[] = [];
	for (let k = 0; k <= n; k++) {
		const t = k / n, u = 1 - t;
		out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
			u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
	}
	return out;
}

/** Stored seam geometry: straight cut stays two points; curve is sampled. */
export function cutSeam(cut: Cut, n: number = SEAM_SAMPLES): Pt[] {
	return cut.bulge ? quad(cut.a, cut.bulge, cut.b, n) : [cut.a.slice() as Pt, cut.b.slice() as Pt];
}

function densify(a: Pt, b: Pt, bulge: Pt | undefined, n: number): Pt[] {
	if (bulge) return quad(a, bulge, b, n);
	const out: Pt[] = [];
	for (let k = 0; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
	return out;
}

function minDistToBoundary(p: Pt, poly: Pt[]): number {
	let m = Infinity;
	for (let i = 0; i < poly.length; i++) m = Math.min(m, project(p, poly[i], poly[(i + 1) % poly.length]).d);
	return m;
}

function strictlyInterior(p: Pt, poly: Pt[]): boolean {
	return pointInPolyGeneral(p[0], p[1], poly) && minDistToBoundary(p, poly) > BND_EPS;
}

// ---- The split (proven in the Python mock) ----

interface NodePts { poly: Pt[]; corner: boolean[]; }

function dedupe(nodes: { p: Pt; c: boolean }[]): { p: Pt; c: boolean }[] {
	const out: { p: Pt; c: boolean }[] = [];
	for (const nd of nodes) {
		const l = out[out.length - 1];
		if (!l || Math.abs(nd.p[0] - l.p[0]) > EPS || Math.abs(nd.p[1] - l.p[1]) > EPS) out.push(nd);
	}
	if (out.length > 1) {
		const f = out[0].p, L = out[out.length - 1].p;
		if (Math.abs(f[0] - L[0]) < EPS && Math.abs(f[1] - L[1]) < EPS) out.pop();
	}
	return out;
}

/**
 * Split a face polygon by a boundary-to-boundary cut into two sub-pieces.
 * Walks the boundary from A to B one way for piece 1 and B to A the other way
 * for piece 2, splicing the sampled cut into each so the seam is identical in
 * both. Works on convex and non-convex (merged) faces alike.
 */
export function splitFace(poly: Pt[], corner: boolean[], cut: Cut): [NodePts, NodePts] {
	const n = poly.length;
	const ins: Record<number, { t: number; label: 'A' | 'B'; q: Pt }[]> = {};
	const vlabel: Record<number, 'A' | 'B'> = {};
	for (const [label, P] of [['A', cut.a], ['B', cut.b]] as [['A', Pt], ['B', Pt]]) {
		const L = locateOnRing(P, poly);
		if (L.t < EPS) vlabel[L.i] = label;
		else if (L.t > 1 - EPS) vlabel[(L.i + 1) % n] = label;
		else (ins[L.i] = ins[L.i] || []).push({ t: L.t, label, q: L.q });
	}

	const ring: { p: Pt; c: boolean }[] = [];
	const idx: Record<string, number> = {};
	for (let i = 0; i < n; i++) {
		if (vlabel[i]) idx[vlabel[i]] = ring.length;
		ring.push({ p: poly[i].slice() as Pt, c: corner[i] });
		for (const it of (ins[i] || []).sort((x, y) => x.t - y.t)) {
			idx[it.label] = ring.length;
			ring.push({ p: it.q.slice() as Pt, c: true });
		}
	}

	const ia = idx['A'], ib = idx['B'];
	const seam = cutSeam({ a: ring[ia].p, b: ring[ib].p, bulge: cut.bulge });
	const interior = seam.slice(1, -1).map((p) => ({ p: p.slice() as Pt, c: false }));

	const arc = (i: number, j: number) => {
		const o: { p: Pt; c: boolean }[] = [];
		let k = i;
		for (;;) { o.push(ring[k]); if (k === j) break; k = (k + 1) % ring.length; }
		return o;
	};

	const p1 = dedupe(arc(ia, ib).concat([...interior].reverse()));
	const p2 = dedupe(arc(ib, ia).concat(interior));
	const toNode = (nd: { p: Pt; c: boolean }[]): NodePts => ({ poly: nd.map((x) => x.p), corner: nd.map((x) => x.c) });
	return [toNode(p1), toNode(p2)];
}

// ---- Validity gate ----

export type CutValidity = { ok: true } | { ok: false; reason: 'degenerate' | 'out of bounds' };

/**
 * Whether a cut from A to B (optional bulge) is a legal split of `poly`.
 * - straight cut with both endpoints on one edge encloses nothing -> degenerate
 * - any interior sample of the cut leaving the face -> out of bounds. The plan
 *   flags only the curve bulge, but a straight chord across a NON-convex merged
 *   face can also exit, so the test runs on lines too.
 * - a vanishing sub-piece -> degenerate
 */
export function validateCut(poly: Pt[], a: Pt, b: Pt, bulge?: Pt): CutValidity {
	if (!bulge && locateOnRing(a, poly).i === locateOnRing(b, poly).i) return { ok: false, reason: 'degenerate' };
	const curve = densify(a, b, bulge, VAL_SAMPLES);
	for (let k = 1; k < curve.length - 1; k++) {
		if (!strictlyInterior(curve[k], poly)) return { ok: false, reason: 'out of bounds' };
	}
	const [p1, p2] = splitFace(poly, poly.map(() => true), { a, b, bulge });
	if (p1.poly.length < 3 || p2.poly.length < 3 || polyArea(p1.poly) < AREA_EPS || polyArea(p2.poly) < AREA_EPS) {
		return { ok: false, reason: 'degenerate' };
	}
	return { ok: true };
}

// ---- Tree operations (mirror leaves / findLeaf / applyTool in grid.ts) ----

export function insetLeaves(node: InsetRegion): InsetRegion[] {
	if (!node.children) return [node];
	return insetLeaves(node.children[0]).concat(insetLeaves(node.children[1]));
}

/** Leaves with their stable tree-path suffix, e.g. "@0", "@1@0". The board
 *  composes the full face id as `${faceId}${path}`. */
export function insetLeafEntries(node: InsetRegion, path = ''): { path: string; poly: Pt[]; corner: boolean[] }[] {
	if (!node.children) return [{ path, poly: node.poly, corner: node.corner }];
	return insetLeafEntries(node.children[0], path + '@0')
		.concat(insetLeafEntries(node.children[1], path + '@1'));
}

export function findInsetLeaf(node: InsetRegion, x: number, y: number): InsetRegion | null {
	if (!node.children) return pointInPolyGeneral(x, y, node.poly) ? node : null;
	for (const c of node.children) {
		const f = findInsetLeaf(c, x, y);
		if (f) return f;
	}
	return null;
}

/** Split a specific leaf (by reference) and return a new tree. The board holds
 *  the active leaf from findInsetLeaf, then calls this on commit. Existing refs
 *  are stale afterwards; re-fetch from the returned tree. */
export function splitInsetLeaf(root: InsetRegion, leaf: InsetRegion, cut: Cut): InsetRegion {
	if (root === leaf) {
		const [lo, hi] = splitFace(root.poly, root.corner, cut);
		return {
			poly: root.poly, corner: root.corner, cut,
			children: [
				{ poly: lo.poly, corner: lo.corner },
				{ poly: hi.poly, corner: hi.corner }
			]
		};
	}
	if (!root.children) return root;
	const a = splitInsetLeaf(root.children[0], leaf, cut);
	const b = splitInsetLeaf(root.children[1], leaf, cut);
	return a === root.children[0] && b === root.children[1] ? root : { ...root, children: [a, b] };
}

// ---- Snapping landmarks (consumed by the drill-in editor in step 2) ----

export interface Landmark { p: Pt; type: 'vertex' | 'midpoint'; }

/** Uniform landmark rule: every straight segment contributes its two endpoints
 *  and its midpoint; curved segments contribute endpoints only (their interior
 *  samples are not corners, so no midpoint is generated across them). */
export function insetLandmarks(poly: Pt[], corner: boolean[]): Landmark[] {
	const out: Landmark[] = [];
	const n = poly.length;
	for (let i = 0; i < n; i++) if (corner[i]) out.push({ p: poly[i], type: 'vertex' });
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		if (corner[i] && corner[j]) out.push({ p: [(poly[i][0] + poly[j][0]) / 2, (poly[i][1] + poly[j][1]) / 2], type: 'midpoint' });
	}
	return out;
}

// ---- Lean serialisation (structure only; polygons recomputed on import) ----

export interface LeanCut { a: Pt; b: Pt; c?: Pt; }
export interface LeanInset { cut: LeanCut; children: [LeanInset | null, LeanInset | null]; }

/** Reduce a live inset to its lean form, or null if the face was never cut. */
export function insetToLean(node: InsetRegion): LeanInset | null {
	if (!node.children || !node.cut) return null;
	const lean: LeanCut = { a: node.cut.a, b: node.cut.b };
	if (node.cut.bulge) lean.c = node.cut.bulge;
	return { cut: lean, children: [insetToLean(node.children[0]), insetToLean(node.children[1])] };
}

/** Rebuild a live inset by replaying its cuts onto the recomputed face polygon. */
export function rebuildInset(facePoly: Pt[], lean: LeanInset): InsetRegion {
	return applyLean(seedInset(facePoly), lean);
}

function applyLean(leaf: InsetRegion, lean: LeanInset): InsetRegion {
	const cut: Cut = { a: lean.cut.a, b: lean.cut.b };
	if (lean.cut.c) cut.bulge = lean.cut.c;
	const [lo, hi] = splitFace(leaf.poly, leaf.corner, cut);
	let loR: InsetRegion = { poly: lo.poly, corner: lo.corner };
	let hiR: InsetRegion = { poly: hi.poly, corner: hi.corner };
	if (lean.children[0]) loR = applyLean(loR, lean.children[0]);
	if (lean.children[1]) hiR = applyLean(hiR, lean.children[1]);
	return { poly: leaf.poly, corner: leaf.corner, cut, children: [loR, hiR] };
}
