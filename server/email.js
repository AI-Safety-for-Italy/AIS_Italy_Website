'use strict';

/**
 * The one email rule for the whole server. Every place that checks an address
 * uses this, so an address is never valid in one place and refused in another.
 * It is the strictest rule any of them had: no spaces or <>()",;: characters,
 * a dot in the domain, a 2+ letter ending, and at most 254 characters.
 * The browser twin is Meet.isEmail in src/assets/js/meet/common.js.
 */

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

function isEmail(text) {
  return typeof text === 'string' && text.length <= 254 && EMAIL.test(text);
}

function normalizeEmail(text) {
  return String(text || '')
    .trim()
    .toLowerCase();
}

module.exports = { isEmail, normalizeEmail };
