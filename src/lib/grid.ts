// Parquetry grid: rectangular board of diamonds + edge & corner triangles

export const W = 60; // diamond width (horizontal diagonal) in SVG units
export const HALF_W = W / 2;

export type Grain = 'none' | 'fine' | 'mid' | 'bold';
export type Shape = 'diamond' | 'tri-top' | 'tri-bottom' | 'tri-left' | 'tri-right';
export type Mode = 'tall' | 'flat' | 'diamond';

export type EdgeKind =
	| 'tri-left' | 'tri-right' | 'tri-top' | 'tri-bottom'
	| 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br';

// ---- Geometry per mode ----

export interface Geo {
	w: number;
	h: number;
	halfW: number;
	halfH: number;
}

/** tall = 60°/120° upright diamond (H=W√3); flat = the same rhombus on its
 *  side (H=W/√3); diamond = 90° square on point (H=W). All are rhombi, so all
 *  tile the same lattice and any placed pattern transfers between them. */
export function geoFor(mode: Mode): Geo {
	const w = W;
	let h: number;
	if (mode === 'tall') h = W * Math.sqrt(3);
	else if (mode === 'flat') h = W / Math.sqrt(3);
	else h = W;
	return { w, h, halfW: w / 2, halfH: h / 2 };
}

export interface ModeDef {
	id: Mode;
	label: string;
	sub: string;
	rotStep: number;
}

export const MODES: ModeDef[] = [
	{ id: 'tall',    label: 'Tall',    sub: '30° / 60°', rotStep: 30 },
	{ id: 'flat',    label: 'Flat',    sub: '60° / 30°', rotStep: 30 },
	{ id: 'diamond', label: 'Diamond', sub: '45°',       rotStep: 45 }
];

/** Rotation step that produces clean axis-aligned arrangements for the mode */
export function rotStepFor(mode: Mode): number {
	return MODES.find((m) => m.id === mode)?.rotStep ?? 30;
}

// ---- Polygon helpers ----

export type Pt = [number, number];

export function diamondPoly(cx: number, cy: number, geo: Geo): Pt[] {
	const { halfW, halfH } = geo;
	return [[cx, cy - halfH], [cx + halfW, cy], [cx, cy + halfH], [cx - halfW, cy]];
}

export function edgePoly(kind: EdgeKind, cx: number, cy: number, geo: Geo): Pt[] {
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

export function polyToPoints(poly: Pt[]): string {
	return poly.map(([x, y]) => `${x},${y}`).join(' ');
}

/** Sub-shapes placeable inside a diamond slot (full + four halves) */
export function shapePoly(shape: Shape, cx: number, cy: number, geo: Geo): Pt[] {
	const { halfW, halfH } = geo;
	switch (shape) {
		case 'diamond':    return diamondPoly(cx, cy, geo);
		case 'tri-top':    return [[cx, cy - halfH], [cx + halfW, cy], [cx - halfW, cy]];
		case 'tri-bottom': return [[cx + halfW, cy], [cx, cy + halfH], [cx - halfW, cy]];
		case 'tri-left':   return [[cx, cy - halfH], [cx, cy + halfH], [cx - halfW, cy]];
		case 'tri-right':  return [[cx, cy - halfH], [cx + halfW, cy], [cx, cy + halfH]];
	}
}

export function shapePoints(shape: Shape, cx: number, cy: number, geo: Geo): string {
	return polyToPoints(shapePoly(shape, cx, cy, geo));
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

// ---- Board construction ----

export interface DiamondSlot {
	key: string;   // "d:i,j"
	i: number;
	j: number;
	cx: number;
	cy: number;
}

export interface EdgeSlot {
	key: string;   // "e:i,j"
	i: number;
	j: number;
	kind: EdgeKind;
	cx: number;
	cy: number;
}

export interface Board {
	diamonds: DiamondSlot[];
	edges: EdgeSlot[];
	w: number;
	h: number;
}

/**
 * Build a rectangular board. cols = full-diamond columns; jmax = height in
 * half-rows (each halfH tall). Centres sit on the checkerboard lattice
 * (i*halfW, j*halfH) with i+j even. Border lattice points become edge or
 * corner triangles; interior points become full diamonds.
 */
export function buildBoard(cols: number, jmax: number, geo: Geo): Board {
	const { halfW, halfH } = geo;
	const IMAX = 2 * cols;
	const diamonds: DiamondSlot[] = [];
	const edges: EdgeSlot[] = [];

	for (let j = 0; j <= jmax; j++) {
		for (let i = 0; i <= IMAX; i++) {
			if ((i + j) % 2 !== 0) continue;
			const cx = i * halfW;
			const cy = j * halfH;
			const left = i === 0, right = i === IMAX, top = j === 0, bottom = j === jmax;

			if (!left && !right && !top && !bottom) {
				diamonds.push({ key: `d:${i},${j}`, i, j, cx, cy });
				continue;
			}

			let kind: EdgeKind;
			if (left && top) kind = 'corner-tl';
			else if (right && top) kind = 'corner-tr';
			else if (left && bottom) kind = 'corner-bl';
			else if (right && bottom) kind = 'corner-br';
			else if (left) kind = 'tri-right';
			else if (right) kind = 'tri-left';
			else if (top) kind = 'tri-bottom';
			else kind = 'tri-top';

			edges.push({ key: `e:${i},${j}`, i, j, kind, cx, cy });
		}
	}

	return { diamonds, edges, w: IMAX * halfW, h: jmax * halfH };
}

// ---- viewBox that fits the board rectangle after rotation ----

export function rotatedViewBox(w: number, h: number, deg: number, pad: number): string {
	const cx = w / 2;
	const cy = h / 2;
	const rad = (deg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const corners: Pt[] = [[0, 0], [w, 0], [w, h], [0, h]];
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of corners) {
		const rx = cx + (x - cx) * cos - (y - cy) * sin;
		const ry = cy + (x - cx) * sin + (y - cy) * cos;
		minX = Math.min(minX, rx);
		maxX = Math.max(maxX, rx);
		minY = Math.min(minY, ry);
		maxY = Math.max(maxY, ry);
	}
	return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
}

// ---- Grain / wood definitions ----

export interface GrainDef {
	id: Grain;
	label: string;
	angle: number;
	spacing: number;
	base: string;
	stroke: string;
	strokeWidth: number;
}

// Light maple → dark walnut as grain density increases
export const GRAINS: GrainDef[] = [
	{ id: 'none', label: 'Maple',  angle: 0,  spacing: 0,   base: '#f2e2c4', stroke: 'none',    strokeWidth: 0 },
	{ id: 'fine', label: 'Oak',    angle: 8,  spacing: 4,   base: '#dcb988', stroke: '#c19a63', strokeWidth: 0.4 },
	{ id: 'mid',  label: 'Cherry', angle: -5, spacing: 3,   base: '#b07a4a', stroke: '#8a5a32', strokeWidth: 0.5 },
	{ id: 'bold', label: 'Walnut', angle: 6,  spacing: 2.5, base: '#6b4423', stroke: '#4a2e16', strokeWidth: 0.6 }
];

export function grainById(id: Grain): GrainDef {
	return GRAINS.find((g) => g.id === id) ?? GRAINS[0];
}

export const SHAPES: { id: Shape; label: string }[] = [
	{ id: 'diamond', label: 'Diamond' },
	{ id: 'tri-top', label: '▲ Top' },
	{ id: 'tri-bottom', label: '▼ Bottom' },
	{ id: 'tri-left', label: '◀ Left' },
	{ id: 'tri-right', label: '▶ Right' }
];