// Parquetry grid: parameterised rhombus/square tessellation math

export const W = 60; // diamond width (horizontal diagonal) in SVG units
export const HALF_W = W / 2;

export type Grain = 'none' | 'fine' | 'mid' | 'bold';
export type Shape = 'diamond' | 'tri-top' | 'tri-bottom' | 'tri-left' | 'tri-right';
export type Mode = 'rhombus60' | 'square';

// ---- Geometry per mode ----

export interface Geo {
	w: number;
	h: number;
	halfW: number;
	halfH: number;
}

/** rhombus60 = 60°/120° narrow diamond (H = W√3); square = 90° diamond (H = W) */
export function geoFor(mode: Mode): Geo {
	const w = W;
	const h = mode === 'square' ? W : W * Math.sqrt(3);
	return { w, h, halfW: w / 2, halfH: h / 2 };
}

/** Rotation step that produces clean axis-aligned arrangements for the mode */
export function rotStepFor(mode: Mode): number {
	return mode === 'square' ? 45 : 30;
}

// ---- Grid positions ----

export function slotKey(row: number, col: number): string {
	return `${row},${col}`;
}

/** Centre of a diamond at grid position (row, col). Row = half-row index. */
export function centre(row: number, col: number, geo: Geo): { x: number; y: number } {
	const isOffset = row % 2 !== 0;
	const cx = isOffset ? col * geo.w : geo.halfW + col * geo.w;
	const cy = geo.halfH + row * geo.halfH;
	return { x: cx, y: cy };
}

// ---- Shape vertices as SVG points strings ----

export function diamondPoints(cx: number, cy: number, geo: Geo): string {
	const { halfW, halfH } = geo;
	return [
		`${cx},${cy - halfH}`,
		`${cx + halfW},${cy}`,
		`${cx},${cy + halfH}`,
		`${cx - halfW},${cy}`
	].join(' ');
}

export function triTopPoints(cx: number, cy: number, geo: Geo): string {
	const { halfW, halfH } = geo;
	return `${cx},${cy - halfH} ${cx + halfW},${cy} ${cx - halfW},${cy}`;
}

export function triBottomPoints(cx: number, cy: number, geo: Geo): string {
	const { halfW, halfH } = geo;
	return `${cx + halfW},${cy} ${cx},${cy + halfH} ${cx - halfW},${cy}`;
}

export function triLeftPoints(cx: number, cy: number, geo: Geo): string {
	const { halfW, halfH } = geo;
	return `${cx},${cy - halfH} ${cx},${cy + halfH} ${cx - halfW},${cy}`;
}

export function triRightPoints(cx: number, cy: number, geo: Geo): string {
	const { halfW, halfH } = geo;
	return `${cx},${cy - halfH} ${cx + halfW},${cy} ${cx},${cy + halfH}`;
}

export function shapePoints(shape: Shape, cx: number, cy: number, geo: Geo): string {
	switch (shape) {
		case 'diamond':
			return diamondPoints(cx, cy, geo);
		case 'tri-top':
			return triTopPoints(cx, cy, geo);
		case 'tri-bottom':
			return triBottomPoints(cx, cy, geo);
		case 'tri-left':
			return triLeftPoints(cx, cy, geo);
		case 'tri-right':
			return triRightPoints(cx, cy, geo);
	}
}

// ---- Hit detection: nearest grid slot to a point ----

export function nearestSlot(
	px: number,
	py: number,
	cols: number,
	rows: number,
	geo: Geo
): { row: number; col: number; dist: number } | null {
	let best: { row: number; col: number; dist: number } | null = null;
	for (let r = 0; r < rows; r++) {
		const isOffset = r % 2 !== 0;
		const minC = isOffset ? -1 : 0;
		const maxC = isOffset ? cols : cols;
		for (let c = minC; c < maxC; c++) {
			const { x, y } = centre(r, c, geo);
			const dist = Math.hypot(px - x, py - y);
			if (!best || dist < best.dist) {
				best = { row: r, col: c, dist };
			}
		}
	}
	return best;
}

