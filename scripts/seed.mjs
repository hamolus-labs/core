/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

// Comprehensive demo seed for Hamolus.
// Implements every feature: 15 field types, relations (belongsTo/hasMany/hasOne),
// localization, richtext + media fields, R2 media library with taxonomy & focus
// points, collapsible field groups, consoleView placement (header/side/footer),
// collection groups + icons (admin layout), dashboard stats, and KV settings.
//
// The seed is SELF-CLEANING: it deletes every existing collection (dropping the
// physical tables), removes every media asset, then rebuilds everything from
// scratch. Re-running produces byte-identical data (deterministic RNG).
//
// Usage: BASE=http://localhost:8787 ADMIN_KEY=dev-admin-key-change-me node scripts/seed.mjs
const BASE = process.env.BASE ?? 'http://localhost:8787'
const KEY = process.env.ADMIN_KEY ?? 'dev-admin-key-change-me'
const CONCURRENCY = 6

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic proxy RNG so re-seeding produces identical data. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)]

/** Run `fn` over `items` with a bounded pool of concurrent promises (passes index). */
async function runPool(items, limit, fn) {
  const queue = items.map((item, index) => ({ item, index }))
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const { item, index } = queue.shift()
      await fn(item, index)
    }
  })
  await Promise.all(workers)
}

/** Build a minimal Lexical editor state from a list of paragraphs. */
function lex(lines) {
  return {
    root: {
      children: lines.map((text) => ({
        children: [
          { detail: 0, format: 0, mode: 'normal', style: '', text, type: 'text', version: 1 },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      })),
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }
}

/** Build a Lexical editor state with headings, paragraphs, lists, and quotes. */
function lexRich(blocks) {
  const textNode = (t) => ({
    children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: t ?? '', type: 'text', version: 1 }],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  })
  const children = []
  for (const block of blocks) {
    if (block.type === 'heading') {
      children.push({
        children: [
          { detail: 0, format: 0, mode: 'normal', style: '', text: block.text, type: 'text', version: 1 },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'heading',
        version: 1,
        tag: block.tag ?? 'h2',
      })
    } else if (block.type === 'list') {
      children.push({
        children: block.items.map((item) => ({
          children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: item, type: 'text', version: 1 }],
          direction: 'ltr',
          format: '',
          indent: 0,
          type: 'listitem',
          version: 1,
          value: null,
        })),
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'list',
        version: 1,
        listType: block.listType ?? 'bullet',
        start: 1,
      })
    } else if (block.type === 'quote') {
      children.push({ children: [textNode(block.text)], direction: 'ltr', format: '', indent: 0, type: 'quote', version: 1 })
    } else {
      children.push(textNode(block.text))
    }
  }
  return { root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } }
}

/** Localize a rich-text body into {en, id} (accepts block arrays or built Lexical states). */
function localizedBody(en, id) {
  return { en: en?.root ? en : lexRich(en), id: id?.root ? id : lexRich(id) }
}

/** Build a media field snapshot value from a MediaObject. */
function mediaField(asset) {
  return asset
    ? { id: asset.id, url: asset.url, alt: asset.alt ?? null, width: asset.width, height: asset.height }
    : null
}

// ---------------------------------------------------------------------------
// PNG generation (pure Node, no deps) — gradient "art" images for the media lib
// ---------------------------------------------------------------------------

import zlib from 'node:zlib'

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

