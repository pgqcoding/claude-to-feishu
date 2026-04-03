import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outdir: resolve(__dirname, '../dist'),
  sourcemap: true,
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@larksuiteoapi/node-sdk',
  ],
};

// daemon 入口（被 cli.ts 后台拉起）
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, '../src/daemon.ts')],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

// CLI 入口（用户直接执行的命令，带 shebang）
await build({
  ...commonOptions,
  entryPoints: [resolve(__dirname, '../src/cli.ts')],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

// 在 cli.js 开头插入 shebang（esbuild banner 不支持 shebang + ESM 共存）
import { readFileSync, writeFileSync } from 'fs';
const cliPath = resolve(__dirname, '../dist/cli.js');
const cliContent = readFileSync(cliPath, 'utf8');
if (!cliContent.startsWith('#!')) {
  writeFileSync(cliPath, `#!/usr/bin/env node\n${cliContent}`);
}

console.log('Build complete: dist/daemon.js, dist/cli.js');
