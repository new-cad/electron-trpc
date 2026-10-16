import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const output = fileURLToPath(new URL('../.electron-test/', import.meta.url));
await mkdir(output, { recursive: true });
for (const [entry, format] of [
  ['preload', 'cjs'],
  ['renderer', 'iife'],
]) {
  await build({
    configFile: false,
    logLevel: 'error',
    build: {
      emptyOutDir: false,
      outDir: output,
      lib: {
        entry: fileURLToPath(new URL(`./fixtures/${entry}.js`, import.meta.url)),
        name: 'transportTest',
        formats: [format],
        fileName: () => `${entry}.${format === 'cjs' ? 'cjs' : 'js'}`,
      },
      rolldownOptions: { external: ['electron'] },
    },
  });
}
const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; frame-src 'self'"><script src="./renderer.js"></script>`;
await writeFile(`${output}/index.html`, `${html}<iframe src="./child.html"></iframe>`);
await writeFile(`${output}/child.html`, html);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = [fileURLToPath(new URL('./electron-smoke.cjs', import.meta.url)), output];
if (process.platform === 'linux' && env.CI) args.unshift('--no-sandbox');
const child = spawn(require('electron'), args, { env, stdio: 'inherit', windowsHide: true });
const timer = setTimeout(() => {
  child.kill('SIGKILL');
  console.error('Electron transport tests timed out');
}, 60_000);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
clearTimeout(timer);
process.exitCode = typeof code === 'number' ? code : 1;
