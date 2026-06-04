const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || 'https://primary-production-ffd3.up.railway.app/webhook/aeo-lead-ingest';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

const AUDIT_CHECKLIST = `CONTENT STRUCTURE (AI Citation Readiness)
- Direct answer in first 150-200 words?
- Headings match real questions people ask?
- Short paragraphs, bullets, simple lists present?
- Written for AI extraction or buried in marketing prose?
SOURCE QUALITY
- Original specific content vs generic copy?
- Stats, definitions, first-party insights present?
- Last updated date (article:modified_time)?
- Topical cluster vs isolated posts?
TECHNICAL: SSL, accessibility (403=critical), mobile viewport, platform/CMS, XML sitemap, page speed
SEO: Meta title (keyword+location), meta description, canonical, OG tags complete, Twitter card, blog updated 90 days
SCHEMA: LocalBusiness, Aggregate review, FAQ, Article/HowTo, Service schemas
GEO: AI page (ai.domain.com), llms.txt, NAP on-page, service area pages
AEO: FAQ content, question headings, direct early answers, AI-ready formatting
AIO: Structured content for citation, review schema for stars, FAQ schema, local intent queries
TRUST: Author bios, license, certifications, contact info, topical authority, external mentions
SOCIAL: Platforms linked and activity, missing high-value platforms
AI CITATION TRACKING: Citation mechanism, AI page/llms.txt, structured data for citation eligibility`;

async function fetchDirect(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    signal: ctrl.signal,
    redirect: 'follow'
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  const schemas = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { schemas.push(JSON.parse($(el).html())); } catch (e) {}
  });
  const schemaTypes = schemas.map(s => s['@type']).filter(Boolean).join(', ');
  $('script,style,nav,footer,header,iframe,noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 6000);
  // If cheerio extracted almost nothing, the page is likely JS-rendered — treat as failure
  if (text.length < 100) throw new Error('Insufficient content (likely JS-rendered or bot-blocked)');
  return [
    title && `TITLE: ${title}`,
    desc && `META DESC: ${desc}`,
    schemaTypes && `SCHEMAS: ${schemaTypes}`,
    `TEXT: ${text}`
  ].filter(Boolean).join('\n');
}

async function fetchViaJina(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'text/plain',
      'X-Timeout': '15'
    },
    signal: ctrl.signal
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 100) throw new Error('Jina returned insufficient content');
  return text.slice(0, 6000);
}

async function fetchPage(url) {
  try {
    return await fetchDirect(url);
  } catch (directErr) {
    try {
      const jinaContent = await fetchViaJina(url);
      return `[via Jina reader — direct fetch failed: ${directErr.message}]\n${jinaContent}`;
    } catch (jinaErr) {
      return `[Fetch failed — direct: ${directErr.message} | Jina: ${jinaErr.message}]`;
    }
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/audit', async (req, res) => {
  const { niche = 'local service business', location = 'their market', sender = 'David', urls = [] } = req.body;
  if (!urls.length) return res.status(400).json({ error: 'urls required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send({ status: 'Fetching site content...' });
  const pages = await Promise.all(urls.map(async (url) => {
    let domain;
    try { domain = new URL(url).hostname.replace('www.', ''); } catch (e) { domain = url; }
    const content = await fetchPage(url);
    return `[SITE: ${domain}]\nURL: ${url}\n${content}`;
  }));

  send({ status: 'Analyzing with Claude...' });

  const prompt = `AUDIT_TOOL_REQUEST: email_only
SENDER: ${sender}
NICHE: ${niche}
LOCATION: ${location}

Evaluate each site below and write complete, ready-to-send Email #1 and Email #2 per site. No placeholders.

AUDIT CHECKLIST (use to identify vulnerabilities):
${AUDIT_CHECKLIST}

SITES:
${pages.join('\n\n---\n\n')}

EMAIL #1:
USE THIS EXACT STRUCTURE — no deviation:

Hey,

[One natural sentence about how you found them — you were researching/browsing {niche} businesses in {location} and came across their site. Vary the phrasing naturally, keep it casual and brief. Example phrasings: "I was randomly browsing {niche} websites in {location} and came across yours." / "I was doing some research on {niche} companies in {location} and stumbled on your site." — always fill in the actual niche and location, never use placeholders]

[One genuine specific compliment on something real — skip this line entirely if nothing stands out]

However, I found three areas costing you potential customer calls and "invisible" AI rankings:

1. [First vulnerability — most impactful, plain language, no jargon]
2. [Second vulnerability]
3. [Third vulnerability]

I've already completed a full audit detailing these findings.

Reply YES and I'll send it over -- no cost and no strings attached. Take it to whoever you want for implementation.
[Sender first name]

VULNERABILITIES priority order: AI visibility > schema > content structure > trust > social > technical.
LENGTH: 100-130 words max. Subject under 10 words.

EMAIL #2:
VOICE: Reply to YES — acknowledgment not fresh pitch. Casual authority. No jargon.
STRUCTURE: Acknowledge their reply → biggest vulnerability in plain language → 30-min Google Meet CTA "no pitch".
DO NOT include: salutation, sign-off, sender name, P.S., any links, URLs, or placeholders. The template adds those automatically.
LENGTH: 100-130 words max. Body content only — no greeting, no closing.

OUTPUT each site using EXACTLY these tags, each on its own line:
---
SITE: [domain]
EMAIL_1_SUBJECT_TAG: [subject line only — no other text on this line]
EMAIL_1_BODY_TAG:
[full email body starts on next line]
EMAIL_2_SUBJECT_TAG: [subject line only — no other text on this line]
EMAIL_2_BODY_TAG:
[full email body starts on next line]
AUDIT_SCORE: [overall score 0-100 based on site quality across SEO, schema, content, trust, technical]
PRIORITY_VULNERABILITY: [one sentence — the single most impactful issue found]
COMPLIMENT: [one genuine specific compliment or NONE]
BUSINESS_NAME: [full business name]
CITY: [city]
STATE: [state abbreviation]
PHONE_FROM_SITE: [phone number or blank]
---`;

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContentStream(prompt);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) send({ text });
    }
    res.write('data: [DONE]\n\n');
  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

app.post('/api/push', async (req, res) => {
  try {
    const r = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DSK Audit Widget running on port ${PORT}`));
