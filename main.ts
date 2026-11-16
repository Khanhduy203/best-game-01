// The entry program for best-game-01 (Node 22, standard library only): it
// hands the game in. game/ and screenshots/ are copied beside this file into
// the output directory, and dossier.json — the summary the judge reads — is
// written from the vendored make.fun library. The cover image is the first
// screenshot by name.
//
// Play it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier as describeEntry } from './vendor/makefun-game.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The scorer's own caps (reference/gate.json): text_max_bytes shapes the
// dossier's bytes; the rest refuse an entry the scorer would refuse — more
// than 4 screenshots, one over 256 KiB, more than 993 files or 48 MiB under
// game/, or a game/ path over 1000 bytes (game/ counts beside /output's own
// 1000-entry cap, its screenshots/ and dossier.json).
const DOSSIER_LIMITS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

function copyTree(name: string) {
  const from = path.join(root, name);
  const to = path.join(outDir, name);
  fs.mkdirSync(to, { recursive: true });
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

fs.mkdirSync(outDir, { recursive: true });
copyTree('game');
copyTree('screenshots');
fs.writeFileSync(path.join(outDir, 'dossier.json'), describeEntry(outDir, DOSSIER_LIMITS));
