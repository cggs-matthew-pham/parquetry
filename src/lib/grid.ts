// Parquetry grid: each mode is a tessellation that emits cells (polygons with
// stable ids). Modes are independent — no shared (i,j) lattice — so designs in
// different modes persist separately. Subdivision of cells lives elsewhere.

export const W = 60; // base cell size in SVG units

export type Grain = 'none' | 'fine' | 'mid' | 'bold';
export type Mode = 'square' | 'diamond' | 'tall' | 'flat';
export type Orientation = 'landscape' | 'portrait';
export const ORIENTATIONS: Orientation[] = ['landscape', 'portrait'];
export type Pt = [number, number];

// ---- Geometry per mode ----

export interface Geo {
	w: number;
	h: number;
	halfW: number;
	halfH: number;
}

/** All modes share a 30 mm cut edge (at W=60 units, MM_PER_UNIT=0.5). square =
 *  upright square (W×W); diamond = the SAME square rotated 45° on-point, so its
 *  edge equals the square's and its corner-to-corner span is W√2; tall = 60°/120°
 *  rhombus, long diagonal vertical (W×W√3); flat = that rhombus rotated 90°
 *  (W√3×W). Every cell therefore has the same edge length. */
export function geoFor(mode: Mode): Geo {
	let w = W, h = W;
	if (mode === 'tall') h = W * Math.sqrt(3);
	else if (mode === 'flat') w = W * Math.sqrt(3);
	else if (mode === 'diamond') w = h = W * Math.SQRT2;
	return { w, h, halfW: w / 2, halfH: h / 2 };
}

// Fixed print scale: SVG units → millimetres. Cells print at this exact size in
// every orientation, so pieces are consistent for hand-cutting. W=60 units →
// 30 mm, and tall/flat rhombi have a 30 mm edge.
export const MM_PER_UNIT = 0.5;

export interface ModeDef {
	id: Mode;
	label: string;
	sub: string;
	rotStep: number;
}

// Simple → complex, left to right. Square is the default.
export const MODES: ModeDef[] = [
	{ id: 'square',  label: 'Square',  sub: 'grid',      rotStep: 45 },
	{ id: 'diamond', label: 'Diamond', sub: '90° point', rotStep: 45 },
	{ id: 'tall',    label: 'Tall',    sub: '30° / 60°', rotStep: 30 },
	{ id: 'flat',    label: 'Flat',    sub: '60° / 30°', rotStep: 30 }
];

export function rotStepFor(mode: Mode): number {
	return MODES.find((m) => m.id === mode)?.rotStep ?? 30;
}

// ---- Polygon helpers ----

export function polyToPoints(poly: Pt[]): string {
	return poly.map(([x, y]) => `${x},${y}`).join(' ');
}

export function diamondPoly(cx: number, cy: number, geo: Geo): Pt[] {
	const { halfW, halfH } = geo;
	return [[cx, cy - halfH], [cx + halfW, cy], [cx, cy + halfH], [cx - halfW, cy]];
}

export function polyCentroid(poly: Pt[]): Pt {
	let x = 0, y = 0;
	for (const [px, py] of poly) { x += px; y += py; }
	return [x / poly.length, y / poly.length];
}

/** Convex point-in-polygon test (consistent cross-product signs) */
export function pointInPoly(px: number, py: number, poly: Pt[]): boolean {
	let pos = false, neg = false;
	for (let k = 0; k < poly.length; k++) {
		const [ax, ay] = poly[k];
		const [bx, by] = poly[(k + 1) % poly.length];
		const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
		if (cross > 0) pos = true;
		if (cross < 0) neg = true;
		if (pos && neg) return false;
	}
	return true;
}

// ---- Diamond-lattice edge/corner triangles (tall & flat modes only) ----

type EdgeKind =
	| 'tri-left' | 'tri-right' | 'tri-top' | 'tri-bottom'
	| 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br';

