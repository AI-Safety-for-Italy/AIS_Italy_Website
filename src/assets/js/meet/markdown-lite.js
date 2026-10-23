/* A deliberately small Markdown, for the texts written in the content tool
 * (/app/content/): paragraphs, **bold**, *italic*, [links](https://…) and
 * "- " lists. Everything else is escaped, so whatever an editor types, the
 * site only ever gets these few tags. Shared by the browser (the preview) and
 * the server (what is saved and published), so both always agree.
 *
 *   toHtml(md)    -> '<p>…</p>' (empty string for empty input)
 *   fromHtml(html) -> the Markdown for HTML written by hand in data/events.yaml,
 *                     used once by scripts/content-migrate.js
 */
/* global module */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else (root.Meet = root.Meet || {}).md = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var SAFE_URL = /^(https:\/\/|mailto:|\/(?!\/))/i;

  /** Inline marks on one escaped line: links first, then bold, then italic. */
  function inline(text) {
    var out = escapeHtml(text);
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (all, label, url) {
      // The URL was escaped with the rest; undo it only to check the scheme.
      var raw = url.replace(/&amp;/g, '&');
      if (!SAFE_URL.test(raw)) return all;
      var external = /^https:/i.test(raw);
      return (
        '<a href="' +
        url +
        '"' +
        (external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        '>' +
        label +
        '</a>'
      );
    });
    out = out.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
    return out;
  }

  function toHtml(md) {
    var blocks = String(md || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n\s*\n/)
      .map(function (b) {
        return b.trim();
      })
      .filter(Boolean);
    return blocks
      .map(function (block) {
        var lines = block.split('\n');
        var isList = lines.every(function (l) {
          return /^\s*[-*]\s+/.test(l);
        });
        if (isList) {
          return (
            '<ul>' +
            lines
              .map(function (l) {
                return '<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>';
              })
              .join('') +
            '</ul>'
          );
        }
        return '<p>' + lines.map(inline).join('<br>') + '</p>';
      })
      .join('');
  }

  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function fromHtml(html) {
    var s = String(html || '');
    s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
    s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    s = s.replace(/<\/(p|ul|ol)>/gi, '\n\n');
    s = s.replace(/<[^>]+>/g, '');
    return decodeEntities(s)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  return { toHtml: toHtml, fromHtml: fromHtml, escapeHtml: escapeHtml };
});
