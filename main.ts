// fastmark-md driver: renders every case of cases.json with parse.js, each on its own, and writes
// the HTML strings as one JSON array to html.json. The harness runs `node /bot/main.ts`; for local
// runs MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR replace /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

type Case = { id: string; markdown: string };

// The run is short: Maglev code is good enough, and TurboFan's compile work (background threads
// count as CPU time too) costs more than it saves. Set before parse.js is loaded.
setFlagsFromString('--no-opt');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const { parse } = await import('./parse.js');
const cases: Case[] = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

// Serialise each result as soon as it is rendered so only the JSON text stays alive.
const parts: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) parts[i] = JSON.stringify(parse(cases[i].markdown));
writeFileSync(join(outputDir, 'html.json'), '[' + parts.join(',') + ']');