function edgePoly(kind: EdgeKind, cx: number, cy: number, geo: Geo): Pt[] {
	const { halfW, halfH } = geo;
	switch (kind) {
		case 'tri-right':  return [[cx, cy - halfH], [cx + halfW, cy], [cx, cy + halfH]];
		case 'tri-left':   return [[cx, cy - halfH], [cx - halfW, cy], [cx, cy + halfH]];
		case 'tri-bottom': return [[cx - halfW, cy], [cx + halfW, cy], [cx, cy + halfH]];
		case 'tri-top':    return [[cx - halfW, cy], [cx + halfW, cy], [cx, cy - halfH]];
		case 'corner-tl':  return [[cx, cy], [cx + halfW, cy], [cx, cy + halfH]];
		case 'corner-tr':  return [[cx, cy], [cx - halfW, cy], [cx, cy + halfH]];
		case 'corner-bl':  return [[cx, cy], [cx + halfW, cy], [cx, cy - halfH]];
		case 'corner-br':  return [[cx, cy], [cx - halfW, cy], [cx, cy - halfH]];
	}
}

// ---- Cells & board ----

export interface Cell {
	id: string;   // stable within a mode, e.g. "sq:2,3" or "d:4,6"
	poly: Pt[];
	cx: number;   // representative interior point (for anchoring / labels)
	cy: number;
	// Subdivision capability: a full 'cell' takes any tool; a 'half' (edge
	// triangle) can be split once more along splitAxis; 'terminal' (corner) can't.
	kind: 'cell' | 'half' | 'terminal';
	splitAxis?: 'h' | 'v';
}

export interface Board {
	cells: Cell[];
	w: number;
	h: number;
}

// Cell counts per mode and orientation, chosen so each board fits within A4's
// printable area at the fixed MM_PER_UNIT scale (no shrink-to-fit), landscape
// wider than tall and portrait taller than wide. For square: [cols, rows]; for
// diamond modes: [COLS, JMAX] where the lattice spans i = 0..2*COLS, j = 0..JMAX.
const DIMS: Record<Mode, Record<Orientation, [number, number]>> = {
	square:  { landscape: [9, 6],  portrait: [6, 9]  },
	diamond: { landscape: [6, 8],  portrait: [4, 12] },
	tall:    { landscape: [9, 6],  portrait: [6, 10] },
	flat:    { landscape: [5, 12], portrait: [3, 18] }
};

export function buildBoard(mode: Mode, orientation: Orientation = 'landscape'): Board {
	const [a, b] = DIMS[mode][orientation];
	return mode === 'square' ? squareGrid(a, b) : diamondLattice(mode, a, b);
}

function squareGrid(cols: number, rows: number): Board {
	const S = W;
	const cells: Cell[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const x = c * S, y = r * S;
			cells.push({
				id: `sq:${c},${r}`,
				poly: [[x, y], [x + S, y], [x + S, y + S], [x, y + S]],
				cx: x + S / 2,
				cy: y + S / 2,
				kind: 'cell'
			});
		}
	}
	return { cells, w: cols * S, h: rows * S };
}

function diamondLattice(mode: Mode, cols: number, jmax: number): Board {
	const geo = geoFor(mode);
	const { halfW, halfH } = geo;
	const IMAX = 2 * cols;
	const JMAX = jmax;
	const cells: Cell[] = [];

	for (let j = 0; j <= JMAX; j++) {
		for (let i = 0; i <= IMAX; i++) {
			if ((i + j) % 2 !== 0) continue;
			const cx = i * halfW, cy = j * halfH;
			const left = i === 0, right = i === IMAX, top = j === 0, bottom = j === JMAX;

			if (!left && !right && !top && !bottom) {
				cells.push({ id: `d:${i},${j}`, poly: diamondPoly(cx, cy, geo), cx, cy, kind: 'cell' });
				continue;
			}

			const isCorner = (left || right) && (top || bottom);
			let kind: EdgeKind;
			if (left && top) kind = 'corner-tl';
			else if (right && top) kind = 'corner-tr';
			else if (left && bottom) kind = 'corner-bl';
			else if (right && bottom) kind = 'corner-br';
			else if (left) kind = 'tri-right';
			else if (right) kind = 'tri-left';
			else if (top) kind = 'tri-bottom';
			else kind = 'tri-top';

			const poly = edgePoly(kind, cx, cy, geo);
			const [ccx, ccy] = polyCentroid(poly);

			if (isCorner) {
				// Corner = a quarter triangle: terminal.
				cells.push({ id: `e:${i},${j}`, poly, cx: ccx, cy: ccy, kind: 'terminal' });
			} else {
				// Edge triangle = a half: splittable once, orthogonally to its base.
				// Left/right borders have a vertical base → split horizontally; top/
				// bottom borders have a horizontal base → split vertically.
				const splitAxis: 'h' | 'v' = (left || right) ? 'h' : 'v';
				cells.push({ id: `e:${i},${j}`, poly, cx: ccx, cy: ccy, kind: 'half', splitAxis });
			}
		}
	}

	return { cells, w: IMAX * halfW, h: JMAX * halfH };
}

