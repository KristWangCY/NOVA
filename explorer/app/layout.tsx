import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "127.0.0.1:3100";
  const localHost = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const protocol = incoming.get("x-forwarded-proto") || (localHost ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "NOVA Explorer — 本地区块浏览器";
  const description = "观察 NOVA 私有链的区块、交易、文件存证、账户与验证节点状态。";
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: image, width: 1731, height: 909, alt: "NOVA Explorer — 看见每一次共识发生。" }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
