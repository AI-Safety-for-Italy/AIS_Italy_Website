/* Small charts for the answers pages (forms-responses.js), drawn as HTML and
 * SVG without a library.
 *
 *   Meet.charts.bars(rows, opts)      horizontal bars, long labels welcome
 *   Meet.charts.columns(rows, opts)   vertical columns (scales, histograms,
 *                                     answers over time)
 *   Meet.charts.donut(rows, opts)     parts of a whole, with its legend
 *
 * rows: [{ key, label, count, share (0..1), selected }]. With opts.onPick a
 * mark is a button: a click (or Enter) hands its key back.
 *
 * The rules they follow: bars at most 24px thick with a 4px rounded end, one
 * hue for a single series (the accent), the slices of a donut in a fixed,
 * colour-blind-checked order (never cycled: past six, "Other"), hairline
 * grid, a tooltip on every mark, and every number also as text. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;
  var NS = 'http://www.w3.org/2000/svg';
  var SLICES = 6;

  function svg(tag, attrs) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }

  function pct(share) {
    var p = share * 100;
    return (p > 0 && p < 1 ? '<1' : Math.round(p)) + '%';
  }

  function compact(n) {
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n);
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  var tip = null;
  function showTip(target, lines) {
    if (!tip) {
      tip = h('div', { class: 'fr-tip', role: 'tooltip' });
      document.body.appendChild(tip);
    }
    M.clear(tip);
    lines.forEach(function (line, i) {
      tip.appendChild(h(i ? 'span' : 'strong', null, line));
    });
    tip.hidden = false;
    var box = target.getBoundingClientRect();
    var w = tip.offsetWidth;
    var left = Math.min(Math.max(8, box.left + box.width / 2 - w / 2), window.innerWidth - w - 8);
    var top = box.top - tip.offsetHeight - 8;
    if (top < 8) top = box.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip() {
    if (tip) tip.hidden = true;
  }

  function hover(el, lines) {
    el.addEventListener('mouseenter', function () {
      showTip(el, lines);
    });
    el.addEventListener('focus', function () {
      showTip(el, lines);
    });
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('blur', hideTip);
  }

  function pickable(el, row, opts) {
    if (!opts.onPick) return;
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', String(Boolean(row.selected)));
    el.classList.add('is-pickable');
    el.addEventListener('click', function () {
      hideTip();
      opts.onPick(row.key);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        hideTip();
        opts.onPick(row.key);
      }
    });
  }

  function tipLines(row, opts) {
    var lines = [
      row.label,
      row.count + (row.count === 1 ? ' answer' : ' answers') + ' · ' + pct(row.share),
    ];
    if (opts.onPick)
      lines.push(row.selected ? 'Click to show all again' : 'Click to keep only these');
    return lines;
  }

  // ── Bars ──────────────────────────────────────────────────────────────────

  function bars(rows, opts) {
    opts = opts || {};
    var max = rows.reduce(function (m, r) {
      return Math.max(m, r.share);
    }, 0);
    var anySelected = rows.some(function (r) {
      return r.selected;
    });
    var box = h('div', { class: 'fr-bars' });
    rows.forEach(function (row) {
      var width = max ? (row.share / max) * 100 : 0;
      var el = h(
        'div',
        { class: 'fr-bar' + (row.selected ? ' is-selected' : anySelected ? ' is-muted' : '') },
        h('span', { class: 'fr-bar-label' }, row.label),
        h(
          'span',
          { class: 'fr-bar-line' },
          h(
            'span',
            { class: 'fr-bar-track' },
            h('span', {
              class: 'fr-bar-fill',
              style: 'width:' + (row.count ? Math.max(width, 1.2) : 0) + '%',
            })
          ),
          h('span', { class: 'fr-bar-value' }, compact(row.count) + ' · ' + pct(row.share))
        )
      );
      pickable(el, row, opts);
      hover(el, tipLines(row, opts));
      box.appendChild(el);
    });
    return box;
  }

  // ── Columns ───────────────────────────────────────────────────────────────

  function niceMax(n) {
    if (n <= 4) return Math.max(n, 1);
    var step = Math.pow(10, Math.floor(Math.log10(n)));
    var m = [1, 2, 2.5, 5, 10].map(function (k) {
      return k * step;
    });
    for (var i = 0; i < m.length; i++) if (m[i] >= n) return m[i];
    return n;
  }

  /** Redraws `draw(width)` whenever the box changes width. */
  function responsive(className, draw) {
    var box = h('div', { class: className });
    var last = 0;
    function paint() {
      var w = Math.round(box.clientWidth);
      if (!w || w === last) return;
      last = w;
      M.clear(box);
      box.appendChild(draw(w));
    }
    if (window.ResizeObserver) new ResizeObserver(paint).observe(box);
    else setTimeout(paint, 0);
    return box;
  }

  function columns(rows, opts) {
    opts = opts || {};
    var height = opts.height || 200;
    return responsive('fr-columns', function (width) {
      var left = 32;
      var bottom = 26;
      var top = 18;
      var inner = width - left - 6;
      var plot = height - top - bottom;
      var max = niceMax(
        rows.reduce(function (m, r) {
          return Math.max(m, r.count);
        }, 0)
      );
      var band = inner / Math.max(rows.length, 1);
      var col = Math.max(2, Math.min(24, band * 0.62));
      var anySelected = rows.some(function (r) {
        return r.selected;
      });
      var chart = svg('svg', {
        width: width,
        height: height,
        viewBox: '0 0 ' + width + ' ' + height,
        role: 'img',
        'aria-label': opts.label || 'Chart',
      });
      // Gridlines and the y ticks: whole numbers only.
      var ticks = max <= 4 ? max : [4, 5, 3, 2].filter((k) => max % k === 0)[0] || 4;
      for (var t = 0; t <= ticks; t++) {
        var value = Math.round((max / ticks) * t);
        var y = top + plot - (value / max) * plot;
        chart.appendChild(
          svg('line', {
            x1: left,
            x2: width - 6,
            y1: y,
            y2: y,
            class: t ? 'fr-gridline' : 'fr-axis',
          })
        );
        var tick = svg('text', { x: left - 8, y: y + 4, class: 'fr-tick', 'text-anchor': 'end' });
        tick.textContent = compact(value);
        chart.appendChild(tick);
      }
      // Labels: as many as fit.
      var every = Math.max(1, Math.ceil((rows.length * 46) / inner));
      var tallest = -1;
      rows.forEach(function (r, i) {
        if (tallest === -1 || r.count > rows[tallest].count) tallest = i;
      });
      rows.forEach(function (row, i) {
        var x = left + band * i + (band - col) / 2;
        var hgt = max ? (row.count / max) * plot : 0;
        var y0 = top + plot;
        var g = svg('g', {
          class: 'fr-col' + (row.selected ? ' is-selected' : anySelected ? ' is-muted' : ''),
        });
        g.appendChild(
          svg('rect', { x: left + band * i, y: top, width: band, height: plot, class: 'fr-hit' })
        );
        if (hgt > 0) {
          var r = Math.min(4, col / 2, hgt);
          // Rounded at the data end, square at the baseline.
          g.appendChild(
            svg('path', {
              class: 'fr-col-fill',
              d:
                'M' +
                x +
                ',' +
                y0 +
                'V' +
                (y0 - hgt + r) +
                'Q' +
                x +
                ',' +
                (y0 - hgt) +
                ' ' +
                (x + r) +
                ',' +
                (y0 - hgt) +
                'H' +
                (x + col - r) +
                'Q' +
                (x + col) +
                ',' +
                (y0 - hgt) +
                ' ' +
                (x + col) +
                ',' +
                (y0 - hgt + r) +
                'V' +
                y0 +
                'Z',
            })
          );
        }
        if (i === tallest && row.count) {
          var cap = svg('text', {
            x: x + col / 2,
            y: y0 - hgt - 6,
            class: 'fr-cap',
            'text-anchor': 'middle',
          });
          cap.textContent = compact(row.count);
          g.appendChild(cap);
        }
        if (i % every === 0) {
          var label = svg('text', {
            x: x + col / 2,
            y: height - 8,
            class: 'fr-tick',
            'text-anchor': 'middle',
          });
          label.textContent = row.short || row.label;
          g.appendChild(label);
        }
        pickable(g, row, opts);
        hover(g, tipLines(row, opts));
        chart.appendChild(g);
      });
      return chart;
    });
  }

  // ── Donut ─────────────────────────────────────────────────────────────────

  function donut(rows, opts) {
    opts = opts || {};
    var shown = rows.slice();
    if (shown.length > SLICES) {
      var rest = shown.slice(SLICES - 1);
      shown = shown.slice(0, SLICES - 1);
      shown.push({
        key: null,
        label: 'Other (' + rest.length + ')',
        count: rest.reduce(function (n, r) {
          return n + r.count;
        }, 0),
        share: rest.reduce(function (n, r) {
          return n + r.share;
        }, 0),
        other: true,
      });
    }
    var total = shown.reduce(function (n, r) {
      return n + r.count;
    }, 0);
    var size = 172;
    var c = size / 2;
    var outer = c - 2;
    var ring = 26;
    var chart = svg('svg', {
      width: size,
      height: size,
      viewBox: '0 0 ' + size + ' ' + size,
      role: 'img',
      'aria-label': opts.label || 'Chart',
      class: 'fr-donut-svg',
    });
    var angle = -Math.PI / 2;
    var anySelected = shown.some(function (r) {
      return r.selected;
    });
    shown.forEach(function (row, i) {
      if (!row.count) return;
      var a = (row.count / total) * Math.PI * 2;
      var slot = row.other ? 'other' : i + 1;
      var g = svg('g', {
        class:
          'fr-slice fr-slot-' +
          slot +
          (row.selected ? ' is-selected' : anySelected ? ' is-muted' : ''),
      });
      if (a >= Math.PI * 2 - 1e-6) {
        g.appendChild(
          svg('circle', {
            cx: c,
            cy: c,
            r: outer - ring / 2,
            'stroke-width': ring,
            class: 'fr-ring',
          })
        );
      } else {
        var x1 = c + outer * Math.cos(angle);
        var y1 = c + outer * Math.sin(angle);
        var x2 = c + outer * Math.cos(angle + a);
        var y2 = c + outer * Math.sin(angle + a);
        var r2 = outer - ring;
        var x3 = c + r2 * Math.cos(angle + a);
        var y3 = c + r2 * Math.sin(angle + a);
        var x4 = c + r2 * Math.cos(angle);
        var y4 = c + r2 * Math.sin(angle);
        var big = a > Math.PI ? 1 : 0;
        g.appendChild(
          svg('path', {
            d:
              'M' +
              x1 +
              ',' +
              y1 +
              'A' +
              outer +
              ',' +
              outer +
              ' 0 ' +
              big +
              ' 1 ' +
              x2 +
              ',' +
              y2 +
              'L' +
              x3 +
              ',' +
              y3 +
              'A' +
              r2 +
              ',' +
              r2 +
              ' 0 ' +
              big +
              ' 0 ' +
              x4 +
              ',' +
              y4 +
              'Z',
          })
        );
      }
      angle += a;
      if (!row.other) pickable(g, row, opts);
      hover(g, tipLines(row, row.other ? {} : opts));
      chart.appendChild(g);
    });
    var middle = svg('text', { x: c, y: c + 2, class: 'fr-donut-total', 'text-anchor': 'middle' });
    middle.textContent = compact(total);
    chart.appendChild(middle);
    var sub = svg('text', { x: c, y: c + 20, class: 'fr-tick', 'text-anchor': 'middle' });
    sub.textContent = opts.unit || 'answers';
    chart.appendChild(sub);

    var legend = h('ul', { class: 'fr-legend' });
    shown.forEach(function (row, i) {
      var item = h(
        'li',
        {
          class:
            'fr-legend-item' +
            (row.selected ? ' is-selected' : anySelected && !row.other ? ' is-muted' : ''),
        },
        h('span', {
          class: 'fr-swatch fr-slot-' + (row.other ? 'other' : i + 1),
          'aria-hidden': 'true',
        }),
        h('span', { class: 'fr-legend-label' }, row.label),
        h('span', { class: 'fr-legend-value' }, compact(row.count) + ' · ' + pct(row.share))
      );
      if (!row.other) pickable(item, row, opts);
      legend.appendChild(item);
    });
    return h('div', { class: 'fr-donut' }, chart, legend);
  }

  M.charts = {
    bars: bars,
    columns: columns,
    donut: donut,
    pct: pct,
    compact: compact,
    hideTip: hideTip,
  };
})();