// ---- viewBox that fits the board rectangle after rotation ----

export function rotatedViewBox(w: number, h: number, deg: number, pad: number): string {
	const cx = w / 2, cy = h / 2;
	const rad = (deg * Math.PI) / 180;
	const cos = Math.cos(rad), sin = Math.sin(rad);
	const corners: Pt[] = [[0, 0], [w, 0], [w, h], [0, h]];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of corners) {
		const rx = cx + (x - cx) * cos - (y - cy) * sin;
		const ry = cy + (x - cx) * sin + (y - cy) * cos;
		minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
		minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
	}
	return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
}

// ---- Grain / wood (kept for the later colour step) ----

export interface GrainDef {
	id: Grain;
	label: string;
	angle: number;
	spacing: number;
	base: string;
	stroke: string;
	strokeWidth: number;
}

export const GRAINS: GrainDef[] = [
	{ id: 'none', label: 'Maple',  angle: 0,  spacing: 0,   base: '#f2e2c4', stroke: 'none',    strokeWidth: 0 },
	{ id: 'fine', label: 'Oak',    angle: 8,  spacing: 4,   base: '#dcb988', stroke: '#c19a63', strokeWidth: 0.4 },
	{ id: 'mid',  label: 'Cherry', angle: -5, spacing: 3,   base: '#b07a4a', stroke: '#8a5a32', strokeWidth: 0.5 },
	{ id: 'bold', label: 'Walnut', angle: 6,  spacing: 2.5, base: '#6b4423', stroke: '#4a2e16', strokeWidth: 0.6 }
];

export function grainById(id: Grain): GrainDef {
	return GRAINS.find((g) => g.id === id) ?? GRAINS[0];
}

// ---- Subdivision: recursive region tree per cell ----

// UI tool: a single Half whose direction is resolved from cursor position.
export type Tool = 'whole' | 'half' | 'quarters' | 'subcells';
// Internal division actually applied to geometry.
export type Division = 'half-h' | 'half-v' | 'quarters' | 'subcells';

export interface ToolDef {
	id: Tool;
	label: string;
	modes: Mode[];
}

const ALL: Mode[] = ['square', 'tall', 'flat'];

// Quarters = 4 triangles (fan); Sub-cells = 4 smaller self-similar cells
// (small squares in square mode, small diamonds in diamond modes).
export const TOOLS: ToolDef[] = [
	{ id: 'whole',    label: 'Whole',     modes: ALL },
	{ id: 'half',     label: 'Half',      modes: ALL },
	{ id: 'quarters', label: 'Quarters',  modes: ALL },
	{ id: 'subcells', label: 'Sub-cells', modes: ALL }
];

export function toolsForMode(mode: Mode): ToolDef[] {
	return TOOLS.filter((t) => t.modes.includes(mode));
}

/**
 * A region is a node in a cell's subdivision tree. A leaf (children = []) is a
 * face. `splitAxis` marks a half that may still be split once more (orthogonally).
 */
export interface Region {
	poly: Pt[];
	children: Region[];
	root?: boolean;          // the whole cell
	splitAxis?: 'h' | 'v';   // set on halves that can be split further
	div?: Division;          // the named division that produced this node's children
}

export function makeRoot(poly: Pt[]): Region {
	return { poly, children: [], root: true };
}

/** Initial region for a cell, respecting its subdivision capability. */
export function seedRegion(cell: Cell): Region {
	if (cell.kind === 'cell') return { poly: cell.poly, children: [], root: true };
	if (cell.kind === 'half') return { poly: cell.poly, children: [], splitAxis: cell.splitAxis };
	return { poly: cell.poly, children: [] }; // terminal
}

function centroidXY(poly: Pt[]): Pt {
	let x = 0, y = 0;
	for (const [px, py] of poly) { x += px; y += py; }
	return [x / poly.length, y / poly.length];
}

