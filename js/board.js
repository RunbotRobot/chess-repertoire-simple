// Minimal dependency-free SVG board. The app is meant to be used mostly
// screen-off, so this is a secondary/setup-time view, not the star of the
// show — unicode glyphs keep it asset-free.

const GLYPHS = {
  p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚',
  P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
};

export function renderBoard(container, fen, { orientation = 'white', lastMove = null } = {}) {
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

  const squaresSvg = [];
  ranks.forEach((rank, rIdx) => {
    const rowSquares = rows[8 - rank];
    files.forEach((file, fIdx) => {
      const fileIdx = file.charCodeAt(0) - 97;
      const piece = rowSquares[fileIdx];
      const x = fIdx * cell, y = rIdx * cell;
      const isLight = (fileIdx + rank) % 2 === 1;
      const squareName = `${file}${rank}`;
      const isHighlighted = lastMove && (squareName === lastMove.from || squareName === lastMove.to);
      squaresSvg.push(
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${isHighlighted ? (isLight ? '#f4f281' : '#c9c24a') : (isLight ? '#eeeed2' : '#769656')}" />`
      );
      if (piece) {
        const isWhite = piece === piece.toUpperCase();
        squaresSvg.push(
          `<text x="${x + cell / 2}" y="${y + cell / 2 + 2}" font-size="${cell * 0.72}" text-anchor="middle" dominant-baseline="middle" fill="${isWhite ? '#fff' : '#111'}" stroke="${isWhite ? '#333' : 'none'}" stroke-width="${isWhite ? 1 : 0}">${GLYPHS[piece]}</text>`
        );
      }
    });
  });

  container.innerHTML = `<svg viewBox="0 0 ${px} ${px}" width="100%" height="100%" role="img" aria-label="Chess board">${squaresSvg.join('')}</svg>`;
}
