// Parquetry grid: 60° diamond tessellation math

export const W = 60; // diamond width (horizontal diagonal) in SVG units
export const H = W * Math.sqrt(3); // diamond height (vertical diagonal) ~103.9
export const HALF_W = W / 2;
export const HALF_H = H / 2;

export type Grain = 'none' | 'fine' | 'mid' | 'bold';
export type Shape = 'diamond' | 'tri-top' | 'tri-bottom' | 'tri-left' | 'tri-right';

export interface SlotId {
	row: number;
	col: number;
}

export interface PlacedPiece {
	slotKey: string;
	shape: Shape;
	grain: Grain;
	sub?: 'top' | 'bottom' | 'left' | 'right'; // which sub-slot for triangles
}

// ---- Grid positions ----

export function slotKey(row: number, col: number): string {
	return `${row},${col}`;
}

export function subKey(row: number, col: number, sub: string): string {
	return `${row},${col},${sub}`;
}

/** Centre of a diamond at grid position (row, col). Row = half-row index. */
export function centre(row: number, col: number): { x: number; y: number } {
	const isOffset = row % 2 !== 0;
	const cx = isOffset ? col * W : HALF_W + col * W;
	const cy = HALF_H + row * HALF_H;
	return { x: cx, y: cy };
}

// ---- Shape vertices as SVG points strings ----

export function diamondPoints(cx: number, cy: number): string {
	return [
		`${cx},${cy - HALF_H}`,
		`${cx + HALF_W},${cy}`,
		`${cx},${cy + HALF_H}`,
		`${cx - HALF_W},${cy}`
	].join(' ');
}

export function triTopPoints(cx: number, cy: number): string {
	// Top half: top vertex, right vertex, left vertex (horizontal cut)
	return `${cx},${cy - HALF_H} ${cx + HALF_W},${cy} ${cx - HALF_W},${cy}`;
}

export function triBottomPoints(cx: number, cy: number): string {
	return `${cx + HALF_W},${cy} ${cx},${cy + HALF_H} ${cx - HALF_W},${cy}`;
}

export function triLeftPoints(cx: number, cy: number): string {
	// Left half: top, centre, bottom, left (vertical cut)
	return `${cx},${cy - HALF_H} ${cx},${cy + HALF_H} ${cx - HALF_W},${cy}`;
}

export function triRightPoints(cx: number, cy: number): string {
	return `${cx},${cy - HALF_H} ${cx + HALF_W},${cy} ${cx},${cy + HALF_H}`;
}

export function shapePoints(shape: Shape, cx: number, cy: number): string {
	switch (shape) {
		case 'diamond':
			return diamondPoints(cx, cy);
		case 'tri-top':
			return triTopPoints(cx, cy);
		case 'tri-bottom':
			return triBottomPoints(cx, cy);
		case 'tri-left':
			return triLeftPoints(cx, cy);
		case 'tri-right':
			return triRightPoints(cx, cy);
	}
}

// ---- Hit detection: find nearest grid slot to a point ----

export function nearestSlot(
	px: number,
	py: number,
	cols: number,
	rows: number
): { row: number; col: number; dist: number } | null {
	let best: { row: number; col: number; dist: number } | null = null;

	for (let r = 0; r < rows; r++) {
		const maxCol = r % 2 === 0 ? cols : cols + 1;
		const minCol = r % 2 === 0 ? 0 : -1;
		for (let c = minCol; c < maxCol; c++) {
			const { x, y } = centre(r, c);
			const dist = Math.hypot(px - x, py - y);
			if (!best || dist < best.dist) {
				best = { row: r, col: c, dist };
			}
		}
	}
	return best;
}

/** Determine which sub-triangle quadrant a point falls in relative to diamond centre */
export function subQuadrant(
	px: number,
	py: number,
	cx: number,
	cy: number
): 'top' | 'bottom' | 'left' | 'right' {
	const dx = px - cx;
	const dy = py - cy;
	// Normalise by diamond proportions
	const ndx = dx / HALF_W;
	const ndy = dy / HALF_H;

	if (Math.abs(ndx) > Math.abs(ndy)) {
		return ndx > 0 ? 'right' : 'left';
	}
	return ndy > 0 ? 'bottom' : 'top';
}

// ---- Enumerate all grid slots ----

export interface GridSlot {
	row: number;
	col: number;
	cx: number;
	cy: number;
	key: string;
}

export function allSlots(cols: number, halfRows: number): GridSlot[] {
	const slots: GridSlot[] = [];
	for (let r = 0; r < halfRows; r++) {
		const isOffset = r % 2 !== 0;
		const minC = isOffset ? 0 : 0;
		const maxC = isOffset ? cols : cols;
		for (let c = minC; c < maxC; c++) {
			const { x, y } = centre(r, c);
			slots.push({ row: r, col: c, cx: x, cy: y, key: slotKey(r, c) });
		}
	}
	return slots;
}

// ---- Grain pattern SVG definitions ----

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