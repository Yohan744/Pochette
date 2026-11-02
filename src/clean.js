'use strict';

/*
 * One-click cleanup of tag values. Loaded by the interface (script tag) and by the tests (require).
 *  - website ads (“djsoundtop.com”, “www.blabla.net”, “https://…”) are removed; a comment holding one is cleared
 *  - double spaces are collapsed, brackets left empty are dropped, stray separators trimmed
 *  - a dot right after a closing bracket is removed: “Boogie (Original Mix).” → “Boogie (Original Mix)”
 */
(function (root) {
  const TLD = 'com|net|org|info|biz|ru|su|to|io|me|fm|cc|xyz|club|pro|top|site|online|store|shop|music|dj|eu|fr|de|uk|co|us|in|ws|tk|ml|ga|cf|gq|pw|link|live|space|website|vip|one|app|world|life|zone|stream|audio|mp3|tv|ua|pl|es|it|nl|be|ch|br|cz|sk|lt|lv|ee|ro|hu|gr|pt|se|no|dk|fi|is|ir|cn|jp|kr|vn|id|my|ph|sg|au|nz|ca|mx|ar|cl|name|mobi|asia|today|rocks|fun|ninja|guru|tech|digital|media|network|cloud|download|party|win|bid|men|work|review|date|racing|science|trade|ink|cafe|land|plus|blog|news|email|run';
  // a domain needs a 3+ character name before the extension, so “Mr.Me” or “Vol.1” are left alone;
  // anything starting with http(s):// or www. is always an ad
  const DOMAIN = new RegExp(
    `(?:https?:\\/\\/[^\\s)\\]]+|www\\.[^\\s)\\]]+|\\b[a-z0-9][a-z0-9-]{2,}(?:\\.[a-z0-9-]+)*\\.(?:${TLD})\\b(?:[\\/?#][^\\s)\\]]*)?)`,
    'gi',
  );
  const FIELDS = ['name', 'title', 'artist', 'album', 'albumArtist', 'genre', 'year', 'track', 'bpm', 'key', 'label', 'comment'];

  const hasAd = (v) => { DOMAIN.lastIndex = 0; const r = DOMAIN.test(v || ''); DOMAIN.lastIndex = 0; return r; };

  /** Collapses runs of spaces (keeps line breaks, used live while editing). */
  const collapseSpaces = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/ {2,}/g, ' ');

  function cleanValue(field, value) {
    let s = String(value ?? '');
    if (!s) return s;
    if (field === 'comment' && hasAd(s)) return '';
    // drop the ad and the words that introduce it (“by …”, “downloaded from …”)
    s = s.replace(/\u00a0/g, ' ').replace(DOMAIN, '\u0000');
    s = s.replace(/(?:\b(?:free\s+)?download(?:ed)?\s+(?:from|at|on)|\b(?:by|from|via|at|on)|@)\s*\u0000/gi, '\u0000');
    s = s.replace(/\u0000/g, ' ');
    s = s.replace(/[([{]\s*[)\]}]/g, ' '); // brackets left empty
    s = s.replace(/([([{])\s+/g, '$1').replace(/\s+([)\]}])/g, '$1');
    s = s.replace(/[ \t]{2,}/g, ' ').trim();
    s = s.replace(/^[\s\-–—|:,/•·_]+|[\s\-–—|:,/•·_]+$/g, '');
    if (field === 'title' || field === 'name') s = s.replace(/([)\]])\.+$/, '$1');
    return s;
  }

  /** → [{ field, before, after }] for one track ({ name, tags }) */
  function cleanTrack(track) {
    const out = [];
    for (const f of FIELDS) {
      const before = f === 'name' ? track.name : (track.tags[f] ?? '');
      const after = cleanValue(f, before);
      if (after !== before && !(f === 'name' && !after)) out.push({ field: f, before, after });
    }
    return out;
  }

  const api = { cleanValue, cleanTrack, collapseSpaces, hasAd, FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Clean = api;
}(typeof window !== 'undefined' ? window : globalThis));
