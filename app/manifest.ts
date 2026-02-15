import type { MetadataRoute } from "next";

/**
 * Web App Manifest (PWA).
 * Next.js lo publica automáticamente en: /manifest.webmanifest
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ClipCode",
    short_name: "ClipCode",
    description: "Pasa texto y links entre dispositivos con un código. Sin cuenta.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
