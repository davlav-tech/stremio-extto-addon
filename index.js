// index.js — Render-ready Stremio addon (ext.to via Cloudflare Worker + Torrentio fallback)
//
// Features:
// - Cinemeta lookup to build a good search query (movie: "Title Year", series: "Title sXXeYY")
// - Search ext.to through your Cloudflare Worker:
//     1) /browse/?q=...  → preferred (current site behavior)
//     2) /search?q=...    → fallback path
//     3) If list pages show no magnets: open up to 5 detail pages (/torrent/...) and extract magnets
// - Cheerio HTML scraping for magnets (a[href^="magnet:?xt="])
// - Timeouts + retries
// - Torrentio fallback if ext.to yields nothing
//
// Requirements: Node 18+. package.json deps: express, stremio-addon-sdk, cheerio

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import { addonBuilder } from 'stremio-addon-sdk'
import * as cheerio from 'cheerio'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load manifest & config
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'))

let CONFIG = { proxyBase: "", proxyKey: "", torrentio: { enabled: true, base: "https://torrentio.strem.fun" } }
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
  console.log('[config] loaded', CONFIG)
} catch (e) {
  console.warn('[config] using defaults')
}

// -------------------- Helpers --------------------
async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try { return await fetch(url, { ...opts, signal: controller.signal }) }
  finally { clearTimeout(id) }
}
async function withRetries(fn, { retries = 2, delayMs = 500 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try { return await fn(i) } catch (e) {
      lastErr = e
      if (i < retries) await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)))
    }
  }
  throw lastErr
}
function pad2(n){ return String(n).padStart(2,'0') }
function parseMetaId(id){
  const p = id.split(':')
  return { imdb: p[0], season: p[1]?parseInt(p[1],10):null, episode: p[2]?parseInt(p[2],10):null }
}
async function fetchCinemetaMeta(type, id){
  const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, 10000)
  if (!res.ok) throw new Error(`cinemeta ${res.status}`)
  const data = await res.json()
  return data && data.meta ? data.meta : null
}
function buildSearchQuery(type, meta, s, e){
  if (!meta) return ''
  const title = meta.name || meta.title || ''
  const year = meta.year || (meta.releaseInfo && parseInt(meta.releaseInfo,10)) || ''
  if (type === 'series' && s && e) return `${title} s${pad2(s)}e${pad2(e)}`.trim()
  return `${title} ${year}`.trim()
}

// -------------------- Scraping helpers --------------------
// If ext.to markup changes, tweak these selectors here (single place):
// - Magnets on page: 'a[href^="magnet:?xt="]'
// - Detail links on list pages: 'a[href^="/torrent/"]'
function extractMagnetsFromHtml(html){
  const $ = cheerio.load(html)
  const out = []
  $('a[href^="magnet:?xt="]').each((_, a) => {
    const href = $(a).attr('href')
    if (href && href.startsWith('magnet:?')) out.push(href)
  })
  // unique
  return Array.from(new Set(out))
}
function enrichLabelsFromDom(html, magnets){
  const $ = cheerio.load(html)
  const set = new Set(magnets)
  const res = []
  $('a[href^="magnet:?xt="]').each((_, a) => {
    const href = $(a).attr('href')
    if (!href || !set.has(href)) return
    const row = $(a).closest('tr, .search-result, .result, li, .row, .card, .table, .torrent')
    const text = row.text().replace(/\s+/g, ' ').trim()
    const mQual = text.match(/(2160p|4k|1080p|720p|480p)/i)
    const mSize = text.match(/(\d+(?:\.\d+)?\s?(?:GB|MB))/i)
    res.push({
      magnet: href,
      quality: mQual ? mQual[1].toUpperCase() : undefined,
      size: mSize ? mSize[1].toUpperCase() : undefined
    })
  })
  const map = new Map(res.map(x => [x.magnet, x]))
  return magnets.map(m => map.get(m) || { magnet: m })
}
function extractDetailLinksFromList(html, base){
  const $ = cheerio.load(html)
  const out = []
  $('a[href^="/torrent/"]').each((_, a) => {
    const href = $(a).attr('href')
    if (!href) return
    const abs = href.startsWith('http') ? href : `${base}${href}`
    out.push(abs)
  })
  // take first few to limit requests
  return Array.from(new Set(out)).slice(0, 5)
}
async function scrapeMagnetsFromDetails(detailUrls, headers){
  const results = []
  for (const url of detailUrls) {
    try {
      const res = await fetchWithTimeout(url, { headers }, 12000)
      if (!res.ok) continue
      const html = await res.text()
      const mags = extractMagnetsFromHtml(html)
      if (mags.length) {
        const labeled = enrichLabelsFromDom(html, mags)
        results.push(...labeled)
      }
    } catch (_) {}
  }
  // unique by magnet
  const seen = new Set()
  const uniq = []
  for (const e of results) {
    if (!seen.has(e.magnet)) { seen.add(e.magnet); uniq.push(e) }
  }
  return uniq
}