// Clip a convex polygon to one side of an axis-aligned line.
function clipHalf(poly: Pt[], axis: 'h' | 'v', at: number, keepLess: boolean): Pt[] {
	const coord = (p: Pt) => (axis === 'h' ? p[1] : p[0]);
	const inside = (p: Pt) => (keepLess ? coord(p) <= at + 1e-6 : coord(p) >= at - 1e-6);
	const out: Pt[] = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i], b = poly[(i + 1) % poly.length];
		const ain = inside(a), bin = inside(b);
		if (ain) out.push(a);
		if (ain !== bin) {
			const t = (at - coord(a)) / (coord(b) - coord(a));
			out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
		}
	}
	return out;
}

function splitAxisLine(poly: Pt[], axis: 'h' | 'v'): [Pt[], Pt[]] {
	const [cx, cy] = centroidXY(poly);
	const at = axis === 'h' ? cy : cx;
	return [clipHalf(poly, axis, at, true), clipHalf(poly, axis, at, false)];
}

// Four self-similar sub-cells: connect each vertex to centre via edge midpoints.
function subCells(poly: Pt[]): Pt[][] {
	const c = centroidXY(poly);
	const n = poly.length;
	const mid = (i: number): Pt => {
		const a = poly[i], b = poly[(i + 1) % n];
		return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
	};
	const out: Pt[][] = [];
	for (let i = 0; i < n; i++) {
		const v = poly[i];
		const mPrev = mid((i - 1 + n) % n);
		const mNext = mid(i);
		out.push([mPrev, v, mNext, c]);
	}
	return out;
}

// Quarters = fan from centre to each edge → 4 triangles. Diamond gives the
// usual quarter triangles; square gives 4 triangles (not 4 small squares —
// those come from sub-cells).
function fanTriangles(poly: Pt[]): Pt[][] {
	const c = centroidXY(poly);
	const n = poly.length;
	const out: Pt[][] = [];
	for (let i = 0; i < n; i++) out.push([c, poly[i], poly[(i + 1) % n]]);
	return out;
}

/** Apply a division to a leaf region, returning the subdivided region. */
function divideLeaf(leaf: Region, div: Division): Region {
	// A half (splitAxis set) can only be split once more, orthogonally.
	if (leaf.splitAxis) {
		const [a, b] = splitAxisLine(leaf.poly, leaf.splitAxis);
		return { ...leaf, children: [{ poly: a, children: [] }, { poly: b, children: [] }] };
	}
	// Otherwise it must be an undivided whole cell.
	if (!leaf.root) return leaf;

	switch (div) {
		case 'half-h': {
			const [a, b] = splitAxisLine(leaf.poly, 'h');
			return { ...leaf, div: 'half-h', children: [
				{ poly: a, children: [], splitAxis: 'v' },
				{ poly: b, children: [], splitAxis: 'v' }
			] };
		}
		case 'half-v': {
			const [a, b] = splitAxisLine(leaf.poly, 'v');
			return { ...leaf, div: 'half-v', children: [
				{ poly: a, children: [], splitAxis: 'h' },
				{ poly: b, children: [], splitAxis: 'h' }
			] };
		}
		case 'quarters':
			return { ...leaf, div: 'quarters', children: fanTriangles(leaf.poly).map((p) => ({ poly: p, children: [] })) };
		case 'subcells':
			return { ...leaf, div: 'subcells', children: subCells(leaf.poly).map((p) => ({ poly: p, children: [] })) };
		default:
			return leaf;
	}
}

/** Recursively find the leaf containing (x,y) and apply the division there. */
export function applyTool(region: Region, x: number, y: number, div: Division): Region {
	if (region.children.length === 0) {
		if (!pointInPoly(x, y, region.poly)) return region;
		return divideLeaf(region, div);
	}
	let changed = false;
	const kids = region.children.map((c) => {
		if (!changed && pointInPoly(x, y, c.poly)) {
			const nc = applyTool(c, x, y, div);
			if (nc !== c) changed = true;
			return nc;
		}
		return c;
	});
	return changed ? { ...region, children: kids } : region;
}

/** All leaf faces of a region, in order. */
export function leaves(region: Region): Region[] {
	if (region.children.length === 0) return [region];
	return region.children.flatMap(leaves);
}

/** Would-be child polygons if `div` were applied to the leaf under (x,y). */
export function previewTool(region: Region, x: number, y: number, div: Division): Pt[][] | null {
	const target = findLeaf(region, x, y);
	if (!target) return null;
	const divided = divideLeaf(target, div);
	if (divided === target || divided.children.length === 0) return null;
	return divided.children.map((c) => c.poly);
}