// ---- Enumerate grid slots ----

export interface GridSlot {
	row: number;
	col: number;
	cx: number;
	cy: number;
	key: string;
}

export function buildSlots(cols: number, halfRows: number, geo: Geo): GridSlot[] {
	const slots: GridSlot[] = [];
	for (let r = 0; r < halfRows; r++) {
		const isOffset = r % 2 !== 0;
		const numCols = isOffset ? cols + 1 : cols;
		const startCol = isOffset ? -1 : 0;
		for (let c = startCol; c < startCol + numCols; c++) {
			const { x, y } = centre(r, c, geo);
			slots.push({ row: r, col: c, cx: x, cy: y, key: slotKey(r, c) });
		}
	}
	return slots;
}

// ---- Bounding box of all diamond vertices ----

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export function slotsBBox(slots: GridSlot[], geo: Geo): BBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const s of slots) {
		minX = Math.min(minX, s.cx - geo.halfW);
		maxX = Math.max(maxX, s.cx + geo.halfW);
		minY = Math.min(minY, s.cy - geo.halfH);
		maxY = Math.max(maxY, s.cy + geo.halfH);
	}
	return { minX, minY, maxX, maxY };
}

/** viewBox string that fits the bbox after rotating it `deg` about its centre */
export function rotatedViewBox(bbox: BBox, deg: number, pad: number): string {
	const cx = (bbox.minX + bbox.maxX) / 2;
	const cy = (bbox.minY + bbox.maxY) / 2;
	const rad = (deg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const corners = [
		[bbox.minX, bbox.minY],
		[bbox.maxX, bbox.minY],
		[bbox.maxX, bbox.maxY],
		[bbox.minX, bbox.maxY]
	];
	let nMinX = Infinity, nMinY = Infinity, nMaxX = -Infinity, nMaxY = -Infinity;
	for (const [x, y] of corners) {
		const rx = cx + (x - cx) * cos - (y - cy) * sin;
		const ry = cy + (x - cx) * sin + (y - cy) * cos;
		nMinX = Math.min(nMinX, rx);
		nMaxX = Math.max(nMaxX, rx);
		nMinY = Math.min(nMinY, ry);
		nMaxY = Math.max(nMaxY, ry);
	}
	const x = nMinX - pad;
	const y = nMinY - pad;
	const w = nMaxX - nMinX + pad * 2;
	const h = nMaxY - nMinY + pad * 2;
	return `${x} ${y} ${w} ${h}`;
}

// ---- Grain / wood definitions ----

export interface GrainDef {
	id: Grain;
	label: string;
	angle: number;
	spacing: number;
	base: string;   // wood base tone
	stroke: string; // grain line colour (darker shade of base)
	strokeWidth: number;
}

// Light maple → dark walnut as grain density increases
export const GRAINS: GrainDef[] = [
	{ id: 'none', label: 'Maple',  angle: 0,  spacing: 0,   base: '#f2e2c4', stroke: 'none',    strokeWidth: 0 },
	{ id: 'fine', label: 'Oak',    angle: 8,  spacing: 4,   base: '#dcb988', stroke: '#c19a63', strokeWidth: 0.4 },
	{ id: 'mid',  label: 'Cherry', angle: -5, spacing: 3,   base: '#b07a4a', stroke: '#8a5a32', strokeWidth: 0.5 },
	{ id: 'bold', label: 'Walnut', angle: 6,  spacing: 2.5, base: '#6b4423', stroke: '#4a2e16', strokeWidth: 0.6 }
];

export const SHAPES: { id: Shape; label: string }[] = [
	{ id: 'diamond', label: 'Diamond' },
	{ id: 'tri-top', label: '▲ Top' },
	{ id: 'tri-bottom', label: '▼ Bottom' },
	{ id: 'tri-left', label: '◀ Left' },
	{ id: 'tri-right', label: '▶ Right' }
];