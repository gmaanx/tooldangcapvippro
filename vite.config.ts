import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin } from 'vite';

const currentDir = dirname(fileURLToPath(import.meta.url));

function kahootContentScriptsPlugin(): Plugin {
  const contentEntries: Array<{ name: string; entry: string; outFile: string }> = [
    {
      name: 'KahootMainWorldInjector',
      entry: resolve(currentDir, 'src/content/injector.ts'),
      outFile: 'injector.js',
    },
    {
      name: 'KahootIsolatedContentEngine',
      entry: resolve(currentDir, 'src/content/content.ts'),
      outFile: 'content.js',
    },
    {
      name: 'KahootUniversalLmsEngine',
      entry: resolve(currentDir, 'src/content/universal-lms.ts'),
      outFile: 'universal-lms.js',
    },
  ];

  return {
    name: 'kahoot-content-scripts-builder',
    apply: 'build',
    async closeBundle() {
      const distDir = resolve(currentDir, 'dist');
      mkdirSync(distDir, { recursive: true });
      copyFileSync(resolve(currentDir, 'manifest.json'), resolve(distDir, 'manifest.json'));

      for (const item of contentEntries) {
        await build({
          configFile: false,
          publicDir: false,
          esbuild: {
            legalComments: 'none',
          },
          build: {
            outDir: resolve(distDir, 'content'),
            emptyOutDir: false,
            sourcemap: false,
            target: 'es2022',
            lib: {
              entry: item.entry,
              name: item.name,
              formats: ['iife'],
              fileName: () => item.outFile,
            },
            rollupOptions: {
              output: {
                extend: true,
              },
            },
          },
        });
      }
    },
  };
}

export default defineConfig({
  root: resolve(currentDir, 'src'),
  publicDir: resolve(currentDir, 'public'),
  base: '/',
  esbuild: {
    legalComments: 'none',
  },
  build: {
    outDir: resolve(currentDir, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: {
        'popup/index': resolve(currentDir, 'src/popup/index.html'),
        'offscreen/offscreen': resolve(
          currentDir,
          'src/offscreen/offscreen.html'
        ),
        'background/service-worker': resolve(
          currentDir,
          'src/background/service-worker.ts'
        ),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background/service-worker') {
            return 'background/service-worker.js';
          }
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [kahootContentScriptsPlugin()],
});
