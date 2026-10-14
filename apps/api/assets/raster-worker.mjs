// 栅格化子进程（F-080）：只做一件事——把父进程发来的 SVG 栅格化成 PNG / 原始像素并回传。
// 放在单独的进程里，是因为 sharp / libvips 的一次原生渲染无法从 JS 里中止：超时就由父进程直接终止本进程，
// 立即释放并发名额，不必等原生渲染自己停下（见 export-raster.ts）。字体环境（FONTCONFIG_*）由父进程在启动时传入。
import sharp from 'sharp';

sharp.cache(false);

async function rasterize({ svg, density, limitInputPixels, timeoutSeconds, format }) {
  const image = sharp(Buffer.from(svg), { density, limitInputPixels })
    .timeout({ seconds: timeoutSeconds })
    .flatten({ background: '#ffffff' });
  if (format === 'png') return { data: await image.png().toBuffer() };
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

process.on('message', async (request) => {
  try {
    process.send({ id: request.id, ok: true, ...(await rasterize(request)) });
  } catch (error) {
    process.send({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});

// 父进程退出（IPC 通道关闭）时本进程随之退出，不留孤儿
process.on('disconnect', () => process.exit(0));
