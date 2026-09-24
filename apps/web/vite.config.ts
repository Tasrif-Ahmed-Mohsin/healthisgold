import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Every API prefix is proxied, so the app and the API share one origin in development.
// That is what lets the session cookie be SameSite=Strict and httpOnly with no CORS policy
// opened on endpoints that serve patient records.
const API = 'http://localhost:3000';
const proxied = ['/auth', '/cases', '/doctors', '/me', '/staff', '/health'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: Object.fromEntries(proxied.map((prefix) => [prefix, { target: API, changeOrigin: true }])),
  },
});
