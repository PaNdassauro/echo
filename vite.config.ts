import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";

/**
 * O opus-recorder (UMD do webpack) descobre o objeto global com
 * `new Function("return this")()`. Num módulo ES o `this` solto é `undefined`,
 * então a linha sempre roda, e com a CSP do app (sem 'unsafe-eval') o navegador
 * registra uma violação de `script-src` em todo carregamento do painel, mesmo o
 * `try/catch` da biblioteca engolindo o erro. `globalThis` dá o mesmo valor sem
 * avaliar texto como código.
 */
const semEvalNoObjetoGlobal = (): Plugin => ({
  name: "echo-sem-eval-no-objeto-global",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/node_modules/opus-recorder/")) return null;
    if (!code.includes('new Function("return this")()')) return null;
    return { code: code.split('new Function("return this")()').join("globalThis"), map: null };
  },
});

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          ui: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-scroll-area",
          ],
          animation: ["framer-motion"],
          charts: ["recharts"],
          flow: ["@xyflow/react"],
          supabase: ["@supabase/supabase-js"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
  plugins: [
    semEvalNoObjetoGlobal(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["echo-icon.png"],
      manifest: {
        name: "Echo — Atendimento WhatsApp",
        short_name: "Echo",
        description: "Plataforma de Atendimento WhatsApp para Equipes",
        theme_color: "#18181b",
        background_color: "#09090b",
        display: "standalone",
        orientation: "portrait",
        // O app instalado abre direto na tela de trabalho (usuário sem sessão
        // é redirecionado a /auth pelo ProtectedRoute).
        start_url: "/dashboard",
        icons: [
          {
            src: "echo-icon.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "echo-icon.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "echo-icon.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // html intentionally excluded from precache so the SW doesn't
        // serve a stale shell. Navigations are handled by the network
        // directly: the host (gateway Caddy or any static host) sends
        // index.html with Cache-Control: max-age=0, must-revalidate, so the
        // browser always revalidates against the latest deploy.
        //
        // navigateFallback is explicitly set to undefined to override
        // vite-plugin-pwa's default of "index.html" — that default would
        // register a NavigationRoute bound to a precached index.html, but
        // index.html isn't in the precache anymore, which would throw at
        // runtime (see node_modules/vite-plugin-pwa/dist/index.js:838).
        // Without a NavigationRoute the SW never answers navigations, so the
        // API paths that are navigations (/auth/v1/verify from the e-mail
        // links, /functions/v1/instagram-oauth) need no denylist.
        globPatterns: ["**/*.{js,css,ico,png,svg,woff2,wav,mp3}"],
        // /config.js is written by the gateway on every start (runtime
        // configuration) and /_email/** is served by the gateway for the Auth
        // mailer: neither belongs to the build, and a precached config.js
        // would pin the configuration of the first visit.
        globIgnores: ["config.js", "_email/**"],
        navigateFallback: undefined,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3MB
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Add Web Push handlers (push + notificationclick) to the generated SW
        // without switching to injectManifest — keeps all caching behavior above
        // intact. Source lives in public/push-sw.js (served at /push-sw.js).
        importScripts: ["push-sw.js"],
        // No runtime caching, on purpose:
        // - HTML is NOT cached by the SW. Navigation requests pass through to
        //   the network and the browser revalidation is the single source of
        //   truth for HTML freshness (caching it in the SW caused tab-reopen
        //   to show the old build whenever the network blipped past the
        //   NetworkFirst timeout).
        // - API responses (/rest/v1, /auth/v1, /functions/v1, /realtime/v1,
        //   /qr, /config.js) are authenticated and per user: a cache keyed
        //   only by URL would hand one user's answer to the next one.
        // - Storage media stays out too: the browser HTTP cache already keeps
        //   the images (Cache-Control from the Storage), and routing every
        //   photo through the SW (intercept, clone, write to Cache Storage,
        //   evict the 101st) only puts latency and disk between scrolling and
        //   the image. A conversation scrolled fluidly on the dev server (no
        //   SW) and stuttered in production.
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "scripts/*.test.mjs"],
    // Máquina carregada estoura o padrão de 10 s dos hooks (beforeEach/afterEach), que o
    // --testTimeout não cobre. O teto só adia a falha de um hook travado de verdade.
    hookTimeout: 30000,
    // O client do Supabase é criado no import do módulo e lê a configuração de
    // runtime (src/lib/runtimeConfig.ts): sem estas VITE_* e sem /config.js,
    // qualquer teste que importe um hook que o usa quebra com "falta
    // supabaseAnonKey". Placeholders: nenhum teste fala com banco.
    env: {
      VITE_SUPABASE_URL: "https://test-placeholder.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-placeholder",
    },
  },
}));
