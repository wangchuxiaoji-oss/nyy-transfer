"use client";

export default function IconPreviewPage() {
  const icons = [
    { name: "512x512 (PWA)", src: "/icons/icon-512.png", size: 256 },
    { name: "192x192", src: "/icons/icon-192.png", size: 192 },
    { name: "180x180 (Apple)", src: "/icons/apple-touch-icon.png", size: 180 },
    { name: "Maskable 512", src: "/icons/maskable-icon-512.png", size: 192 },
    { name: "32x32 Favicon", src: "/icons/favicon-32.png", size: 64 },
    { name: "16x16 Favicon", src: "/icons/favicon-16.png", size: 64 },
  ];

  return (
    <div className="min-h-dvh bg-[#f5f5f5] p-8">
      <h1 className="text-2xl font-bold mb-6">图标预览</h1>
      <div className="flex flex-wrap gap-6">
        {icons.map((icon) => (
          <div key={icon.name} className="bg-white rounded-xl p-4 shadow-sm">
            <p className="text-sm text-gray-500 mb-3">{icon.name}</p>
            <img
              src={icon.src}
              alt={icon.name}
              width={icon.size}
              height={icon.size}
              className="rounded-lg"
            />
          </div>
        ))}
        <div className="bg-white rounded-xl p-4 shadow-sm">
          <p className="text-sm text-gray-500 mb-3">iOS 主屏模拟</p>
          <div className="w-[120px] h-[120px] bg-gradient-to-br from-gray-200 to-gray-100 rounded-[26px] flex items-center justify-center p-3 shadow-inner">
            <img
              src="/icons/apple-touch-icon.png"
              className="w-full h-full rounded-[18px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