// Main search via Worker
async function searchViaWorker(q){
  const base = (CONFIG.proxyBase || 'https://ext.to').replace(/\/$/,'')
  const headers = { accept: 'text/html' }
  if (CONFIG.proxyKey) headers['X-Proxy-Key'] = CONFIG.proxyKey

  // Try list pages in this order
  const candidates = [
    `${base}/browse/?q=${encodeURIComponent(q)}`,
    `${base}/search?q=${encodeURIComponent(q)}`
  ]

  const getHtml = async (url) => {
    const res = await fetchWithTimeout(url, { headers }, 12000)
    if (!res.ok) throw new Error(`proxy ${res.status} for ${url}`)
    return await res.text()
  }

  for (const url of candidates) {
    try {
      const html = await getHtml(url)
      let magnets = extractMagnetsFromHtml(html)
      if (magnets.length) return enrichLabelsFromDom(html, magnets)

      // No magnets on list? probe a few detail pages
      const detailLinks = extractDetailLinksFromList(html, base)
      if (detailLinks.length) {
        const fromDetails = await scrapeMagnetsFromDetails(detailLinks, headers)
        if (fromDetails.length) return fromDetails
      }
    } catch (e) {
      console.warn('[worker] fetch list error', e?.message || e)
    }
  }
  return []
}

function toStreams(mags){
  return mags.slice(0, 20).map((e, i) => {
    const title = [e.quality, e.size].filter(Boolean).join(' • ') || `Magnet #${i+1}`
    return { title, url: e.magnet, behaviorHints: {} }
  })
}

// Torrentio fallback
async function fetchTorrentioFallback(type, imdb, base = 'https://torrentio.strem.fun'){
  const url = `${base.replace(/\/$/,'')}/stream/${encodeURIComponent(type)}/${encodeURIComponent(imdb)}.json`
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, 10000)
  if (!res.ok) throw new Error(`torrentio ${res.status}`)
  const data = await res.json()
  return (data && Array.isArray(data.streams)) ? data.streams : []
}

// -------------------- Addon --------------------
const builder = new addonBuilder(manifest)

builder.defineStreamHandler(async (args) => {
  const { type, id } = args
  const { imdb, season, episode } = parseMetaId(id)
  console.log('[stream] req', { type, id })

  let meta = null
  try {
    const cinId = imdb + (season && episode ? `:${season}:${episode}` : '')
    meta = await fetchCinemetaMeta(type, cinId)
  } catch (e) {
    console.warn('[cinemeta] error', e?.message || e)
  }

  const query = buildSearchQuery(type, meta, season, episode)
  if (!query) console.warn('[query] empty')

  let magnets = []
  try {
    if (query) {
      magnets = await withRetries(() => searchViaWorker(query), { retries: 2, delayMs: 500 })
    }
  } catch (e) {
    console.warn('[worker] search error', e?.message || e)
  }

  console.log('[ext.to] magnets found:', magnets.length, 'for', query)

  if (magnets.length) return { streams: toStreams(magnets) }

  // Fallback to Torrentio
  if (CONFIG.torrentio && CONFIG.torrentio.enabled) {
    try {
      const tStreams = await fetchTorrentioFallback(type, imdb, CONFIG.torrentio.base || 'https://torrentio.strem.fun')
      if (Array.isArray(tStreams) && tStreams.length) {
        console.log('[fallback:torrentio]', tStreams.length)
        return { streams: tStreams }
      }
    } catch (e) {
      console.warn('[fallback:torrentio] error', e?.message || e)
    }
  }

  return { streams: [] }
})

// -------------------- HTTP server --------------------
const app = express()
const iface = builder.getInterface()
app.get('/manifest.json', (req,res)=>res.json(iface.manifest))
app.get('/stremio/v1', (req,res)=>res.json(iface.manifest))
app.get('/stremio/v1/manifest.json', (req,res)=>res.json(iface.manifest))
app.get('/stremio/v1/stream/:type/:id.json', async (req,res)=>{
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
app.get('/', (req,res)=>res.type('text/plain').send('Ext.to addon is running. Use /manifest.json'))

const PORT = process.env.PORT || 7000
app.listen(PORT, ()=>{
  console.log(`Stremio addon listening on http://localhost:${PORT}`)
  console.log('Manifest URL:', `http://localhost:${PORT}/manifest.json`)
})
