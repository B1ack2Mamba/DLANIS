// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'export',          // включает next export
    images: { unoptimized: true }, // картинки без Image Optimization (нужно для статического экспорта)
    assetPrefix: './',         // относительные пути к ассетам (важно для IPFS)
    trailingSlash: true,       // на IPFS /route/ ищет index.html внутри папки
};

export default nextConfig;
