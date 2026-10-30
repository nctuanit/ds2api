import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

function rmRf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function walkFiles(dir, extFilter) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extFilter));
    } else if (!extFilter || full.endsWith(extFilter)) {
      results.push(full);
    }
  }
  return results;
}

console.log('1. Cleaning dist/...');
rmRf(distDir);

console.log('2. Compiling TypeScript ESM + Declarations (tsc)...');
execSync('npx tsc -p tsconfig.json', {
  cwd: rootDir,
  stdio: 'inherit',
});

// Create .mjs and .d.mts copies for ESM entrypoints while keeping .js/.d.ts files for relative imports
for (const jsFile of walkFiles(distDir, '.js')) {
  const mjsFile = jsFile.replace(/\.js$/, '.mjs');
  const content = fs.readFileSync(jsFile, 'utf8');
  fs.writeFileSync(mjsFile, content, 'utf8');
}
for (const dtsFile of walkFiles(distDir, '.d.ts')) {
  const dmtsFile = dtsFile.replace(/\.d\.ts$/, '.d.mts');
  const content = fs.readFileSync(dtsFile, 'utf8');
  fs.writeFileSync(dmtsFile, content, 'utf8');
}

console.log('3. Compiling CommonJS output for require() compatibility...');
const cjsTmpDir = path.join(rootDir, 'dist-cjs-tmp');
rmRf(cjsTmpDir);
execSync(
  `npx tsc -p tsconfig.json --module CommonJS --moduleResolution Node10 --declaration false --declarationMap false --sourceMap false --outDir "${cjsTmpDir}"`,
  {
    cwd: rootDir,
    stdio: 'inherit',
  },
);

for (const cjsJsFile of walkFiles(cjsTmpDir, '.js')) {
  const rel = path.relative(cjsTmpDir, cjsJsFile);
  const targetCjs = path.join(distDir, rel.replace(/\.js$/, '.cjs'));
  let code = fs.readFileSync(cjsJsFile, 'utf8');
  // Rewrite relative require("./foo.js") -> require("./foo.cjs")
  code = code.replace(/require\((['"])(\.\.?\/[^'"]+?)\.js\1\)/g, 'require($1$2.cjs$1)');
  fs.mkdirSync(path.dirname(targetCjs), { recursive: true });
  fs.writeFileSync(targetCjs, code, 'utf8');
}

rmRf(cjsTmpDir);
console.log('Build completed successfully!');
