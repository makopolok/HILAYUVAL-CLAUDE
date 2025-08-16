#!/usr/bin/env node
// Utility: generate a signed Bunny Stream iframe URL given GUID
// Usage: node scripts/generate_bunny_signed_url.js <videoGuid> [ttlSeconds]
// Requires env vars: BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_SIGNING_KEY

const crypto = require('crypto');

const { BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_SIGNING_KEY } = process.env;
if (!BUNNY_STREAM_LIBRARY_ID || !BUNNY_STREAM_SIGNING_KEY) {
  console.error('Missing BUNNY_STREAM_LIBRARY_ID or BUNNY_STREAM_SIGNING_KEY in environment.');
  process.exit(1);
}

const guid = process.argv[2];
if (!guid) {
  console.error('Provide a video GUID.');
  process.exit(1);
}
const ttlRaw = process.argv[3] || '3600';
let ttl = parseInt(ttlRaw, 10);
if (isNaN(ttl) || ttl < 60) ttl = 3600;
if (ttl > 86400) ttl = 86400;
const expires = Math.floor(Date.now()/1000) + ttl;
const pathForToken = `/embed/${BUNNY_STREAM_LIBRARY_ID}/${guid}`;
const token = crypto.createHash('md5').update(BUNNY_STREAM_SIGNING_KEY + pathForToken + expires).digest('hex');
const url = `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${guid}?token=${token}&expires=${expires}&autoplay=false`;
console.log(url);
