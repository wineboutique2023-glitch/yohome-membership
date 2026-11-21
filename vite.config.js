import process from "node:process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  if (process.env.VERCEL_ENV === "preview") {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    const url = env.VITE_SUPABASE_URL && new URL(env.VITE_SUPABASE_URL);
    const previewHost = process.env.YOHOME_PREVIEW_SUPABASE_HOST;
    if (!previewHost || !url || url.hostname !== previewHost ||
        previewHost === "yubwwqcohdjtvvryvvzs.supabase.co" || !env.VITE_SUPABASE_ANON_KEY) {
      throw new Error("Preview must use the explicitly configured isolated Supabase project.");
    }
  }
  return { plugins: [react()] };
});
