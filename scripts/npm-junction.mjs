import { realpathSync, symlinkSync } from 'node:fs';

const [link, target] = process.argv.slice(2);
if (!link || !target) throw new Error('Usage: node npm-junction.mjs <link> <external-node-modules>');
symlinkSync(realpathSync.native(target), link, 'junction');
