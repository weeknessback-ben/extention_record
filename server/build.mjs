// Bundles the server into one file: node server/build.mjs → server/dist/server.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const serverOnly = {
  name: 'server-only',
  setup(b) {
    // lib/ imports the extension API; the server never calls it.
    b.onResolve({ filter: /^wxt\/browser$/ }, () => ({ path: path.join(root, 'server/src/browser-stub.ts') }));
    // Vite-style `?raw` imports (the report's CSS) become strings.
    b.onResolve({ filter: /\?raw$/ }, async (args) => {
      const resolved = await b.resolve(args.path.replace(/\?raw$/, ''), { resolveDir: args.resolveDir, kind: args.kind });
      return resolved.errors.length ? { errors: resolved.errors } : { path: resolved.path, namespace: 'raw' };
    });
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

await build({
  entryPoints: [path.join(root, 'server/src/main.ts')],
  outfile: path.join(root, 'server/dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: path.join(root, 'tsconfig.json'),
  jsx: 'automatic',
  external: ['playwright-core'],
  define: { 'process.env.NODE_ENV': '"production"' },
  // Some bundled CommonJS code calls require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  plugins: [serverOnly],
  logLevel: 'info',
});
