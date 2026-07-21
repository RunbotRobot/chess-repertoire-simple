// Minimal dependency-free SVG board. The app is meant to be used mostly
// screen-off, so this is a secondary/setup-time view, not the star of the
// show — unicode glyphs keep it asset-free.
//
// Both colors render with the same *filled* glyph shapes (the ones Unicode
// labels "black chess pieces") rather than mixing in the hollow "white
// chess piece" glyphs — those are just thin outlines and are hard to see
// against either square color, which is exactly what made white pieces (and
// to a lesser extent black ones) hard to make out before. Color is conveyed
// by fill + a contrasting outline stroke instead, drawn via paint-order so
// the stroke sits behind the fill as a clean outline rather than thickening
// into it.
const GLYPHS = {
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
};

/**
 * @param {{orientation?: 'white'|'black', lastMove?: {from, to}|null,
 *   interactive?: {legalMoves: Array<{from,to}>, selectedSquare: string|null,
 *   onSquareClick: (square: string) => void}|null}} opts
 *   interactive, when set, makes every square clickable (via opts.onSquareClick)
 *   and highlights the selected square plus its legal destination squares.
 */
export function renderBoard(container, fen, { orientation = 'white', lastMove = null, interactive = null } = {}) {
  const boardPart = fen.split(' ')[0];
  const rows = boardPart.split('/').map((row) => {
    const squares = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) squares.push(null);
      } else {
        squares.push(ch);
      }
    }
    return squares;
  });

  const size = 8;
  const cell = 44;
  const px = size * cell;
  let ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  let files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  if (orientation === 'black') { ranks = ranks.slice().reverse(); files = files.slice().reverse(); }

  const destSquares = new Set();
  if (interactive?.selectedSquare) {
    for (const m of interactive.legalMoves || []) {
      if (m.from === interactive.selectedSquare) destSquares.add(m.to);
    }
  }

  const squaresSvg = [];
  ranks.forEach((rank, rIdx) => {
    const rowSquares = rows[8 - rank];
    files.forEach((file, fIdx) => {
      const fileIdx = file.charCodeAt(0) - 97;
      const piece = rowSquares[fileIdx];
      const x = fIdx * cell, y = rIdx * cell;
      const isLight = (fileIdx + rank) % 2 === 1;
      const squareName = `${file}${rank}`;
      const isLastMove = lastMove && (squareName === lastMove.from || squareName === lastMove.to);
      const isSelected = interactive?.selectedSquare === squareName;
      const isDest = destSquares.has(squareName);
      const cursor = interactive ? 'cursor:pointer;' : '';

      let fill = isLight ? '#eeeed2' : '#769656';
      if (isLastMove) fill = isLight ? '#f4f281' : '#c9c24a';
      if (isSelected) fill = isLight ? '#8fb4e3' : '#5b86bd';

      squaresSvg.push(
        `<rect data-square="${squareName}" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fill}" style="${cursor}" />`
      );
      if (isDest) {
        // Small dot on an empty square, a ring around an occupied one —
        // the familiar "legal destination" marker.
        if (piece) {
          squaresSvg.push(
            `<circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="${cell * 0.46}" fill="none" stroke="rgba(20,20,20,0.45)" stroke-width="3" style="pointer-events:none;" />`
          );
        } else {
          squaresSvg.push(
            `<circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="${cell * 0.14}" fill="rgba(20,20,20,0.35)" style="pointer-events:none;" />`
          );
        }
      }
      if (piece) {
        const isWhite = piece === piece.toUpperCase();
        const glyph = GLYPHS[piece.toLowerCase()];
        const fillColor = isWhite ? '#fbfbfb' : '#181818';
        const strokeColor = isWhite ? '#181818' : '#fbfbfb';
        const strokeWidth = isWhite ? 1.6 : 0.9;
        squaresSvg.push(
          `<text data-square="${squareName}" x="${x + cell / 2}" y="${y + cell / 2 + 2}" font-size="${cell * 0.74}" ` +
          `text-anchor="middle" dominant-baseline="middle" fill="${fillColor}" stroke="${strokeColor}" ` +
          `stroke-width="${strokeWidth}" paint-order="stroke" style="${cursor}">${glyph}</text>`
        );
      }
    });
  });

  container.innerHTML = `<svg viewBox="0 0 ${px} ${px}" width="100%" height="100%" role="img" aria-label="Chess board">${squaresSvg.join('')}</svg>`;

  // Reassigning onclick (rather than addEventListener) means re-rendering
  // — which replaces all the child nodes anyway via innerHTML above —
  // never stacks up duplicate handlers on the container itself.
  container.onclick = interactive
    ? (e) => {
        const square = e.target.closest('[data-square]')?.getAttribute('data-square');
        if (square) interactive.onSquareClick(square);
      }
    : null;
}