/** Render an 8-bit RGB PNG with a vertical gradient + soft diagonal highlight. */
function gradientPng({ w, h, grad }) {
  const [r1, g1, b1] = grad[0]
  const [r2, g2, b2] = grad[1]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const raw = Buffer.alloc(h * (1 + w * 3))
  let off = 0
  for (let y = 0; y < h; y++) {
    raw[off++] = 0 // filter: none
    const t = y / Math.max(1, h - 1)
    const baseR = r1 + (r2 - r1) * t
    const baseG = g1 + (g2 - g1) * t
    const baseB = b1 + (b2 - b1) * t
    for (let x = 0; x < w; x++) {
      const d = (1 - (x / w + t) / 2) * 0.22
      raw[off++] = Math.min(255, Math.round(baseR + baseR * d))
      raw[off++] = Math.min(255, Math.round(baseG + baseG * d))
      raw[off++] = Math.min(255, Math.round(baseB + baseB * d))
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

const GRADS = [
  [[37, 99, 235], [99, 102, 241]], //  blue -> indigo
  [[139, 92, 246], [236, 72, 153]], // violet -> fuchsia
  [[16, 185, 129], [52, 211, 153]], // emerald
  [[245, 158, 11], [239, 68, 68]], // amber -> red
  [[6, 182, 212], [34, 211, 238]], // cyan
  [[59, 130, 246], [56, 189, 248]], // blue -> sky
  [[168, 85, 247], [232, 121, 249]], // purple -> pink
  [[132, 204, 22], [101, 163, 13]], // lime
]

// ---------------------------------------------------------------------------
// Media asset catalog (generated + uploaded with taxonomy/focus)
// ---------------------------------------------------------------------------

const assetMeta = [
  // Heroes (posts / site) — 1200x630
  ...[
    ['aurora-dawn', 'Website Hero: Aurora', 'heroes'],
    ['crimson-ridge', 'Website Hero: Crimson Ridge', 'heroes'],
    ['emerald-valley', 'Website Hero: Emerald Valley', 'heroes'],
    ['lagoon-drift', 'Website Hero: Lagoon Drift', 'heroes'],
    ['moss-basin', 'Website Hero: Moss Basin', 'heroes'],
    ['night-orb', 'Website Hero: Night Orb', 'heroes'],
    ['sand-dune', 'Website Hero: Sand Dune', 'heroes'],
    ['skyline-melt', 'Website Hero: Skyline Melt', 'heroes'],
  ].map((n, i) => ({ key: n[0], name: n[1], w: 1200, h: 630, grad: GRADS[i % GRADS.length], group: 'Heroes', category: 'Editorial', tags: ['gradient', 'editorial', n[0]], focus: { x: 62, y: 38 }, caption: 'Editorial cover art used across posts and the home page.' })),
  // Category covers — 900x500
  ...[
    ['cover-dev', 'Category Cover: Engineering', 'category'],
    ['cover-ops', 'Category Cover: Operations', 'category'],
    ['cover-design', 'Category Cover: Design', 'category'],
    ['cover-community', 'Category Cover: Community', 'category'],
    ['cover-data', 'Category Cover: Data', 'category'],
    ['cover-security', 'Category Cover: Security', 'category'],
  ].map((n, i) => ({ key: n[0], name: n[1], w: 900, h: 500, grad: GRADS[(i + 1) % GRADS.length], group: 'Categories', category: 'Content', tags: ['cover', 'content', n[0]], focus: { x: 50, y: 32 }, caption: 'Section cover used by topic categories.' })),
  // Author avatars — 512x512
  ...[1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3].map((g, i) => ({
    key: `avatar-${i + 1}`,
    name: `Author Avatar ${i + 1}`,
    w: 512,
    h: 512,
    grad: GRADS[g % GRADS.length],
    group: 'Authors',
    category: 'Portrait',
    tags: ['avatar', 'portrait'],
    focus: { x: 50, y: 42 },
    caption: `Portrait avatar ${i + 1} for content authors.`,
  })),
  // Product images — 640x640
  ...[1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3, 4, 5, 6, 7].map((g, i) => ({
    key: `product-${i + 1}`,
    name: `Product Shot ${i + 1}`,
    w: 640,
    h: 640,
    grad: GRADS[g % GRADS.length],
    group: 'Products',
    category: 'Commercial',
    tags: ['product', 'still-life'],
    focus: { x: 50, y: 50 },
    caption: `Commercial product photo ${i + 1}.`,
  })),
  // Brand logos — 480x480
  ...[2, 3, 4, 5, 6, 7, 0, 1].map((g, i) => ({
    key: `brand-${i + 1}`,
    name: `Brand Mark ${i + 1}`,
    w: 480,
    h: 480,
    grad: GRADS[g % GRADS.length],
    group: 'Brands',
    category: 'Logo',
    tags: ['logo', 'brand'],
    focus: { x: 50, y: 50 },
    caption: `Logo mark ${i + 1}.`,
  })),
  // Event covers — 1280x720
  ...[3, 4, 5, 6, 7, 0, 1, 2].map((g, i) => ({
    key: `event-${i + 1}`,
    name: `Event Banner ${i + 1}`,
    w: 1280,
    h: 720,
    grad: GRADS[g % GRADS.length],
    group: 'Events',
    category: 'Editorial',
    tags: ['event', 'banner', i % 2 ? 'conference' : 'meetup'],
    focus: { x: 45, y: 35 },
    caption: `Wide banner for event listings.`,
  })),
  // Testimonial avatars — 400x400
  ...[5, 6, 7, 0, 1, 2, 3, 4].map((g, i) => ({
    key: `testimonial-${i + 1}`,
    name: `Customer Portrait ${i + 1}`,
    w: 400,
    h: 400,
    grad: GRADS[g % GRADS.length],
    group: 'Testimonials',
    category: 'Portrait',
    tags: ['avatar', 'quote'],
    focus: { x: 50, y: 44 },
    caption: `Customer portrait used beside a testimonial.`,
  })),
]

// ---------------------------------------------------------------------------
// Navigation group registry — nested (self-parenting) groups the console renders as a tree
// ---------------------------------------------------------------------------------------

const groupDefs = [
  { id: 'content', label: 'Content', icon: 'file' },
  { id: 'content_blog', label: 'Blog', parent: 'content' },
  { id: 'content_docs', label: 'Docs', parent: 'content' },
  { id: 'content_showcase', label: 'Showcase', parent: 'content' },
  { id: 'shop', label: 'Shop', icon: 'box' },
  { id: 'shop_catalog', label: 'Catalog', parent: 'shop' },
  { id: 'organization', label: 'Organization', icon: 'users' },
  { id: 'organization_people', label: 'People', parent: 'organization' },
  { id: 'organization_events', label: 'Events', parent: 'organization' },
  { id: 'inbox', label: 'Inbox', icon: 'mail' },
]

// Collection definitions — one per collection, showcasing the admin layout
// ---------------------------------------------------------------------------

const collections = [
  {
    name: 'categories',
    label: 'Categories',
    description: 'Topic categories — cover art, accent color, and one hero post',
    group: 'content_blog',
    icon: 'folder',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, localized: true, label: 'Name' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'description', type: 'text', localized: true, label: 'Description' },
      { name: 'color', type: 'enum', enumValues: ['emerald', 'amber', 'rose', 'sky', 'violet', 'slate'], default: 'slate', label: 'Accent Color' },
      { name: 'cover_id', type: 'media', label: 'Cover', consoleView: 'side' },
      {
        name: 'hero_post_id',
        type: 'relation',
        relation: { collection: 'posts', field: 'id', kind: 'hasOne' },
        label: 'Hero Post',
        consoleView: 'side',
      },
      { name: 'is_featured', type: 'boolean', default: false, label: 'Featured', consoleView: 'footer' },
    ],
  },
  {
    name: 'tags',
    label: 'Tags',
    description: 'Simple labels shared across posts, products, and events',
    group: 'content_blog',
    icon: 'tag',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, unique: true, label: 'Name' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
    ],
  },
  {
    name: 'authors',
    label: 'Authors',
    description: 'Content authors — bio (localized richtext), avatar, and socials',
    group: 'content_blog',
    icon: 'users',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, label: 'Name' },
      { name: 'email', type: 'email', required: true, unique: true, label: 'Email' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'avatar_id', type: 'media', label: 'Avatar', consoleView: 'side' },
      { name: 'role', type: 'enum', enumValues: ['writer', 'editor', 'reviewer', 'admin'], default: 'writer', label: 'Role', consoleView: 'side' },
      { name: 'location', type: 'string', label: 'Location' },
      { name: 'bio', type: 'richtext', localized: true, label: 'Bio' },
      { name: 'social', type: 'json', label: 'Socials' },
      { name: 'joined_at', type: 'date', label: 'Joined', consoleView: 'footer' },
      { name: 'is_active', type: 'boolean', default: true, label: 'Active', consoleView: 'footer' },
    ],
  },
  {
    name: 'posts',
    label: 'Posts',
    description: 'Blog articles — localized title/excerpt/body, relations, and a cover image',
    group: 'content_blog',
    icon: 'file',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'title', type: 'string', required: true, maxLength: 200, localized: true, label: 'Title', consoleView: 'header' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'excerpt', type: 'text', localized: true, label: 'Excerpt' },
      { name: 'body', type: 'richtext', localized: true, label: 'Body' },
      { name: 'status', type: 'enum', enumValues: ['draft', 'published', 'archived'], default: 'draft', label: 'Status', group: 'Publishing' },
      { name: 'published', type: 'boolean', default: false, label: 'Published', group: 'Publishing' },
      { name: 'featured', type: 'boolean', default: false, label: 'Featured', group: 'Publishing' },
      { name: 'view_count', type: 'number', default: 0, label: 'Views', group: 'Publishing', groupOpen: false },
      { name: 'scheduled_at', type: 'datetime', label: 'Scheduled For', group: 'Publishing' },
      { name: 'seo_title', type: 'string', maxLength: 80, label: 'SEO Title', group: 'SEO' },
      { name: 'seo_description', type: 'text', maxLength: 200, label: 'SEO Description', group: 'SEO' },
      { name: 'cover_id', type: 'media', label: 'Cover', consoleView: 'side' },
      { name: 'category_id', type: 'relation', relation: { collection: 'categories', field: 'id', onDelete: 'setNull' }, label: 'Category', consoleView: 'side' },
      { name: 'author_id', type: 'relation', relation: { collection: 'authors', field: 'id', onDelete: 'setNull' }, label: 'Author', consoleView: 'side' },
      { name: 'tag_ids', type: 'relation', relation: { collection: 'tags', field: 'id', kind: 'hasMany' }, default: [], label: 'Tags', consoleView: 'side' },
      { name: 'published_at', type: 'datetime', label: 'Published At', consoleView: 'footer' },
    ],
  },
  {
    name: 'pages',
    label: 'Pages',
    description: 'Static pages — localized rich text, SEO fields, and an optional author',
    group: 'content_docs',
    icon: 'file',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'title', type: 'string', required: true, localized: true, label: 'Title', consoleView: 'header' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'body', type: 'richtext', localized: true, label: 'Body' },
      { name: 'cover_id', type: 'media', label: 'Cover', consoleView: 'side' },
      { name: 'author_id', type: 'relation', relation: { collection: 'authors', field: 'id', onDelete: 'setNull' }, label: 'Author', consoleView: 'side' },
      { name: 'seo_title', type: 'string', maxLength: 80, label: 'SEO Title', group: 'SEO' },
      { name: 'seo_description', type: 'text', maxLength: 200, label: 'SEO Description', group: 'SEO' },
      { name: 'published', type: 'boolean', default: true, label: 'Published', consoleView: 'footer' },
    ],
  },
  {
    name: 'brands',
    label: 'Brands',
    description: 'Product brands — logo, country, and company facts',
    group: 'shop_catalog',
    icon: 'star',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, label: 'Name', consoleView: 'header' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'tagline', type: 'string', label: 'Tagline' },
      { name: 'country', type: 'string', label: 'Country' },
      { name: 'website', type: 'url', label: 'Website' },
      { name: 'founded', type: 'number', label: 'Founded', group: 'Details' },
      { name: 'employees', type: 'number', label: 'Employees', group: 'Details' },
      { name: 'logo_id', type: 'media', label: 'Logo', consoleView: 'side' },
      { name: 'description', type: 'text', label: 'Description' },
      { name: 'is_featured', type: 'boolean', default: false, label: 'Featured', consoleView: 'footer' },
    ],
  },
  {
    name: 'products',
    label: 'Products',
    description: 'Shop catalog — pricing/inventory/rating groups, brand + tag relations, gallery',
    group: 'shop_catalog',
    icon: 'box',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, maxLength: 120, label: 'Name', consoleView: 'header' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'sku', type: 'string', required: true, unique: true, label: 'SKU', group: 'Pricing' },
      { name: 'price', type: 'number', required: true, min: 0, label: 'Price', group: 'Pricing' },
      { name: 'compare_at_price', type: 'number', min: 0, label: 'Compare At', group: 'Pricing', groupOpen: false },
      { name: 'weight_g', type: 'number', min: 0, label: 'Weight (g)', group: 'Pricing' },
      { name: 'stock_quantity', type: 'number', default: 0, label: 'Stock', group: 'Inventory' },
      { name: 'low_stock_threshold', type: 'number', default: 5, label: 'Low Stock At', group: 'Inventory' },
      { name: 'in_stock', type: 'boolean', default: true, label: 'In Stock', group: 'Inventory' },
      { name: 'status', type: 'enum', enumValues: ['active', 'draft', 'archived'], default: 'active', label: 'Status', group: 'Inventory' },
      { name: 'rating', type: 'number', min: 0, max: 5, default: 0, label: 'Rating', group: 'Ratings', groupOpen: false },
      { name: 'review_count', type: 'number', default: 0, label: 'Reviews', group: 'Ratings' },
      { name: 'image_id', type: 'media', label: 'Image', group: 'Media' },
      { name: 'gallery', type: 'json', label: 'Gallery', group: 'Media', groupOpen: false },
      { name: 'description', type: 'text', label: 'Description', group: 'Media', groupOpen: false },
      { name: 'brand_id', type: 'relation', relation: { collection: 'brands', field: 'id', onDelete: 'setNull' }, label: 'Brand', consoleView: 'side' },
      { name: 'tag_ids', type: 'relation', relation: { collection: 'tags', field: 'id', kind: 'hasMany' }, default: [], label: 'Tags', consoleView: 'side' },
    ],
  },
  {
    name: 'team_members',
    label: 'Team',
    description: 'Company roster — department, role, skills (json), and remote flag',
    group: 'organization_people',
    icon: 'users',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, label: 'Name', consoleView: 'header' },
      { name: 'email', type: 'email', required: true, unique: true, label: 'Email' },
      { name: 'phone', type: 'string', label: 'Phone' },
      { name: 'department', type: 'enum', enumValues: ['engineering', 'design', 'product', 'marketing', 'support'], required: true, label: 'Department' },
      { name: 'title', type: 'string', label: 'Title' },
      { name: 'avatar_id', type: 'media', label: 'Avatar', consoleView: 'side' },
      { name: 'location', type: 'string', label: 'Location' },
      { name: 'skills', type: 'json', label: 'Skills', groupOpen: false },
      { name: 'bio', type: 'text', label: 'Bio' },
      { name: 'start_date', type: 'date', label: 'Started', consoleView: 'footer' },
      { name: 'is_remote', type: 'boolean', default: false, label: 'Remote', consoleView: 'footer' },
    ],
  },
  {
    name: 'events',
    label: 'Events',
    description: 'Meetups and conferences — date/schedule gates, venue, capacity, organizer',
    group: 'organization_events',
    icon: 'calendar',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'title', type: 'string', required: true, label: 'Title', consoleView: 'header' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'description', type: 'richtext', label: 'Description' },
      { name: 'status', type: 'enum', enumValues: ['upcoming', 'live', 'ended', 'cancelled'], default: 'upcoming', label: 'Status', group: 'Details' },
      { name: 'capacity', type: 'number', default: 0, label: 'Capacity', group: 'Details' },
      { name: 'registered_count', type: 'number', default: 0, label: 'Registered', group: 'Details' },
      { name: 'is_online', type: 'boolean', default: false, label: 'Online', group: 'Details' },
      { name: 'start_at', type: 'datetime', label: 'Starts', group: 'Schedule' },
      { name: 'end_at', type: 'datetime', label: 'Ends', group: 'Schedule', groupOpen: false },
      { name: 'venue_name', type: 'string', label: 'Venue' },
      { name: 'venue_city', type: 'string', label: 'City' },
      { name: 'cover_id', type: 'media', label: 'Cover', consoleView: 'side' },
      { name: 'organizer_id', type: 'relation', relation: { collection: 'authors', field: 'id', onDelete: 'setNull' }, label: 'Organizer', consoleView: 'side' },
      { name: 'tag_ids', type: 'relation', relation: { collection: 'tags', field: 'id', kind: 'hasMany' }, default: [], label: 'Tags', consoleView: 'side' },
    ],
  },
  {
    name: 'contacts',
    label: 'Contacts',
    description: 'Contact form submissions — status/source enums and a hidden reference code',
    group: 'inbox',
    icon: 'mail',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'name', type: 'string', required: true, label: 'Name' },
      { name: 'email', type: 'email', required: true, label: 'Email' },
      { name: 'subject', type: 'string', required: true, label: 'Subject' },
      { name: 'message', type: 'text', required: true, label: 'Message' },
      { name: 'status', type: 'enum', enumValues: ['new', 'on_going', 'done'], default: 'new', label: 'Status', consoleView: 'side' },
      { name: 'source', type: 'enum', enumValues: ['website', 'social', 'email', 'event'], default: 'website', label: 'Source', consoleView: 'side' },
      { name: 'reference_code', type: 'string', label: 'Reference Code', hidden: true },
      { name: 'submitted_at', type: 'datetime', label: 'Submitted', consoleView: 'footer' },
      { name: 'processed', type: 'boolean', default: false, label: 'Processed', consoleView: 'footer' },
    ],
  },
  {
    name: 'testimonials',
    label: 'Testimonials',
    description: 'Customer quotes — ratings, company, avatar, and publish state',
    group: 'inbox',
    icon: 'heart',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'author_name', type: 'string', required: true, label: 'Author' },
      { name: 'role', type: 'string', label: 'Role' },
      { name: 'company_name', type: 'string', label: 'Company' },
      { name: 'quote', type: 'text', required: true, label: 'Quote' },
      { name: 'rating', type: 'number', required: true, min: 1, max: 5, label: 'Rating', group: 'Details' },
      { name: 'is_featured', type: 'boolean', default: false, label: 'Featured', group: 'Details' },
      { name: 'avatar_id', type: 'media', label: 'Avatar', consoleView: 'side' },
      { name: 'published', type: 'boolean', default: true, label: 'Published', consoleView: 'footer' },
    ],
  },
  {
    name: 'projects',
    label: 'Projects',
    description: 'Nested-group example — client work under Content → Showcase (3-level tree)',
    group: 'content_showcase',
    icon: 'star',
    timestamps: true,
    primaryKey: 'id',
    fields: [
      { name: 'id', type: 'id', label: 'ID' },
      { name: 'title', type: 'string', required: true, label: 'Title', consoleView: 'header' },
      { name: 'slug', type: 'slug', required: true, unique: true, label: 'Slug' },
      { name: 'client', type: 'string', required: true, label: 'Client' },
      { name: 'summary', type: 'text', label: 'Summary' },
      { name: 'case_study', type: 'richtext', format: 'markdown', label: 'Case study (markdown)', group: 'Details' },
      { name: 'year', type: 'number', label: 'Year', group: 'Details' },
      { name: 'status', type: 'enum', enumValues: ['in_progress', 'completed', 'archived'], default: 'completed', label: 'Status', group: 'Details', control: 'radio' },
      { name: 'badges', type: 'enum', enumValues: ['featured', 'new', 'beta', 'award'], default: [], label: 'Badges', group: 'Details', control: 'multichecklist' },
      { name: 'cover_id', type: 'media', label: 'Cover', consoleView: 'side' },
      { name: 'author_id', type: 'relation', relation: { collection: 'authors', field: 'id', onDelete: 'setNull' }, label: 'Lead', consoleView: 'side', control: 'search' },
      { name: 'tag_ids', type: 'relation', relation: { collection: 'tags', field: 'id', kind: 'hasMany' }, default: [], label: 'Tags', consoleView: 'side' },
      { name: 'is_featured', type: 'boolean', default: false, label: 'Featured', consoleView: 'footer' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Record data pools
// ---------------------------------------------------------------------------

const categorySeeds = [
  { en: 'Platform Updates', id: 'Pembaruan Platform', slug: 'platform-updates', color: 'sky', featured: true },
  { en: 'Engineering', id: 'Rekayasa', slug: 'engineering', color: 'violet', featured: true },
  { en: 'Tutorials', id: 'Panduan', slug: 'tutorials', color: 'emerald', featured: true },
  { en: 'Life at Stacks', id: 'Kehidupan di Stacks', slug: 'life', color: 'amber' },
  { en: 'Deployment', id: 'Deploy', slug: 'deployment', color: 'rose' },
  { en: 'Opinion', id: 'Opini', slug: 'opinion', color: 'slate' },
  { en: 'Guides', id: 'Panduan Referensi', slug: 'guides', color: 'sky' },
  { en: 'Events', id: 'Acara', slug: 'events', color: 'amber' },
  { en: 'Research', id: 'Riset', slug: 'research', color: 'rose' },
  { en: 'Performance', id: 'Performa', slug: 'performance', color: 'violet' },
  { en: 'Security', id: 'Keamanan', slug: 'security', color: 'emerald' },
  { en: 'Community', id: 'Komunitas', slug: 'community', color: 'sky', featured: true },
]
const categoryDescs = {
  'platform-updates': ['Announcements about the Hamolus platform and its roadmap.', 'Pengumuman tentang platform Hamolus dan roadmap-nya.'],
  engineering: ['Notes from the engineering trenches — architecture, tooling, and hard-won lessons.', 'Catatan dari perang engineering — arsitektur, tooling, dan pelajaran berharga.'],
  tutorials: ['Step-by-step guides you can follow along with in your own account.', 'Panduan langkah demi langkah yang bisa kamu ikuti di akun sendiri.'],
  life: ['Random notes from the daily life of the team.', 'Catatan acak dari kehidupan sehari-hari tim.'],
  deployment: ['CI/CD, hosting, previews, and production tips.', 'CI/CD, hosting, preview, dan tips produksi.'],
  opinion: ['Long-form takes on the edge computing industry.', 'Pendapat panjang tentang industri edge computing.'],
  guides: ['Hands-on reference material for recurring workflows.', 'Materi referensi praktis untuk workflow yang berulang.'],
  events: ['Meetups, conferences, and office hours.', 'Meetup, konferensi, dan jam kantor.'],
  research: ['Experiments, benchmarks, and deep technical dives.', 'Eksperimen, benchmark, dan pembahasan teknis yang mendalam.'],
  performance: ['Speed, caching, and edge performance strategies.', 'Kecepatan, caching, dan strategi performa edge.'],
  security: ['Hardening, authentication, and safe deploys.', 'Penguatan, autentikasi, dan deploy yang aman.'],
  community: ['People, projects, and contributions from the community.', 'Orang, proyek, dan kontribusi dari komunitas.'],
}

const tagSeeds = [
  'cloudflare', 'workers', 'd1', 'hono', 'solidjs', 'astro', 'drizzle', 'typescript',
  'monorepo', 'serverless', 'sqlite', 'edge', 'performance', 'security', 'api',
  'testing', 'deployment', 'frontend', 'backend', 'ai', 'llm', 'web', 'css', 'javascript',
  'devops', 'observability', 'open-source', 'database', 'cache', 'docs', 'kv', 'storage',
]

const authorSeeds = [
  'Andi Pratama', 'Dewi Lestari', 'Rizky Hidayat', 'Maya Putri', 'Budi Santoso', 'Siti Aminah',
  'Joko Nugroho', 'Rina Wulandari', 'Ahmad Fauzi', 'Lina Marlina', 'Bayu Saputra', 'Nadia Rahma',
  'Fajar Ramadhan', 'Intan Permata', 'Agus Setiawan', 'Rani Kusuma', 'Doni Mahendra', 'Putri Ayu',
  'Eko Prasetyo', 'Tari Santoso', 'Gilang Ramadhan', 'Nia Kurnia', 'Farhan Wijaya', 'Ayu Lestari',
]
const authorRoles = ['writer', 'editor', 'reviewer', 'admin']
const authorCities = ['Jakarta', 'Yogyakarta', 'Bandung', 'Surabaya', 'Denpasar', 'Semarang', 'Malang', 'Singapore', 'Remote']
const bioEnPool = [
  'Full-stack developer passionate about edge computing and serverless architecture.',
  'Technical writer who loves explaining complex topics simply and precisely.',
  'Backend engineer focused on distributed systems and database internals.',
  'Frontend specialist exploring reactive UI frameworks and design systems.',
  'Platform engineer wrangling CI/CD, observability, and reproducible deploys.',
  'Researcher digging into AI-assisted workflows and developer productivity.',
  'Open-source maintainer who believes boring technology wins in the long run.',
  'Security-focused engineer shipping safe, zero-trust deploys.',
]
const bioIdPool = [
  'Full-stack developer yang passionate tentang edge computing dan serverless architecture.',
  'Technical writer yang suka menjelaskan topik rumit dengan sederhana dan presisi.',
  'Backend engineer yang fokus pada distributed systems dan database internals.',
  'Spesialis frontend yang mengeksplorasi framework UI reaktif dan design system.',
  'Platform engineer yang merawat CI/CD, observability, dan deploy yang reproducibly.',
  'Peneliti yang mendalami alur kerja berbasis AI dan produktivitas developer.',
  'Maintainer open-source yang percaya teknologi sederhana menang dalam jangka panjang.',
  'Engineer yang fokus keamanan dan mengirim deploy zero-trust yang aman.',
]

const brandSeeds = [
  ['Nodecraft', 'Edge infrastructure for everyone', 'Singapore', 'nodecraft.io', 2019, 214],
  ['Hyperlane', 'Fast, correct serverless devtools', 'United States', 'hyperlane.dev', 2021, 96],
  ['Pangaea OS', 'Operating system for the edge', 'Netherlands', 'pangaea-os.com', 2018, 340],
  ['Kodiak', 'Durable data tooling, shipped weekly', 'Canada', 'kodiak.sh', 2020, 74],
  ['Vantage', 'Agencies building bloated-free web apps', 'United Kingdom', 'vantage.studio', 2017, 128],
  ['Meridian Labs', 'Research-grade D1 / KV tooling', 'Germany', 'meridianlabs.eu', 2022, 41],
  ['Driftwood', 'Minimal, open source UI kits', 'Sweden', 'driftwood.design', 2016, 88],
  ['Solstice', 'Climate-aware cloud cost analysis', 'Australia', 'solstice.cloud', 2020, 63],
  ['Redpine', 'Observability for small teams', 'Switzerland', 'redpine.dev', 2019, 52],
  ['Banyan', 'Web-native content platforms', 'India', 'banyan.app', 2018, 150],
  ['Flashlight', 'Testing infrastructure on the edge', 'Brazil', 'flashlight.test', 2021, 39],
  ['Aster', 'Docs, CMS, and workflow tooling', 'Japan', 'aster.co.jp', 2015, 220],
]

const productPool = [
  ['Edge Router Pro', 129.0, 48], ['Hamolus Hoodie', 39.0, 12], ['Serverless Starter Kit', 79.0, 20],
  ['D1 Data Desk', 149.0, 30], ['KV Keyring', 12.0, 8], ['R2 Cold-Storage Bundle', 94.0, 25],
  ['Hono Hook T-Shirt', 24.0, 10], ['Astro Admin Mug', 18.0, 6], ['TypeScript Sticker Pack', 9.0, 3],
  ['Monorepo Blueprint', 59.0, 20], ['Zero-Latency Backpack', 89.0, 18], ['Edge Computing Notebook', 21.0, 7],
  ['Cloudflare Cap', 26.0, 11], ['SQLite Sticker Sheet', 8.0, 4], ['SolidJS Splash Tote', 22.0, 9],
  ['Drizzle Drafting Pad', 14.0, 5], ['Workers Weekend Sweatshirt', 54.0, 14], ['API Almanac', 44.0, 16],
  ['Cache-Busting Flask', 19.0, 8], ['Debugging Desk Lamp', 49.0, 15], ['Deploy Stamp Kit', 27.0, 10],
  ['Serverless Summit Lanyard', 11.0, 4], ['Headless CMS Field Guide', 34.0, 12], ['Edge Glow Phone Case', 29.0, 9],
  ['Query Planner Tumbler', 23.0, 7], ['Regional Replica Candle', 25.0, 6], ['Web Worker Fountain Pen', 31.0, 13],
  ['Latency Lab Coat', 64.0, 10], ['Observability Otter Plush', 32.0, 8], ['Rusty Worker Pin Set', 16.0, 5],
  ['Feature Flag Fridge Magnets', 15.0, 6], ['D1 Diorama', 58.0, 9], ['KV Keychain Bundle', 10.0, 3],
  ['Prerender Postcards', 13.0, 4], ['Waitlist Webring', 17.0, 5], ['Stack Slicer Knife Set', 42.0, 8],
]
const productTagPool = ['workers', 'd1', 'kv', 'storage', 'cache', 'edge', 'performance', 'security', 'deployment', 'testing', 'observability', 'open-source', 'devops', 'database', 'docs']

const postCurated = [
  {
    title: { en: 'Hello, Hamolus!', id: 'Halo, Hamolus!' },
    slug: 'hello-hamolus',
    excerpt: { en: 'Welcome to the Hamolus monorepo — a full-stack platform on Cloudflare.', id: 'Selamat datang di monorepo Hamolus — platform full-stack di Cloudflare.' },
    cat: 'platform-updates', tags: ['cloudflare', 'monorepo'], author: 0,
    body: (title) => lexRich([
      { type: 'heading', text: 'Welcome to Hamolus', tag: 'h1' },
      { type: 'paragraph', text: 'Hamolus is a full-stack platform built entirely on Cloudflare infrastructure: a headless CMS core API, a SolidJS admin console, and a public Astro site, wired with pnpm workspaces and Turborepo.' },
      { type: 'heading', text: 'Why Cloudflare?', tag: 'h2' },
      { type: 'paragraph', text: 'Workers run at the edge, close to your users. Combined with D1 for data and KV for settings, you get a complete backend without ever leaving the ecosystem.' },
      { type: 'list', items: ['Zero cold starts', 'Global edge deployment', 'Built-in KV and D1', 'Generous free tier'], listType: 'bullet' },
      { type: 'quote', text: 'The best way to learn is to build something real with it.' },
      { type: 'paragraph', text: 'This is the first post in our series. Stay tuned for more deep dives!' },
    ]),
  },
  {
    title: { en: 'Dynamic CRUD Without Migrations', id: 'CRUD Dinamis Tanpa Migrasi' },
    slug: 'dynamic-crud-d1',
    excerpt: { en: 'Collections defined through metadata with automatic D1 table creation.', id: 'Koleksi didefinisikan melalui metadata dengan pembuatan tabel D1 otomatis.' },
    cat: 'engineering', tags: ['d1', 'drizzle', 'serverless'], author: 2,
    body: (title) => lexRich([
      { type: 'heading', text: 'Metadata-Driven Architecture', tag: 'h1' },
      { type: 'paragraph', text: 'You do not write SQL migrations. You define collections through a JSON schema validated by Zod, and the core automatically creates and migrates D1 tables.' },
      { type: 'heading', text: 'How It Works', tag: 'h2' },
      { type: 'paragraph', text: 'On PUT, the core diffs the schema against the existing table via PRAGMA table_info, then runs ALTER TABLE ADD COLUMN for new fields.' },
      { type: 'list', items: ['PUT /api/_meta/collections/{name} creates or migrates the table', 'CRUD routes appear automatically at /api/{name}', 'All validation happens through Zod schemas'], listType: 'number' },
    ]),
  },
  {
    title: { en: 'Building the Console with SolidJS', id: 'Membangun Console dengan SolidJS' },
    slug: 'solidjs-console',
    excerpt: { en: 'Reactive UI without a virtual DOM — and StyleX theming done right.', id: 'UI reaktif tanpa virtual DOM — dan theming StyleX yang benar.' },
    cat: 'engineering', tags: ['solidjs', 'typescript', 'frontend'], author: 3,
    body: (title) => lexRich([
      { type: 'heading', text: 'Why SolidJS?', tag: 'h1' },
      { type: 'paragraph', text: 'SolidJS offers fine-grained reactivity without a virtual DOM. Components compile to direct DOM operations, making it one of the fastest UI frameworks available.' },
      { type: 'heading', text: 'StyleX Integration', tag: 'h2' },
      { type: 'paragraph', text: 'We use StyleX for type-safe atomic CSS-in-JS. The design token system supports dark/light modes and sixteen color palettes driven by CSS custom properties.' },
      { type: 'list', items: ['Atomic CSS output for a minimal bundle', 'Theme tokens via CSS custom properties', 'Cross-fade animations on theme switches', 'Responsive mobile drawer layout'], listType: 'bullet' },
    ]),
  },
  {
    title: { en: 'The 16-Palette Theme System', id: 'Sistem Tema 16 Palet' },
    slug: 'sixteen-palette-theme',
    excerpt: { en: 'How every palette repaints the whole app, in both modes.', id: 'Bagaimana setiap palet mewarnai ulang seluruh aplikasi, di kedua mode.' },
    cat: 'community', tags: ['css', 'frontend', 'open-source'], author: 5,
    body: (title) => lexRich([
      { type: 'heading', text: 'One token set, sixteen identities', tag: 'h1' },
      { type: 'paragraph', text: 'Each palette is a complete color story — surfaces, text, accent — for both dark and light modes. Text ink is computed from the accent hue with color-mix.' },
      { type: 'list', items: ['Surfaces pick up a whisper of the accent hue', 'Buttons stay in theme: accent fills and soft tints', 'Micro-animations animate every color transition'], listType: 'bullet' },
    ]),
  },
  {
    title: { en: 'Localization in a Headless CMS', id: 'Lokalisasi di Headless CMS' },
    slug: 'localization-headless-cms',
    excerpt: { en: 'Localized fields, a locale query param, and a global language switcher.', id: 'Field terlokalisasi, parameter locale, dan pengalih bahasa global.' },
    cat: 'guides', tags: ['web', 'api', 'frontend'], author: 1,
    body: (title) => lexRich([
      { type: 'heading', text: 'Localized by design', tag: 'h1' },
      { type: 'paragraph', text: 'Fields marked localized store a JSON object keyed by language code. The API resolves values on demand via the ?locale= query parameter, with a fallback to the first language.' },
      { type: 'heading', text: 'In the console', tag: 'h2' },
      { type: 'paragraph', text: 'A global language switcher in the navbar drives both the tables and every form — tabbed inputs per language, rich text included.' },
      { type: 'list', items: ['Localized strings, text, and rich text', 'Language tabs in the record form', 'En resolved values from the API', 'First-language fallback when a locale is missing'], listType: 'bullet' },
    ]),
  },
  {
    title: { en: 'Media, Taxonomy, and Focus Points', id: 'Media, Taksonomi, dan Fokus' },
    slug: 'media-taxonomy-focus',
    excerpt: { en: 'The R2 media library — groups, categories, tags, and crop-aware focus.', id: 'Pustaka media R2 — group, kategori, tag, dan fokus yang sadar-crop.' },
    cat: 'platform-updates', tags: ['storage', 'docs'], author: 0,
    body: (title) => lexRich([
      { type: 'heading', text: 'A real media library in R2', tag: 'h1' },
      { type: 'paragraph', text: 'Uploads live in an R2 bucket with a metadata row in D1. Every asset carries a group, category, tags, and a focus point expressed as a percent.' },
      { type: 'heading', text: 'Focus-aware crops', tag: 'h2' },
      { type: 'paragraph', text: 'The crop dialog remaps the focus point into the cropped frame, so thumbnails always keep the subject in view.' },
      { type: 'list', items: ['Groups, categories, and freeform tags', 'Taxonomy rename/delete across every asset', 'Client-side crop + resize with ratio presets', 'media fields embed assets directly in records'], listType: 'bullet' },
    ]),
  },
]
const postGenerated = [
  ['KV vs D1: Pick the Right Tool', 'KV vs D1: Pilih Alat yang Tepat', 'kv-vs-d1', 'research', ['d1', 'kv', 'cache'], 8],
  ['Scaling Workers with Durable Objects', 'Men-Scaling Workers dengan Durable Objects', 'durable-objects-scaling', 'engineering', ['workers', 'edge'], 2],
  ['Hono Middleware Cheat Sheet', 'Cheat Sheet Middleware Hono', 'hono-middleware-cheatsheet', 'guides', ['hono', 'typescript', 'api'], 4],
  ['Querying D1 Like a Pro', 'Query D1 Seperti Pro', 'd1-querying-pro', 'tutorials', ['d1', 'sqlite', 'drizzle'], 2],
  ['StyleX vs Vanilla-Extract in 2026', 'StyleX vs Vanilla-Extract di 2026', 'stylex-vs-vanilla-extract', 'opinion', ['css', 'frontend', 'solidjs'], 3],
  ['Atomic CSS, Minus the Pain', 'CSS Atomic, Tanpa Sakit Kepala', 'atomic-css-minus-pain', 'engineering', ['css', 'performance'], 3],
  ['Edge Caching 101', 'Dasar-Dasar Caching di Edge', 'edge-caching-101', 'performance', ['cache', 'edge', 'performance'], 7],
  ['Design Tokens Done Right', 'Design Token yang Benar', 'design-tokens-done-right', 'engineering', ['web', 'css', 'frontend'], 3],
  ['Auth Patterns for Serverless APIs', 'Pola Auth untuk API Serverless', 'auth-patterns-serverless', 'security', ['security', 'api', 'workers'], 5],
  ['Zero-Trust Deploys', 'Deploy Zero-Trust', 'zero-trust-deploys', 'security', ['security', 'deployment', 'devops'], 5],
  ['Rust on Workers: Worth It?', 'Rust di Workers: Layakkah?', 'rust-on-workers', 'research', ['workers', 'performance', 'edge'], 8],
  ['Richtext Editing on the Edge', 'Editing Rich Text di Edge', 'richtext-edge-editing', 'guides', ['web', 'frontend', 'docs'], 1],
  ['SQLite at the Edge: Use Cases', 'SQLite di Edge: Kasus Penggunaan', 'sqlite-edge-use-cases', 'research', ['d1', 'sqlite', 'edge'], 2],
  ['Building a Clean Monorepo', 'Membangun Monorepo yang Bersih', 'clean-monorepo', 'opinion', ['monorepo', 'typescript', 'devops'], 6],
  ['The Case for the Edge', 'Kasus untuk Edge', 'case-for-the-edge', 'opinion', ['edge', 'serverless', 'cloudflare'], 7],
  ['Instrumenting Workers with OpenTelemetry', 'Instrumentasi Worker dengan OpenTelemetry', 'workers-opentelemetry', 'engineering', ['observability', 'workers', 'devops'], 4],
  ['Serverless Databases Compared', 'Perbandingan Database Serverless', 'serverless-db-comparison', 'research', ['database', 'serverless', 'd1'], 2],
  ['Accessible Tables in the Console', 'Tabel yang Aksesibel di Console', 'accessible-tables', 'engineering', ['frontend', 'web', 'testing'], 3],
  ['SolidJS Signals, Explained', 'Signal SolidJS, Dijelaskan', 'solidjs-signals-explained', 'tutorials', ['solidjs', 'javascript', 'frontend'], 3],
  ['Meet the Community Roadmap', 'Temui Roadmap Komunitas', 'community-roadmap', 'community', ['community', 'web', 'open-source'], 6],
  ['Fuzzy Search Across Collections', 'Pencarian Fuzzy di Seluruh Collection', 'fuzzy-search-collections', 'engineering', ['d1', 'sqlite', 'api'], 2],
  ['Roles and Permissions 101', 'Role dan Izin 101', 'roles-permissions-101', 'security', ['security', 'api', 'auth'], 5],
  ['The Drizzle ORM Guide', 'Panduan ORM Drizzle', 'drizzle-orm-guide', 'tutorials', ['drizzle', 'd1', 'sqlite'], 2],
  ['Astro Islands in Production', 'Islands Astro di Produksi', 'astro-islands-production', 'guides', ['astro', 'frontend', 'performance'], 7],
  ['R2 Object Storage Patterns', 'Pola Object Storage R2', 'r2-object-storage', 'engineering', ['storage', 'edge'], 4],
  ['Real-Time Dashboards with Workers', 'Dashboard Real-Time dengan Worker', 'realtime-dashboards', 'engineering', ['workers', 'api', 'frontend'], 0],
  ['Testing Your D1 Schemas', 'Menguji Skema D1', 'testing-d1-schemas', 'tutorials', ['testing', 'd1', 'drizzle'], 5],
  ['GitHub Actions for Wrangler', 'GitHub Actions untuk Wrangler', 'github-actions-wrangler', 'deployment', ['deployment', 'devops', 'cloudflare'], 4],
  ['Choosing a Hosting Strategy', 'Memilih Strategi Hosting', 'hosting-strategy', 'opinion', ['deployment', 'serverless', 'web'], 7],
  ['Preview Deploys for Every PR', 'Preview Deploy untuk Setiap PR', 'preview-deploys-pr', 'deployment', ['deployment', 'devops', 'testing'], 4],
  ['Caching SQLite Reads at the Edge', 'Caching Pembacaan SQLite di Edge', 'caching-sqlite-reads', 'performance', ['cache', 'd1', 'performance'], 2],
  ['Hallucination-Proofing AI Docs', 'Mengamankan Dokumen AI dari Halusinasi', 'hallucination-proof-docs', 'ai', ['ai', 'llm', 'docs'], 1],
  ['RAG on the Edge with D1 and LLMs', 'RAG di Edge dengan D1 dan LLM', 'rag-edge-d1', 'ai', ['ai', 'llm', 'd1'], 2],
  ['Ship Trust: A Security Retrospective', 'Ship Trust: Retrospektif Keamanan', 'trust-security-postmortem', 'security', ['security', 'database', 'devops'], 5],
  ['From Idea to Production in a Weekend', 'Dari Ide ke Produksi dalam Satu Akhir Pekan', 'idea-to-production-weekend', 'tutorials', ['deployment', 'performance', 'web'], 6],
  ['The Console Cache: localStorage Hashes', 'Cache Console: Hash localStorage', 'console-cache-hashes', 'engineering', ['frontend', 'solidjs', 'cache'], 3],
  ['Bottom Sheets and Springy Micro-Animations', 'Bottom Sheet dan Micro-Animasi', 'bottom-sheets-springy-animations', 'engineering', ['css', 'frontend'], 5],
  ['Designing for an Edge CMS', 'Mendesain untuk CMS di Edge', 'designing-edge-cms', 'opinion', ['web', 'open-source', 'community'], 8],
  ['Serverless Observability for Free', 'Observability Serverless Gratis', 'serverless-observability-free', 'guides', ['observability', 'deployment', 'workers'], 4],
  ['D1 Backups and Point-in-Time Recovery', 'Backup D1 dan Pemulihan Titik-Waktu', 'd1-backups-pitr', 'engineering', ['d1', 'database', 'deployment'], 2],
  ['Serving Images with R2 and Workers', 'Menyajikan Gambar dengan R2 dan Workers', 'r2-image-serving', 'tutorials', ['storage', 'edge', 'performance'], 6],
  ['Zod Schemas as the Single Source of Truth', 'Skema Zod sebagai Sumber Kebenaran Tunggal', 'zod-single-source-truth', 'engineering', ['typescript', 'monorepo'], 0],
  ['Why Metadata Is the Schema', 'Kenapa Metadata Adalah Skema', 'metadata-is-schema', 'opinion', ['database', 'd1', 'monorepo'], 7],
  ['The HQ — A Month of Squashing Bugs', 'Kantor Pusat — Sebulan Menumpas Bug', 'a-month-of-bugs', 'life', ['open-source', 'testing', 'community'], 6],
  ['Type-Safe Relations in a Dynamic Schema', 'Relasi Type-Safe di Skema Dinamis', 'type-safe-relations', 'engineering', ['typescript', 'database', 'api'], 2],
  ['Edge AI: Small Models, Big Wins', 'AI Edge: Model Kecil, Kemenangan Besar', 'edge-ai-small-models', 'research', ['ai', 'llm', 'edge'], 8],
  ['Your First Worker on the Free Tier', 'Worker Pertamamu di Free Tier', 'first-worker-free-tier', 'tutorials', ['workers', 'serverless', 'deployment'], 4],
  ['The Road to R2 as a Database Layer', 'Jalan ke R2 sebagai Layer Database', 'r2-as-database-layer', 'research', ['storage', 'database', 'edge'], 1],
  ['Fifty Posts, Zero Migrations', 'Lima Puluh Post, Nol Migrasi', 'fifty-posts-zero-migrations', 'platform-updates', ['d1', 'monorepo', 'api'], 0],
]
const postFocus = [
  'It is the kind of topic that sounds simple until you actually ship it.',
  'We have applied these lessons across several production edge services.',
  'Here is the approach that finally worked after a few false starts.',
  'A lot of teams get this wrong; this post keeps you on the right path.',
  'By the end you will know exactly when to reach for this pattern.',
]

const pageSeeds = [
  ['About Us', 'Tentang Kami', 'about'],
  ['Documentation', 'Dokumentasi', 'docs'],
  ['Contact', 'Kontak', 'contact'],
  ['Privacy Policy', 'Kebijakan Privasi', 'privacy'],
  ['Terms of Service', 'Ketentuan Layanan', 'terms'],
  ['Careers', 'Karier', 'careers'],
  ['Frequently Asked Questions', 'Pertanyaan yang Sering Diajukan', 'faq'],
  ['Changelog', 'Log Perubahan', 'changelog'],
  ['Open Source', 'Open Source', 'open-source'],
  ['Press Kit', 'Kit Pers', 'press'],
  ['Pricing', 'Harga', 'pricing'],
  ['Getting Started', 'Memulai', 'getting-started'],
  ['Security Overview', 'Ikhtisar Keamanan', 'security'],
  ['Community', 'Komunitas', 'community'],
  ['Status', 'Status', 'status'],
]

const teamSeeds = [
  ['Aditya Wicaksono', 'engineering', 'Staff Engineer', 'Jakarta', ['TypeScript', 'D1', 'Rust'], true],
  ['Salsabila Zahra', 'design', 'Product Designer', 'Bandung', ['Figma', 'StyleX', 'Astro'], true],
  ['Bagas Prakoso', 'engineering', 'Senior Engineer', 'Yogyakarta', ['Hono', 'Workers', 'Drizzle'], false],
  ['Kezia Aulya', 'product', 'Product Manager', 'Jakarta', ['Roadmapping', 'Analytics'], false],
  ['Rendra Kurnia', 'engineering', 'Engineer', 'Semarang', ['Go', 'D1', 'KV'], true],
  ['Nabila Fitri', 'marketing', 'Growth Lead', 'Jakarta', ['SEO', 'Analytics', 'Copy'], true],
  ['Yoga Prasetio', 'engineering', 'Staff Engineer', 'Surabaya', ['TypeScript', 'Observability', 'CI/CD'], true],
  ['Alya Puspita', 'design', 'Design Engineer', 'Malang', ['StyleX', 'SolidJS', 'Figma'], false],
  ['Fachri Hidayat', 'engineering', 'Engineer', 'Bali', ['Workers', 'R2', 'Testing'], true],
  ['Tara Anggraini', 'support', 'Support Lead', 'Jakarta', ['Docs', 'Automation'], false],
  ['Dimas Kuncoro', 'engineering', 'Engineer', 'Jakarta', ['TypeScript', 'AI', 'D1'], true],
  ['Mira Andini', 'product', 'Associate PM', 'Bandung', ['Research', 'Analytics'], true],
  ['Reza Permana', 'engineering', 'Senior Engineer', 'Palembang', ['Security', 'Auth', 'Workers'], true],
  ['Anisa Rahma', 'marketing', 'Content Lead', 'Yogyakarta', ['Writing', 'SEO', 'Media'], false],
  ['Galih Satria', 'engineering', 'Engineer', 'Solo', ['Drizzle', 'SQLite', 'D1'], true],
  ['Putri Melati', 'design', 'Designer', 'Jakarta', ['Illustration', 'Branding'], false],
  ['Hadi Nugroho', 'engineering', 'Engineer', 'Medan', ['Hono', 'Zod', 'OpenAPI'], true],
  ['Sekar Ayu', 'product', 'Product Designer', 'Malang', ['Research', 'Prototyping'], true],
  ['Arif Setiawan', 'engineering', 'Engineering Lead', 'Bekasi', ['Workers', 'Go', 'Platform'], false],
  ['Laras Wati', 'marketing', 'Community Manager', 'Jakarta', ['Events', 'Social', 'Newsletter'], true],
]

const eventSeeds = [
  ['Hamolus Monthly Meetup', 'hamolus-meetup-01', 'Jakarta', 'The Podium', 120, 86],
  ['Edge Computing Jakarta Talks', 'edge-talks-jkt-02', 'Jakarta', 'GoWork FX Sudirman', 90, 61],
  ['D1 Day — Bandung', 'd1-day-bdg', 'Bandung', 'STEI ITB', 80, 54],
  ['Serverless Saturdays', 'serverless-saturdays-03', 'Online', 'Discord', 400, 288],
  ['Workers Hack Night', 'workers-hack-night', 'Yogyakarta', 'Kick Andy UGM', 60, 47],
  ['Surabaya Dev Summit 2026', 'surabaya-dev-summit', 'Surabaya', 'Graha Pena', 250, 176],
  ['Builders Breakfast — Bali', 'builders-breakfast-bali', 'Denpasar', 'Hubud', 45, 32],
  ['Open Source Office Hours', 'oss-office-hours-07', 'Online', 'Zoom', 100, 55],
  ['Kubernetes After Dark', 'k8s-after-dark', 'Jakarta', 'PHI Fenix', 110, 44],
  ['Edge AI Workshop', 'edge-ai-workshop', 'Bandung', 'Telkom UPI', 70, 69],
  ['Cloudflare Meetup Medan', 'cloudflare-meetup-medan', 'Medan', 'Grand Aston', 80, 38],
  ['Design Systems Jam', 'design-systems-jam', 'Jakarta', 'Blok M Plaza', 60, 24],
  ['Localization Sprint', 'localization-sprint', 'Online', 'Discord', 50, 19],
  ['R2 Deep Dive', 'r2-deep-dive', 'Yogyakarta', 'Gedung Sate Hub', 55, 41],
  ['Platform Updates Town Hall', 'town-hall-september', 'Online', 'Streamyard', 200, 132],
  ['Year-End Community Meetup', 'year-end-community-2026', 'Jakarta', 'i-Cube FX', 150, 97],
]
const eventBodies = [
  'A regular gathering of the Hamolus community: short talks, show-and-tell, and dinner afterwards.',
  'An evening of lightning talks about edge compute, D1, KV, R2 and everything in between.',
  'Hands-on session where we build and deploy a full edge application together.',
]

const contactFirst = [
  'Budi Santoso', 'Siti Aminah', 'Joko Nugroho', 'Maya Putri', 'Ahmad Fauzi', 'Rina Wulandari',
  'Agus Prasetyo', 'Dewi Anggraini', 'Fajar Setiawan', 'Intan Puspita', 'Gilang Ramadhan', 'Nadia Safitri',
  'Eko Wijaya', 'Sari Indah', 'Dimas Aditya', 'Lina Kurniawan', 'Bayu Permana', 'Putri Maharani',
  'Yudha Surya', 'Mega Rahayu', 'Tari Ayuningtyas', 'Rizky Ananda', 'Nia Permatasari', 'Farhan Hakim',
  'Citra Laksmi', 'Arif Nugraha', 'Rani Hartati', 'Doni Saputra', 'Ayu Wulandari', 'Riki Firmansyah',
  'Wulan Puspitasari', 'Indra Gunawan', 'Salsa Bila', 'Teguh Santoso', 'Melati Kusuma', 'Rangga Aditya',
  'Vina Oktavia', 'Hendra Wijaya', 'Zahra Amelia', 'Bagas Wicaksono',
]
const contactSubjects = [
  'Documentation request', 'Sandbox deploy', 'Localization question', 'Bug report: table view',
  'Integration question', 'Feedback on the console', 'Pricing inquiry', 'Partnership idea',
  'Feature request: batches', 'API usage help', 'Security review request', 'Just saying hi',
  'Migration from another CMS', 'Accessibility feedback', 'Speaking opportunity', 'Media upload question',
]
const contactMessages = [
  'I would love to evaluate Hamolus for our team. Could you point me to the full docs?',
  'Do you support sandbox deploys for an internal demo? We are comparing edge platforms.',
  'Is it possible to support more than two languages? We need five for a client project.',
  'The table view is great, but I noticed focus can be lost after a search. Happy to help debug.',
  'Can this sit in front of an existing D1 database we already have data in?',
  'The console feels snappy. What query-cache strategy is it using under the hood?',
  'Our traffic is spiky — what does the free tier look like for Workers + D1?',
  'We run a devtools newsletter and would love to feature a breakdown of this stack.',
  'Batch create would save us a lot of clicks. Is that on the roadmap?',
  'How do I store file uploads — should I wire in R2 myself?',
  'Could you walk through the auth flow before we commit? We handle sensitive data.',
  'No question, just wanted to say the localization feature is really well done!',
  'We are migrating from a legacy CMS. Are exports/imports supported yet?',
  'The contrast on the sidebar feels a bit low — do you track accessibility issues here?',
  'We host a monthly meetup and would love to see a talk on edge CMS hosting.',
  'The media library with focus points is exactly what our marketing site needs.',
]

const testimonialSeeds = [
  ['Alicia Grant', 'CTO', 'Northwind Logistics', 5], ['Marcus Chen', 'VP Engineering', 'Helios Robotics', 5],
  ['Priya Natarajan', 'Head of Platform', 'Cobalt Analytics', 5], ['Lukas Meyer', 'Founder', 'Botbyte', 4],
  ['Sofia Romano', 'Engineering Lead', 'Solerra Energy', 5], ['Daniel Okafor', 'Product Manager', 'Kitewave', 4],
  ['Emily Carter', 'Director of Web', 'Maple Leaf Media', 5], ['Hiroshi Tanaka', 'Platform Engineer', 'Zenith Motors', 4],
  ['Fatima Al-Rashid', 'DevOps Lead', 'Almas Finance', 5], ['Owen Bradley', 'Software Architect', 'Coastal Cloud', 5],
  ['Chloe Nguyen', 'Frontend Lead', 'Petal Commerce', 5], ['Ravi Patel', 'Data Engineer', 'Stratos Health', 4],
  ['Ingrid Johansson', 'CTO', 'Norden SaaS', 5], ['Mateo Silva', 'Founder', 'Atrium Labs', 5],
  ['Amara Diallo', 'VP Product', 'Juba Studio', 4], ['Felix Wagner', 'SRE', 'Titan Grid', 5],
  ['Hannah Cohen', 'Marketing Ops', 'Brightside', 4], ['Andre Rousseau', 'Backend Lead', 'Boreal Systems', 5],
  ['Yuki Nakamura', 'Software Engineer', 'Kaede Works', 5], ['Leila Haddad', 'Head of Content', 'Miraj Media', 4],
  ['Tomasz Kowalski', 'Cloud Architect', 'Volta Energy', 5], ['Grace Adeyemi', 'Engineering Manager', 'Accra Health', 5],
  ['Julian Stone', 'Founder', 'Harbor CRM', 4], ['Mina Park', 'Full-Stack Engineer', 'Seoul Code', 5],
]
const testimonialQuotes = [
  'We replaced three internal services with one Hamolus deployment. The metadata-driven schema alone saved us months.',
  'The relations are the cleanest I have worked with — wiring authors, categories, and tags just makes sense.',
  'Localization out of the box meant our Indonesian and English sites ship from a single source of truth.',
  'The media library with focus points is a work of art. Our editorial team trims images without ever opening Photoshop.',
  'Type-checked schemas from a shared package. This is how a CMS backend should feel in 2026.',
  'We moved our entire docs pipeline in a weekend. Zero migrations, zero drama.',
  'The admin console is the first one our non-technical editors actually enjoy using.',
  'R2 storage plus automatic dimension extraction — image handling is genuinely effortless.',
  'Bottom sheets and springy animations make the admin feel like a polished product, not a tool.',
  'Theming with sixteen palettes means each client gets their brand colors without a single code change.',
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const login = await fetch(`${BASE}/api/_auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: KEY }),
  })
  if (!login.ok) throw new Error(`Login failed (${login.status}) — is core running at ${BASE}?`)
  const {
    data: { token },
  } = await login.json()
  const A = { authorization: `Bearer ${token}` }
  const J = { 'content-type': 'application/json', ...A }

  async function api(path, init = {}) {
    const res = await fetch(`${BASE}${path}`, init)
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
    return res.status === 204 ? null : res.json()
  }

  // --- Reset: drop every collection + every media asset (self-cleaning seed) ---
  console.log('== reset ====================================================================')
  const existing = (await api('/api/_meta/collections', { headers: A })).data ?? []
  if (existing.length) {
    console.log(`dropping ${existing.length} collection(s) ...`)
    await runPool(existing.map((c) => c.name), CONCURRENCY, (name) =>
      api(`/api/_meta/collections/${name}`, { method: 'DELETE', headers: A }),
    )
  } else {
    console.log('no collections to drop')
  }
  let mediaRows = []
  for (let page = 1; ; page++) {
    const res = await api(`/api/_media?pageSize=100&page=${page}`, { headers: A })
    mediaRows.push(...(res.data ?? []))
    if (mediaRows.length >= (res.meta?.total ?? 0)) break
  }
  if (mediaRows.length) {
    console.log(`deleting ${mediaRows.length} media asset(s) ...`)
    await runPool(mediaRows.map((m) => m.id), CONCURRENCY, (id) =>
      api(`/api/_media/${id}`, { method: 'DELETE', headers: A }),
    )
  } else {
    console.log('no media to delete')
  }

  // Drop navigation groups (leaves first — parents are rejected while children exist).
  const existingGroups = (await api('/api/_meta/groups', { headers: A })).data ?? []
  if (existingGroups.length) {
    console.log(`dropping ${existingGroups.length} group(s) ...`)
    let remaining = new Set(existingGroups.map((g) => g.id))
    let round = 0
    while (remaining.size && round++ < 20) {
      const cur = (await api('/api/_meta/groups', { headers: A })).data ?? []
      const parentIds = new Set(
        cur.filter((g) => remaining.has(g.id)).map((g) => g.parent).filter(Boolean),
      )
      const deletable = cur.filter((g) => remaining.has(g.id) && !parentIds.has(g.id)).map((g) => g.id)
      if (!deletable.length) break
      await runPool(deletable, CONCURRENCY, (id) =>
        api(`/api/_meta/groups/${id}`, { method: 'DELETE', headers: A }),
      )
      deletable.forEach((id) => remaining.delete(id))
    }
  } else {
    console.log('no groups to drop')
  }

  // --- Media library: generate + upload every asset with taxonomy + focus ----
  console.log('== media ====================================================================')
  const mediaByKey = new Map()
  let assetIdx = 0
  await runPool(assetMeta, CONCURRENCY, async (meta) => {
    const name = meta.name.includes('.') ? meta.name : `${meta.name}.png`
    const bytes = gradientPng({ w: meta.w, h: meta.h, grad: meta.grad })
    const fd = new FormData()
    fd.append('file', new File([bytes], `${meta.key}.png`, { type: 'image/png' }))
    fd.append('name', `${meta.name}.png`)
    if (meta.group) fd.append('group', meta.group)
    if (meta.category) fd.append('category', meta.category)
    if (meta.tags?.length) fd.append('tags', JSON.stringify(meta.tags))
    if (meta.focus) {
      fd.append('focusX', String(meta.focus.x))
      fd.append('focusY', String(meta.focus.y))
    }
    fd.append('alt', `AI-generated ${meta.group?.toLowerCase()} artwork${meta.caption ? ` — ${meta.caption}` : ''}`)
    fd.append('description', meta.caption ?? '')
    const res = await fetch(`${BASE}/api/_media`, { method: 'POST', headers: A, body: fd })
    if (!res.ok) throw new Error(`upload ${meta.key} → ${res.status} ${await res.text()}`)
    const { data: asset } = await res.json()
    mediaByKey.set(meta.key, asset)
    assetIdx++
    process.stdout.write(`\r  uploaded ${assetIdx}/${assetMeta.length}`)
  })
  console.log('')
  const heroAssets = assetMeta.filter((m) => m.group === 'Heroes').map((m) => mediaByKey.get(m.key))
  const categoryCovers = assetMeta.filter((m) => m.group === 'Categories').map((m) => mediaByKey.get(m.key))
  const authorAvatars = assetMeta.filter((m) => m.group === 'Authors').map((m) => mediaByKey.get(m.key))
  const productImages = assetMeta.filter((m) => m.group === 'Products').map((m) => mediaByKey.get(m.key))
  const brandLogos = assetMeta.filter((m) => m.group === 'Brands').map((m) => mediaByKey.get(m.key))
  const eventCovers = assetMeta.filter((m) => m.group === 'Events').map((m) => mediaByKey.get(m.key))
  const testimonialAvatars = assetMeta.filter((m) => m.group === 'Testimonials').map((m) => mediaByKey.get(m.key))
  console.log(`done: ${mediaByKey.size} media assets (Heroes, Categories, Authors, Products, Brands, Events, Testimonials)`)

  // --- Groups (nested registry; parents first so children resolve) ---------------
  console.log('== groups ===================================================================')
  const parentSeen = new Set()
  let groupsOk = 0
  while (groupsOk < groupDefs.length) {
    let progressed = false
    for (const g of groupDefs) {
      if (parentSeen.has(g.id)) continue
      if (g.parent && !parentSeen.has(g.parent)) continue
      await api(`/api/_meta/groups/${g.id}`, { method: 'PUT', headers: J, body: JSON.stringify(g) })
      parentSeen.add(g.id)
      groupsOk++
      progressed = true
      console.log(`  ok: "${g.id}"${g.parent ? ` (child of ${g.parent})` : ''}`)
    }
    if (!progressed) {
      const unresolved = groupDefs.filter((g) => !parentSeen.has(g.id)).map((g) => g.id)
      throw new Error(`group parents unresolved: ${unresolved.join(', ')}`)
    }
  }
  console.log(`done: ${groupsOk}/${groupDefs.length} groups`)

  // --- Collections ----------------------------------------------------------------
  console.log('== collections ===========================================================')
  let colOk = 0
  for (const def of collections) {
    await api(`/api/_meta/collections/${def.name}`, { method: 'PUT', headers: J, body: JSON.stringify(def) })
    colOk++
    console.log(`  ok: "${def.name}" (${def.fields.length} fields, group=${def.group ?? '-'}, icon=${def.icon})`)
  }
  console.log(`done: ${colOk}/${collections.length} collections`)

  // --- Settings (KV) ---------------------------------------------------------------
  console.log('== settings ===============================================================')
  const settings = {
    localization: { languages: ['en', 'id'] },
    site: {
      name: 'Hamolus',
      tagline: 'A headless CMS on Cloudflare — collections, records, media, and settings with zero migrations.',
      navigation: [
        { label: 'Home', href: '/' },
        { label: 'Posts', href: '/posts' },
        { label: 'Products', href: '/products' },
        { label: 'Events', href: '/events' },
        { label: 'Pages', href: '/pages' },
      ],
    },
  }
  await api('/api/_meta/settings', { method: 'PUT', headers: J, body: JSON.stringify(settings) })
  console.log('  ok: site + localization settings (KV)')

  // --- Seed helper (track counts, tolerate per-row failures w/ warnings) -----------
  const counts = {}
  async function seed(collection, rows, postBody) {
    let ok = 0
    await runPool(rows, CONCURRENCY, async (row, i) => {
      const body = postBody ? postBody(row, i) : row
      const res = await fetch(`${BASE}/api/${collection}`, { method: 'POST', headers: J, body: JSON.stringify(body) })
      if (res.ok) ok++
      else console.warn(`    !! ${collection} row failed: ${res.status} ${await res.text()}`)
    })
    counts[collection] = ok
    console.log(`done: ${ok}/${rows.length} records "${collection}"`)
  }

  // --- Categories -----------------------------------------------------------------
  console.log('== records ===============================================================')
  await seed('categories', categorySeeds, (row, i) => ({
    name: { en: row.en, id: row.id },
    slug: row.slug,
    description: categoryDescs[row.slug]
      ? { en: categoryDescs[row.slug][0], id: categoryDescs[row.slug][1] }
      : null,
    color: row.color,
    cover_id: mediaField(categoryCovers[i % categoryCovers.length]),
    is_featured: row.featured,
  }))

  // --- Tags -----------------------------------------------------------------------
  await seed('tags', tagSeeds, (name) => ({ name, slug: name }))

  // --- Authors --------------------------------------------------------------------
  await seed('authors', authorSeeds, (name, i) => {
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    const rand = rng(100 + i)
    return {
      name,
      email: `${slug}@workerstacks.dev`,
      slug,
      avatar_id: mediaField(authorAvatars[i % authorAvatars.length]),
      role: authorRoles[i % authorRoles.length],
      location: pick(authorCities, rand),
      bio: {
        en: lexRich([{ type: 'paragraph', text: bioEnPool[i % bioEnPool.length] }]),
        id: lexRich([{ type: 'paragraph', text: bioIdPool[i % bioIdPool.length] }]),
      },
      social: { twitter: `@${slug}`, github: slug, website: `https://${slug}.dev` },
      joined_at: `${2019 + (i % 7)}-0${1 + (i % 9)}-15`,
      is_active: rand() > 0.08,
    }
  })

  // --- Posts (relations wired by slug) ---------------------------------------------
  const tagIdByName = new Map()
  const tagList = await api('/api/tags?pageSize=100', { headers: A })
  for (const t of tagList.data) tagIdByName.set(t.name, t.id)
  const categoryIdBySlug = new Map()
  const catList = await api('/api/categories?pageSize=100', { headers: A })
  for (const c of catList.data) categoryIdBySlug.set(c.slug, c.id)
  const authorIdList = await api('/api/authors?pageSize=100', { headers: A })
  const authorIds = authorIdList.data.map((a) => a.id)

  const builtPosts = []
  for (const [i, curated] of postCurated.entries()) {
    const rand = rng(2000 + i)
    builtPosts.push({
      title: curated.title,
      slug: curated.slug,
      excerpt: curated.excerpt,
      body: localizedBody(curated.body(curated.title.en), curated.body(curated.title.id)),
      status: 'published',
      published: true,
      featured: true,
      view_count: 100 + Math.floor(rand() * 1200),
      published_at: `2026-08-${String(1 + i).padStart(2, '0')}T09:00:00.000Z`,
      seo_title: `${curated.title.en} | Hamolus`,
      seo_description: curated.excerpt.en,
      cover_id: mediaField(heroAssets[i % heroAssets.length]),
      category_id: categoryIdBySlug.get(curated.cat) ?? null,
      author_id: authorIds[curated.author] ?? null,
      tag_ids: curated.tags.map((t) => tagIdByName.get(t)).filter(Boolean),
    })
  }
  for (const [i, t] of postGenerated.entries()) {
    const rand = rng(3000 + i)
    const focus = pick(postFocus, rand)
    const status = rand() > 0.18 ? 'published' : rand() > 0.55 ? 'draft' : 'archived'
    builtPosts.push({
      title: { en: t[0], id: t[1] },
      slug: t[2],
      excerpt: {
        en: `${t[0]} — practical notes from the Hamolus team.`,
        id: `${t[1]} — catatan praktis dari tim Hamolus.`,
      },
      body: localizedBody(
        [{ type: 'heading', text: t[0], tag: 'h1' }, { type: 'paragraph', text: `${focus} This post dives into the practical details and shows how the pattern fits a modern edge-first stack.` }, { type: 'paragraph', text: 'We walk through a real example, cover the common pitfalls, and finish with reproducible steps.' }, { type: 'heading', text: 'What You Will Learn', tag: 'h2' }, { type: 'list', items: ['The core concepts behind the approach', 'A step-by-step walkthrough', 'How to wire it into D1, KV, and Workers', 'Practical tips to avoid common mistakes'], listType: 'bullet' }, { type: 'quote', text: 'Clean architecture ships faster than clever hacks.' }],
        [{ type: 'heading', text: t[1], tag: 'h1' }, { type: 'paragraph', text: `${focus} Post ini membahas detail praktis dan bagaimana pola ini cocok dengan stack modern yang mengutamakan edge.` }, { type: 'paragraph', text: 'Kita telusuri contoh nyata, bahas jebakan umum, dan akhiri dengan langkah yang bisa direproduksi.' }, { type: 'heading', text: 'Yang Akan Kamu Pelajari', tag: 'h2' }, { type: 'list', items: ['Konsep inti di balik pendekatan ini', 'Panduan langkah demi langkah', 'Cara menyambungkannya ke D1, KV, dan Workers', 'Tips praktis untuk menghindari kesalahan umum'], listType: 'bullet' }, { type: 'quote', text: 'Arsitektur yang bersih diluncurkan lebih cepat daripada hack yang cerdik.' }],
      ),
      status,
      published: status === 'published',
      featured: rand() > 0.86,
      view_count: status === 'published' ? Math.floor(rand() * 4000) : 0,
      published_at: status === 'published' ? new Date(Date.UTC(2026, 5 + Math.floor(rand() * 4), 1 + Math.floor(rand() * 27), 8 + Math.floor(rand() * 10), 0)).toISOString() : null,
      scheduled_at: status === 'draft' ? new Date(Date.UTC(2026, 9 + Math.floor(rand() * 2), 1 + Math.floor(rand() * 20), 9, 0)).toISOString() : null,
      seo_title: `${t[0]} | Hamolus`,
      seo_description: `${t[0]} — practical notes from the Hamolus team.`,
      cover_id: mediaField(heroAssets[i % heroAssets.length]),
      category_id: categoryIdBySlug.get(t[3]) ?? null,
      author_id: authorIds[(t[5] + authorIds.length) % authorIds.length] ?? null,
      tag_ids: t[4].map((tg) => tagIdByName.get(tg)).filter(Boolean),
    })
  }
  await seed('posts', builtPosts, (row) => row)

  // --- Projects (nested-group example: Content → Showcase) -----------------------
  const projectSeeds = [
    ['Brand Refresh', 'rebrand', 'Northwind Retail', 2025, 'completed', true],
    ['Edge Checkout', 'edge-checkout', 'Fathom Commerce', 2025, 'completed', true],
    ['CMS Migration', 'cms-migration', 'Brightline Media', 2025, 'in_progress', true],
    ['Analytics Dashboard', 'analytics-dashboard', 'Datahouse', 2026, 'in_progress', true],
    ['Docs Platform', 'docs-platform', 'Lumen Labs', 2025, 'completed', false],
    ['Mobile App Shell', 'mobile-app-shell', 'Waveform', 2026, 'in_progress', false],
    ['Design System', 'design-system', 'Northwind Retail', 2024, 'archived', false],
    ['Community Forum', 'community-forum', 'Bridge & Co', 2025, 'completed', false],
    ['Realtime Feeds', 'realtime-feeds', 'Fathom Commerce', 2026, 'in_progress', true],
    ['Zero-KB Search', 'zero-kb-search', 'Kumo Al', 2025, 'completed', false],
  ]
  await seed('projects', projectSeeds, (p, i) => {
    const rand = rng(9500 + i)
    const tags = []
    for (const tag of ['cloudflare', 'workers', 'd1', 'edge', 'performance', 'design', 'frontend', 'open-source'])
      if (rand() > 0.6) tags.push(tagIdByName.get(tag))
    if (tags.length < 1) tags.push('cloudflare')
    const badges = []
    if (p[5]) badges.push('featured')
    for (const b of ['new', 'beta', 'award']) if (rand() > 0.7) badges.push(b)
    return {
      title: p[0],
      slug: p[1],
      client: p[2],
      summary: `${p[0]} — a showcase project delivered for ${p[2]}, demonstrating the nested “Content → Showcase” group in the console.`,
      case_study: `# ${p[0]} — case study\n\nShipped for **${p[2]}** in ${p[3]} as part of the *Showcase* collection.\n\n- **Status:** ${p[4].replace(/_/g, ' ')}\n- **Featured:** ${p[5] ? 'yes' : 'no'}\n- **Tags:** ${tags.filter(Boolean).length} linked\n\n> Markdown is stored as a plain string and rendered in the console preview and on the public site.\n\nSee it live: [Hamolus](https://hamolus.dev).`,
      year: p[3],
      status: p[4],
      badges,
      cover_id: mediaField(heroAssets[(i + 2) % heroAssets.length]),
      author_id: authorIds[(i + 3) % authorIds.length] ?? null,
      tag_ids: tags.filter(Boolean),
      is_featured: p[5],
    }
  })

  // Wire the categories -> hero post (hasOne) relation after posts exist.
  const postList = await api('/api/posts?pageSize=100', { headers: A })
  const heroPostByCategory = new Map()
  for (const p of postList.data) {
    const catId = p.category_id
    if (catId && !heroPostByCategory.has(catId) && p.published) heroPostByCategory.set(catId, p.id)
  }
  const catWithHeroIds = new Map()
  for (const c of catList.data) if (heroPostByCategory.has(c.id)) catWithHeroIds.set(c.id, heroPostByCategory.get(c.id))
  for (const [catId, postId] of catWithHeroIds) {
    const res = await fetch(`${BASE}/api/categories/${catId}`, { method: 'PATCH', headers: J, body: JSON.stringify({ hero_post_id: postId }) })
    if (!res.ok) console.warn(`    !! categories hero_post_id patch failed: ${res.status}`)
  }
  console.log(`  wired hero_post_id (hasOne) on ${catWithHeroIds.size} categories`)

  // --- Pages ----------------------------------------------------------------------
  await seed('pages', pageSeeds, (row, i) => {
    const [en, id, slug] = row
    const rand = rng(4000 + i)
    return {
      title: { en, id },
      slug,
      body: localizedBody(
        [{ type: 'heading', text: en, tag: 'h1' }, { type: 'paragraph', text: `Welcome to the ${en} page of Hamolus — a headless CMS built entirely on Cloudflare Workers, D1, and KV.` }, { type: 'paragraph', text: 'Everything here renders from the same API that powers the admin console, so content and presentation stay in sync.' }, { type: 'heading', text: 'Get Started', tag: 'h2' }, { type: 'list', items: ['Explore the collection reference in the console', 'Open the API docs for every CRUD endpoint', 'Customize settings in the admin panel'], listType: 'bullet' }],
        [{ type: 'heading', text: id, tag: 'h1' }, { type: 'paragraph', text: `Selamat datang di halaman ${id} dari Hamolus — headless CMS yang dibangun di atas Cloudflare Workers, D1, dan KV.` }, { type: 'paragraph', text: 'Semua di sini dirender dari API yang sama dengan admin console, sehingga konten dan tampilan selalu sinkron.' }, { type: 'heading', text: 'Mulai', tag: 'h2' }, { type: 'list', items: ['Jelajahi referensi collection di console', 'Buka dokumentasi API untuk setiap endpoint CRUD', 'Sesuaikan pengaturan di panel admin'], listType: 'bullet' }],
      ),
      cover_id: mediaField(heroAssets[i % heroAssets.length]),
      author_id: authorIds[(i + 1) % authorIds.length] ?? null,
      seo_title: `${en} | Hamolus`,
      seo_description: `The ${en} page — rendered from the headless API.`,
      published: rand() > 0.05,
    }
  })

  // --- Brands ---------------------------------------------------------------------
  await seed('brands', brandSeeds, (b, i) => ({
    name: b[0],
    slug: b[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    tagline: b[1],
    country: b[2],
    website: `https://${b[3]}`,
    founded: b[4],
    employees: b[5],
    logo_id: mediaField(brandLogos[i % brandLogos.length]),
    description: `${b[0]} builds ${b[1].toLowerCase()}. Founded in ${b[4]} with a team of ${b[5]} across ${b[2]}.`,
    is_featured: i % 3 === 0,
  }))

  // --- Products -------------------------------------------------------------------
  const brandIdList = await api('/api/brands?pageSize=100', { headers: A })
  const brandIds = brandIdList.data.map((b) => b.id)
  await seed('products', productPool, (p, i) => {
    const rand = rng(5000 + i)
    const stock = rand() > 0.12 ? Math.floor(rand() * 400) : 0
    const tags = []
    for (const tag of productTagPool) if (rand() > 0.78) tags.push(tagIdByName.get(tag))
    if (tags.length < 1) tags.push('workers')
    const gallery = [productImages[i % productImages.length], productImages[(i + 1) % productImages.length]]
    return {
      name: p[0],
      slug: p[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      sku: `WS-${String(i + 1).padStart(4, '0')}`,
      price: p[1],
      compare_at_price: rand() > 0.6 ? Math.round((p[1] * (1.1 + rand() * 0.3)) * 100) / 100 : null,
      weight_g: p[2] * 100,
      stock_quantity: stock,
      low_stock_threshold: 5,
      in_stock: stock > 0,
      status: rand() > 0.1 ? 'active' : 'draft',
      rating: Math.round((2.5 + rand() * 2.5) * 10) / 10,
      review_count: Math.floor(rand() * 240),
      image_id: mediaField(productImages[i % productImages.length]),
      gallery: gallery.map((g) => mediaField(g)),
      description: `${p[0]} — a demo product showing pricing, inventory, ratings groups, a media image, a json gallery, and brand + tag relations.`,
      brand_id: brandIds[i % brandIds.length] ?? null,
      tag_ids: tags.filter(Boolean),
    }
  })

  // --- Team -----------------------------------------------------------------------
  await seed('team_members', teamSeeds, (t, i) => {
    const rand = rng(6000 + i)
    return {
      name: t[0],
      email: `${t[0].toLowerCase().replace(/\s+/g, '.')}@workerstacks.dev`,
      phone: `+62 8${1000 + Math.floor(rand() * 8999)}-${1000 + Math.floor(rand() * 8999)}`,
      department: t[1],
      title: t[2],
      avatar_id: mediaField(authorAvatars[(i + 4) % authorAvatars.length]),
      location: t[3],
      skills: t[4],
      bio: `${t[0]} is part of the ${t[1]} department at Hamolus, focused on ${t[4].slice(0, 3).join(', ')}.`,
      start_date: `${2018 + (i % 8)}-${String(1 + (i % 12)).padStart(2, '0')}-03`,
      is_remote: t[5],
    }
  })

  // --- Events ---------------------------------------------------------------------
  await seed('events', eventSeeds, (e, i) => {
    const rand = rng(7000 + i)
    const startDate = new Date(Date.UTC(2026, 8 + Math.floor(rand() * 4), 1 + Math.floor(rand() * 24), 17 + Math.floor(rand() * 4), 0))
    const endDate = new Date(startDate.getTime() + (1 + Math.floor(rand() * 3)) * 3600000)
    const isOnline = e[2] === 'Online'
    const status = i < 3 ? 'upcoming' : i < 6 ? 'ended' : i % 7 === 0 ? 'cancelled' : rand() > 0.3 ? 'upcoming' : 'ended'
    return {
      title: e[0],
      slug: e[1],
      description: lex([pick(eventBodies, rand)]),
      status,
      capacity: e[4],
      registered_count: e[5],
      is_online: isOnline,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
      venue_name: isOnline ? 'Discord / Zoom / Streamyard' : e[3],
      venue_city: isOnline ? 'Online' : e[2],
      cover_id: mediaField(eventCovers[i % eventCovers.length]),
      organizer_id: authorIds[(i * 2) % authorIds.length] ?? null,
      tag_ids: [tagIdByName.get('events'), tagIdByName.get(i % 2 ? 'community' : 'workers')].filter(Boolean),
    }
  })

  // --- Contacts -------------------------------------------------------------------
  await seed('contacts', contactFirst, (name, i) => {
    const rand = rng(8000 + i)
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}${Math.floor(rand() * 99)}@example.com`
    return {
      name,
      email,
      subject: pick(contactSubjects, rand),
      message: pick(contactMessages, rand),
      status: pick(['new', 'on_going', 'done'], rand),
      source: pick(['website', 'social', 'email', 'event'], rand),
      reference_code: `REF-2026-${String(i + 1).padStart(4, '0')}`,
      submitted_at: new Date(Date.UTC(2026, 6 + Math.floor(rand() * 3), 1 + Math.floor(rand() * 28), 6 + Math.floor(rand() * 12), Math.floor(rand() * 60))).toISOString(),
      processed: rand() > 0.45,
    }
  })

  // --- Testimonials ---------------------------------------------------------------
  await seed('testimonials', testimonialSeeds, (t, i) => ({
    author_name: t[0],
    role: t[1],
    company_name: t[2],
    quote: testimonialQuotes[i % testimonialQuotes.length],
    rating: t[3],
    is_featured: i % 4 === 0,
    avatar_id: mediaField(testimonialAvatars[i % testimonialAvatars.length]),
    published: i % 5 !== 0,
  }))

  // --- Summary --------------------------------------------------------------------
  console.log('== summary ===============================================================')
  const stats = await api('/api/_meta/stats', { headers: A })
  const s = stats.data
  console.log(`collections: ${s.collections} | records: ${s.totalRecords} | media: ${s.media} | groups: ${s.groups}`)
  for (const c of s.perCollection) {
    console.log(`  ${c.name.padEnd(14)} ${String(c.count).padStart(4)}  (${c.group ?? '-'})`)
  }
  const groupTree = await api('/api/_meta/groups', { headers: A })
  const indent = (id, depth) => {
    const g = (groupTree.data ?? []).find((x) => x.id === id)
    if (!g) return
    process.stdout.write(`  ${'  '.repeat(depth)}• ${g.id} (${g.label})\n`)
    ;(groupTree.data ?? []).filter((x) => x.parent === id).forEach((x) => indent(x.id, depth + 1))
  }
  console.log('group tree:')
  ;(groupTree.data ?? []).filter((g) => !g.parent).forEach((g) => indent(g.id, 0))
  console.log('\nSeed complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})