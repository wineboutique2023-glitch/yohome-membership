import process from "node:process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const productionHost = "yubwwqcohdjtvvryvvzs.supabase.co";
const previewProjectHost = "ncmgkslwzoxozsmmdqli.supabase.co";
const errorMessage = "Preview must use an explicitly configured standalone Supabase test project and its publishable key.";

export default defineConfig(({ command, mode }) => {
  const vars = process.env;
  if (vars.VERCEL_ENV === "production" && vars.YOHOME_PREVIEW_SUPABASE_HOST !== undefined) {
    throw new Error("Preview configuration cannot be used for a Production deployment.");
  }
  const isPreview = vars.VERCEL_ENV === "preview" || vars.YOHOME_PREVIEW_SUPABASE_HOST !== undefined;
  if (isPreview) {
    // Read supplied deployment variables, never fall back to the legacy .env.
    const host = vars.YOHOME_PREVIEW_SUPABASE_HOST;
    if (host !== previewProjectHost ||
        vars.VITE_SUPABASE_URL?.replace(/\/$/, "") !== `https://${host}` ||
        !vars.VITE_SUPABASE_ANON_KEY?.startsWith("sb_publishable_") ||
        vars.VITE_ENABLE_GIFT_CARDS !== "true") {
      throw new Error(errorMessage);
    }
  } else if (command === "build" && vars.VERCEL_ENV !== "production") {
    const configuredUrl = loadEnv(mode, process.cwd(), "VITE_").VITE_SUPABASE_URL;
    if (vars.VERCEL === "1" || !configuredUrl ||
        new URL(configuredUrl).hostname === productionHost) {
      throw new Error(errorMessage);
    }
  }
  return { plugins: [react()] };
});
