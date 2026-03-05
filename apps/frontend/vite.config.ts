import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const rootDir = path.resolve(__dirname, '../..')
  const env = loadEnv(mode, rootDir, '')
  const backendPort = env.PORT || '3001'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
          secure: false,
        },
      },
    },
  }
})
