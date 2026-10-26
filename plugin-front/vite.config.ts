import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { reloadPluginModules } from "./dev/reload-modules";

export default defineConfig({
  plugins: [vue(), reloadPluginModules(__dirname)],
  resolve: { alias: { vue: resolve(__dirname, "src/host/host-vue.ts") } },
  esbuild: { keepNames: true },
  build: {
    lib: { entry: "src/main.ts", formats: ["es"], fileName: () => "main.mjs" },
    rollupOptions: {
      output: { inlineDynamicImports: true, assetFileNames: asset => (asset.name?.endsWith(".css") ? "main.css" : "[name][extname]") }
    }
  },
  // 安装版宿主提供生产版 Vue，没有 HMR runtime；开发组件也必须禁用热替换。
  server: { cors: true, hmr: false },
  base: "./"
});
