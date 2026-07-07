import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "cloudflare-rocket-loader-optout",
      transformIndexHtml(html) {
        return html.replaceAll("<script type=\"module\"", "<script data-cfasync=\"false\" type=\"module\"");
      }
    }
  ],
  server: {
    allowedHosts: ["hn.frp.one"]
  }
});