export function findLeaf(region: Region, x: number, y: number): Region | null {
	if (region.children.length === 0) {
		return pointInPoly(x, y, region.poly) ? region : null;
	}
	for (const c of region.children) {
		const f = findLeaf(c, x, y);
		if (f) return f;
	}
	return null;
}

// ---- Merge: fuse connected whole cells into one region ----

export interface MergeGroup {
	id: string;
	cellIds: string[];
	poly: Pt[];
}

function vkey(p: Pt): string {
	return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
}

/**
 * Boundary ring of a set of edge-adjacent polygons, or null if they don't form
 * exactly one simple connected region (disconnected, or touching only at a
 * vertex, or enclosing a hole). Works by cancelling shared internal edges and
 * stitching the surviving boundary edges into a single ring.
 */
export function unionOutline(polys: Pt[][]): Pt[] | null {
	const edges = new Map<string, [Pt, Pt]>();
	const ek = (a: Pt, b: Pt) => `${vkey(a)}>${vkey(b)}`;
	for (const poly of polys) {
		for (let i = 0; i < poly.length; i++) {
			const a = poly[i], b = poly[(i + 1) % poly.length];
			const rev = ek(b, a);
			if (edges.has(rev)) edges.delete(rev);
			else edges.set(ek(a, b), [a, b]);
		}
	}
	if (edges.size === 0) return null;

	const next = new Map<string, Pt>();
	for (const [a, b] of edges.values()) next.set(vkey(a), b);

	const first = edges.values().next().value as [Pt, Pt];
	const start = first[0];
	const ring: Pt[] = [];
	let cur = start, guard = 0;
	do {
		ring.push(cur);
		const nb = next.get(vkey(cur));
		if (!nb) return null;
		cur = nb;
		if (++guard > 100000) return null;
	} while (vkey(cur) !== vkey(start));

	if (ring.length !== edges.size) return null; // more than one ring → reject
	return ring;
}

/** General (non-convex) point-in-polygon via ray casting, for merged regions. */
export function pointInPolyGeneral(px: number, py: number, poly: Pt[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

export function mergeId(cellIds: string[]): string {
	return `m:${[...cellIds].sort().join('|')}`;
}

// ---- Lean serialisation: structure only; polygons recomputed on import ----

/**
 * Compact record of one cell's subdivision. `op` is the division applied; for
 * half-h/half-v, `halves` records which of the two halves was split once more.
 * 'split' is an edge-triangle (a half) that was split once. Undivided cells are
 * simply absent from the document.
 */
export interface LeanCell {
	op: Division | 'split';
	halves?: [boolean, boolean];
}

export interface LeanMode {
	cells: Record<string, LeanCell>;
	merges: string[][];
	colours: Record<string, Grain>;
}

/** State key combining grid mode and orientation, e.g. "square:landscape". */
export type StateKey = `${Mode}:${Orientation}`;

export function stateKeyOf(mode: Mode, orientation: Orientation): StateKey {
	return `${mode}:${orientation}`;
}

export interface DesignDoc {
	version: number;
	states: Record<string, LeanMode>; // keyed by StateKey
}

export const DOC_VERSION = 2;

/** Reduce a cell's region tree to its lean form, or null if undivided. */
export function regionToLean(region: Region): LeanCell | null {
	if (region.children.length === 0) return null;
	if (region.div === 'half-h' || region.div === 'half-v') {
		return {
			op: region.div,
			halves: [region.children[0].children.length > 0, region.children[1].children.length > 0]
		};
	}
	if (region.div === 'quarters' || region.div === 'subcells') {
		return { op: region.div };
	}
	// children but no named division → a split edge-half
	return { op: 'split' };
}

/** Rebuild a cell's region tree from its lean form, reusing the live geometry. */
export function rebuildRegion(cell: Cell, lean: LeanCell): Region {
	const seed = seedRegion(cell);
	if (lean.op === 'split') {
		// Edge half: seed carries splitAxis, so the division arg is ignored.
		return divideLeaf(seed, 'half-h');
	}
	let region = divideLeaf(seed, lean.op);
	if ((lean.op === 'half-h' || lean.op === 'half-v') && lean.halves) {
		const halves = lean.halves;
		region = {
			...region,
			children: region.children.map((c, i) => (halves[i] ? divideLeaf(c, 'half-h') : c))
		};
	}
	return region;
}

export function isGrain(v: unknown): v is Grain {
	return typeof v === 'string' && GRAINS.some((g) => g.id === v);
}