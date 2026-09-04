import { defineConfig } from 'tsdown'

/** Build the executor plugin, invariant companion, and standalone CLI. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/bin.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // The executor is shipped as a relocatable artifact. Inline the dsh local
  // implementations and Cordis into the bundle so the target host does not
  // need the dsh workspace or any @deepseek-ai/dsh-* installation.
  deps: {
    alwaysBundle: [/^@deepseek-ai\/dsh-/, /^@deepseek-ai\/cordis$/],
    neverBundle: [
      '@vscode/ripgrep',
      /^@vscode\/ripgrep-/,
      'koffi',
      'node-pty',
      /^@koromix\/koffi-/,
      /^@deepseek-ai\/node-addon-landlock-run/,
    ],
  },
})
