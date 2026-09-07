import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const watching = process.argv.includes("--watch");

// Backend selection happens at build time. With SUPABASE_URL set (Vercel env vars) the PWA
// talks to Supabase directly; without it, it uses the local FastAPI API (v1 behaviour).
const define = {
  "process.env.NODE_ENV": JSON.stringify(watching ? "development" : "production"),
  __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL || ""),
  __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(process.env.SUPABASE_PUBLISHABLE_KEY || ""),
  __VAPID_PUBLIC_KEY__: JSON.stringify(process.env.VAPID_PUBLIC_KEY || ""),
  __APP_VERSION__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || new Date().toISOString().slice(0, 16))
};

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "assets"), { recursive: true });
await cp(path.join(root, "public"), dist, { recursive: true });

const options = {
  entryPoints: [path.join(root, "src", "main.tsx")],
  bundle: true,
  minify: !watching,
  sourcemap: true,
  target: ["es2020"],
  outdir: path.join(dist, "assets"),
  // Content-hashed names let /assets/* be cached immutably; index.html is rewritten below.
  entryNames: watching ? "app" : "[name]-[hash]",
  assetNames: "[name]-[hash]",
  metafile: true,
  define,
  logLevel: "info"
};

async function writeIndex(metafile) {
  const outputs = Object.keys(metafile?.outputs || {});
  const js = outputs.find((file) => file.endsWith(".js")) || path.join("dist", "assets", "app.js");
  const css = outputs.find((file) => file.endsWith(".css")) || path.join("dist", "assets", "app.css");
  const toUrl = (file) => "/" + path.relative(dist, path.resolve(root, file)).split(path.sep).join("/");
  const sourceHtml = await readFile(path.join(root, "index.html"), "utf8");
  const productionHtml = sourceHtml.replace(
    '<script type="module" src="/src/main.tsx"></script>',
    `<link rel="stylesheet" href="${toUrl(css)}" />\n    <script type="module" src="${toUrl(js)}"></script>`
  );
  await writeFile(path.join(dist, "index.html"), productionHtml, "utf8");
}

if (watching) {
  const context = await esbuild.context({
    ...options,
    plugins: [{
      name: "rewrite-index",
      setup(build) {
        build.onEnd(async (result) => { if (result.metafile) await writeIndex(result.metafile); });
      }
    }]
  });
  await context.watch();
  console.log("Watching React sources. Refresh the browser after each rebuild.");
} else {
  const result = await esbuild.build(options);
  await writeIndex(result.metafile);
}
