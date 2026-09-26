import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { localFsPlugin } from './server/localFsPlugin.ts'
import { comboStorePlugin } from './server/comboStorePlugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // Both plugins are dev-server only. localFsPlugin lets the UI open a folder
  // in Explorer; comboStorePlugin keeps combos on disk so phones (which have no
  // File System Access API) can use them over plain http.
  plugins: [react(), viteSingleFile(), localFsPlugin(), comboStorePlugin()],
  // Keep the dev server on the port documented in the README and used by
  // RevealPlayer.bat. Vite still falls back to the next free port if busy.
  server: {
    port: 5174,
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
