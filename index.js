// index.js — Minimal Stremio addon (Torrentio only, no ext.to) for a clean deploy

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import { addonBuilder } from 'stremio-addon-sdk'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- Load manifest & config ---
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'))

let CONFIG = { torrentio: { enabled: true, base: 'https://torrentio.strem.fun' } }
try {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
  const cfg = JSON.parse(raw)
  // keep only torrentio fields for this minimal version
  CONFIG.torrentio = cfg.torrentio ?? CONFIG.torrentio
  console.log('[config] loaded', CONFIG)
} catch (e) {
  console.warn('[config] using defaults')
}

// --- tiny helpers ---
function parseId(id) {
  if (!id || typeof id !== 'string') return { imdb: null, season: null, episode: null }
  const p = id.split(':')
  return {
    imdb: p[0] || null,
    season: p[1] ? parseInt(p[1], 10) : null,
    episode: p[2] ? parseInt(p[2], 10) : null
  }
}

async function fetchTorrentio(type, imdb, base) {
  const url = `${base.replace(/\/$/, '')}/stream/${encodeURIComponent(type)}/${encodeURIComponent(imdb)}.json`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`torrentio ${res.status}`)
  const data = await res.json()
  return (data && Array.isArray(data.streams)) ? data.streams : []
}

// --- Addon ---
const builder = new addonBuilder(manifest)

builder.defineStreamHandler(async (_args) => {
  // normalize args shape if nested
  let args = _args
  if (args && typeof args.type === 'object' && args.type.type && !args.id) {
    args = args.type
  }
  const { type, id, extra } = args || {}
  console.log('[stream] req', { type, id, extra })

  const { imdb } = parseId(id)
  if (!type || !imdb) {
    console.warn('[stream] invalid request (missing type or imdb)')
    return { streams: [] }
  }

  // --- Torrentio only ---
  if (CONFIG.torrentio?.enabled) {
    try {
      const base = CONFIG.torrentio.base || 'https://torrentio.strem.fun'
      const streams = await fetchTorrentio(type, imdb, base)
      if (streams.length) {
        console.log('[torrentio] using', streams.length, 'streams')
        return { streams }
      } else {
        console.warn('[torrentio] returned 0 streams')
      }
    } catch (e) {
      console.warn('[torrentio] error', e?.message || e)
    }
  }

  return { streams: [] }
})

// --- HTTP server ---
const app = express()
const iface = builder.getInterface()
app.get('/manifest.json', (req, res) => res.json(iface.manifest))
app.get('/stremio/v1', (req, res) => res.json(iface.manifest))
app.get('/stremio/v1/manifest.json', (req, res) => res.json(iface.manifest))
app.get('/stremio/v1/stream/:type/:id.json', async (req, res) => {
  try {
    const { type, id } = req.params
    const extra = req.query || {}
    const result = await iface.get('stream', { type, id, extra })
    res.json(result || { streams: [] })
  } catch (e) {
    console.error('stream error', e)
    res.status(500).json({ streams: [] })
  }
})
app.get('/', (req, res) => res.type('text/plain').send('Torrentio-only addon live. Use /manifest.json'))

const PORT = process.env.PORT || 7000
app.listen(PORT, () => {
  console.log(`Stremio addon listening on http://localhost:${PORT}`)
  console.log('Manifest URL:', `http://localhost:${PORT}/manifest.json`)
})
