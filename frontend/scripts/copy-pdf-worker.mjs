// 将 pdfjs-dist 的 worker 复制到 public/，作为同源静态资源提供。
// 目的：worker 版本与已安装的主库永远一致，且不依赖外部 CDN
//（国内网络/内网/离线均可用）。在 predev / prebuild 时自动执行。
import { createRequire } from "node:module";
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

// 通过解析主包定位 build 目录下的 worker，避免硬编码版本/路径
const pkgPath = require.resolve("pdfjs-dist/package.json");
const { version } = require(pkgPath);
const assetRoot = join(publicDir, "pdfjs", version);
const completeMarker = join(assetRoot, ".complete");
const moduleSrc = join(dirname(pkgPath), "legacy", "build", "pdf.min.mjs");
const workerSrc = join(dirname(pkgPath), "legacy", "build", "pdf.worker.min.mjs");

mkdirSync(publicDir, { recursive: true });
if (!existsSync(completeMarker)) {
  const temporaryRoot = `${assetRoot}.tmp-${process.pid}`;
  rmSync(temporaryRoot, { recursive: true, force: true });
  mkdirSync(temporaryRoot, { recursive: true });
  copyFileSync(moduleSrc, join(temporaryRoot, "pdf.min.mjs"));
  copyFileSync(workerSrc, join(temporaryRoot, "pdf.worker.min.mjs"));
  for (const directory of ["cmaps", "iccs", "standard_fonts", "wasm"]) {
    cpSync(join(dirname(pkgPath), directory), join(temporaryRoot, directory), { recursive: true });
  }
  writeFileSync(join(temporaryRoot, ".complete"), `${version}\n`);
  rmSync(assetRoot, { recursive: true, force: true });
  renameSync(temporaryRoot, assetRoot);
}

console.log(`[copy-pdf-worker] pdfjs-dist ${version} -> ${assetRoot}`);
