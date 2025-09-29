# Stremio addon — ext.to via Cloudflare Worker (Render-ready)

## Quick deploy to Render
1. Create a public GitHub repo and upload all files in this folder.
2. On Render: New → Web Service → connect the repo.
3. Set Build: `npm install`, Start: `npm start`, Environment: Node (>=18).
4. Deploy. When live, copy:
   `https://<your-app>.onrender.com/manifest.json`
5. In Stremio: Addons → Add via URL → paste that manifest URL.

`config.json` already points `proxyBase` to your Worker:
- {proxyBase: "https://extto-proxy.davlav.workers.dev"}
