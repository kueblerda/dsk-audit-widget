const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const N8N_WEBHOOK = process.env.N8N_WEBHOOK_URL || 'https://primary-production-ffd3.up.railway.app/webhook/aeo-lead-ingest';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

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

async function fetchPage(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      signal: ctrl.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);
    if (!res.ok) return `[HTTP ${res.status}]`;
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
    return [
      title && `TITLE: ${title}`,
      desc && `META DESC: ${desc}`,
      schemaTypes && `SCHEMAS: ${schemaTypes}`,
      `TEXT: ${text}`
    ].filter(Boolean).join('\n');
  } catch (e) {
    return `[Fetch error: ${e.message}]`;
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/audit', async (req, res) => {
  const { niche = 'local service business', location = 'their market', sender = 'David', urls = [] } = req.body;
  if (!urls.length) return res.status(400).json({ error: 'urls required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send({ status: 'Fetching site content...' });
  const pages = await Promise.all(urls.map(async (url) => {
    let domain;
    try { domain = new URL(url).hostname.replace('www.', ''); } catch (e) { domain = url; }
    const content = await fetchPage(url);
    return `[SITE: ${domain}]\nURL: ${url}\n${content}`;
  }));

  send({ status: 'Analyzing with Claude...' });

  const prompt = `AUDIT_TOOL_REQUEST: full
SENDER: ${sender}
NICHE: ${niche}
LOCATION: ${location}

Evaluate each site below against the AEO/AIO audit checklist. Write complete finished Email #1 and Email #2 per site. No placeholders. Ready to send.

AUDIT CHECKLIST:
${AUDIT_CHECKLIST}

SITES:
${pages.join('\n\n---\n\n')}

EMAIL #1:
VOICE: Casual authority, random discovery framing, first name sign-off only, no jargon, plain business language about lost calls and invisible rankings.
COMPLIMENT: One genuine specific positive observation if earned — skip entirely if nothing real.
VULNERABILITIES: Three findings costing most calls — AI visibility > schema > content structure > trust > social > technical.
CTA: End with exactly — "Reply YES and I'll send it over — no strings attached, take it to whoever you want."
LENGTH: 100-130 words max. Subject under 10 words.

EMAIL #2:
VOICE: Reply to YES — acknowledgment not fresh pitch. Casual authority. No jargon.
STRUCTURE: Open acknowledging reply → biggest vulnerability plain language → 30-min Google Meet CTA "no pitch" → P.S. one sentence of AI urgency. Do NOT include any links, URLs, or placeholders in the body.
LENGTH: 150-180 words max.

OUTPUT each site using EXACTLY these tags, each on its own line:
---
SITE: [domain]
EMAIL_1_SUBJECT_TAG: [subject line only — no other text on this line]
EMAIL_1_BODY_TAG:
[full email body starts on next line]
EMAIL_2_SUBJECT_TAG: [subject line only — no other text on this line]
EMAIL_2_BODY_TAG:
[full email body starts on next line]
AUDIT_SCORE: [0-100]
PRIORITY_VULNERABILITY: [one sentence]
COMPLIMENT: [one sentence or NONE]
BUSINESS_NAME: [full business name]
CITY: [city]
STATE: [state abbreviation]
PHONE_FROM_SITE: [phone or blank]
---`;

  try {
    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        send({ text: chunk.delta.text });
      }
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
