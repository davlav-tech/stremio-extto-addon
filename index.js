// --- Addon ---
const builder = new addonBuilder(manifest)

builder.defineStreamHandler(async (_args) => {
  // Normalize args shape (לפעמים מגיעים שדות מקוננים בתוך args.type)
  let args = _args
  if (args && typeof args.type === 'object' && args.type.type && !args.id) {
    args = args.type
  }

  const { type, id, extra } = args || {}
  console.log('[stream] normalized req', { type, id, extra })

  // הגנה אם אין id תקין
  if (!id || typeof id !== 'string') {
    console.warn('[parseMetaId] invalid id:', id)
    return { streams: [] }
  }

  // --- parse id ---
  const parts = id.split(':')
  const imdb = parts[0] || null
  const season = parts[1] ? parseInt(parts[1], 10) : null
  const episode = parts[2] ? parseInt(parts[2], 10) : null

  // 1) Cinemeta
  let meta = null
  try {
    const cinId = imdb + (season && episode ? `:${season}:${episode}` : '')
    const url = `https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(cinId)}.json`
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (res.ok) {
      const data = await res.json()
      meta = data && data.meta ? data.meta : null
    } else {
      console.warn('[cinemeta] status', res.status)
    }
  } catch (e) {
    console.warn('[cinemeta] error', e?.message || e)
  }

  // 2) Build search query
  const pad2 = (n) => String(n).padStart(2, '0')
  let query = ''
  if (meta) {
    const title = meta.name || meta.title || ''
    const year = meta.year || (meta.releaseInfo && parseInt(meta.releaseInfo, 10)) || ''
    query = (type === 'series' && season && episode)
      ? `${title} s${pad2(season)}e${pad2(episode)}`
      : `${title} ${year}`.trim()
  }
  if (!query) console.warn('[query] empty for', { type, id })

  // 3) Search ext.to via Worker (browse → search → details)
  let magnets = []
  try {
    const base = (CONFIG.proxyBase || 'https://ext.to').replace(/\/$/, '')
    const headers = { accept: 'text/html' }
    if (CONFIG.proxyKey) headers['X-Proxy-Key'] = CONFIG.proxyKey

    const candidates = []
    if (query) {
      candidates.push(
        `${base}/browse/?q=${encodeURIComponent(query)}`,
        `${base}/search?q=${encodeURIComponent(query)}`
      )
    }

    const getHtml = async (url) => {
      const r = await fetch(url, { headers })
      if (!r.ok) throw new Error(`proxy ${r.status} for ${url}`)
      return await r.text()
    }

    // helpers shared with details scraping
    const extractMagnetsFromHtml = (html) => {
      const $ = (await import('cheerio')).load(html)
      const arr = []
      $('a[href^="magnet:?xt="]').each((_, a) => {
        const h = $(a).attr('href')
        if (h && h.startsWith('magnet:?')) arr.push(h)
      })
      return Array.from(new Set(arr))
    }
    const enrichLabelsFromDom = (html, mags) => {
      const $ = (await import('cheerio')).load(html)
      const set = new Set(mags)
      const res = []
      $('a[href^="magnet:?xt="]').each((_, a) => {
        const h = $(a).attr('href'); if (!h || !set.has(h)) return
        const row = $(a).closest('tr, .search-result, .result, li, .row, .card, .table, .torrent')
        const text = row.text().replace(/\s+/g, ' ').trim()
        const mQual = text.match(/(2160p|4k|1080p|720p|480p)/i)
        const mSize = text.match(/(\d+(?:\.\d+)?\s?(?:GB|MB))/i)
        res.push({ magnet: h, quality: mQual?.[1]?.toUpperCase(), size: mSize?.[1]?.toUpperCase() })
      })
      const map = new Map(res.map(x => [x.magnet, x]))
      return mags.map(m => map.get(m) || { magnet: m })
    }
    const extractDetailLinksFromList = (html, baseUrl) => {
      const $ = (await import('cheerio')).load(html)
      const out = []
      $('a[href^="/torrent/"]').each((_, a) => {
        const href = $(a).attr('href')
        if (!href) return
        const abs = href.startsWith('http') ? href : `${baseUrl}${href}`
        out.push(abs)
      })
      return Array.from(new Set(out)).slice(0, 5)
    }
    const scrapeMagnetsFromDetails = async (detailUrls) => {
      const results = []
      for (const url of detailUrls) {
        try {
          const r = await fetch(url, { headers })
          if (!r.ok) continue
          const html = await r.text()
          const mags = extractMagnetsFromHtml(html)
          if (mags.length) {
            const labeled = enrichLabelsFromDom(html, mags)
            results.push(...labeled)
          }
        } catch { /* ignore */ }
      }
      const seen = new Set(), uniq = []
      for (const e of results) if (!seen.has(e.magnet)) { seen.add(e.magnet); uniq.push(e) }
      return uniq
    }

    for (const url of candidates) {
      try {
        const html = await getHtml(url)
        const mags = extractMagnetsFromHtml(html)
        if (mags.length) {
          magnets = enrichLabelsFromDom(html, mags)
          break
        }
        const details = extractDetailLinksFromList(html, base)
        if (details.length) {
          const fromDetails = await scrapeMagnetsFromDetails(details)
          if (fromDetails.length) { magnets = fromDetails; break }
        }
      } catch (e) {
        console.warn('[worker] list error', e?.message || e)
      }
    }
  } catch (e) {
    console.warn('[worker] search error', e?.message || e)
  }

  console.log('[ext.to] magnets found:', magnets.length, 'for', query)

  if (magnets.length) {
    const streams = magnets.slice(0, 20).map((e, i) => {
      const title = [e.quality, e.size].filter(Boolean).join(' • ') || `Magnet #${i+1}`
      return { title, url: e.magnet, behaviorHints: {} }
    })
    return { streams }
  }

  // 4) Fallback to Torrentio
  if (CONFIG.torrentio?.enabled) {
    try {
      const tBase = CONFIG.torrentio.base || 'https://torrentio.strem.fun'
      const url = `${tBase.replace(/\/$/,'')}/stream/${encodeURIComponent(type)}/${encodeURIComponent(imdb)}.json`
      const r = await fetch(url, { headers: { accept: 'application/json' } })
      if (r.ok) {
        const data = await r.json()
        if (data?.streams?.length) {
          console.log('[fallback:torrentio]', data.streams.length)
          return { streams: data.streams }
        }
      } else {
        console.warn('[fallback:torrentio] status', r.status)
      }
    } catch (e) {
      console.warn('[fallback:torrentio] error', e?.message || e)
    }
  }

  return { streams: [] }
})
