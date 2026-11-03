/* /app/content/local-groups/: which groups of the local groups' board the
 * community page's map shows (server/local-groups.js, `local_groups_site`).
 * Each group: shown or not, its pin on the map, and the page its name opens
 * (its WhatsApp group, its own site…) or none. "Publish to the site" saves
 * them all and rebuilds the site. Nothing of the board's leads or links
 * reaches this page. */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var API = '/api/app/local-groups';
  var SVG = 'http://www.w3.org/2000/svg';
  var wrap = document.getElementById('lgSite');
  var list = document.getElementById('lgSiteList');
  var pins = document.getElementById('lgPins');
  var map = document.getElementById('lgMap');
  var hint = document.getElementById('lgMapHint');
  var notLive = document.getElementById('lgNotLive');
  var publishBtn = document.getElementById('lgPublish');
  var state = document.getElementById('lgState');
  var unpublishRow = document.getElementById('lgUnpublishRow');
  var msg = document.getElementById('lgSiteMsg');

  // Where the main Italian cities fall on the map, so ticking one puts its
  // pin in place: [lat, lon], projected as the map is (Mercator, fitted to
  // its 0 0 420 560 viewBox). Others are placed by clicking the map.
  var PLACES = {
    agrigento: [37.31, 13.58],
    alessandria: [44.91, 8.61],
    ancona: [43.62, 13.52],
    aosta: [45.74, 7.32],
    arezzo: [43.46, 11.88],
    'ascoli piceno': [42.85, 13.58],
    asti: [44.9, 8.21],
    avellino: [40.91, 14.79],
    bari: [41.12, 16.87],
    barletta: [41.32, 16.28],
    belluno: [46.14, 12.22],
    benevento: [41.13, 14.78],
    bergamo: [45.7, 9.67],
    biella: [45.57, 8.05],
    bologna: [44.49, 11.34],
    bolzano: [46.5, 11.35],
    brescia: [45.54, 10.21],
    brindisi: [40.63, 17.94],
    cagliari: [39.22, 9.12],
    caltanissetta: [37.49, 14.06],
    campobasso: [41.56, 14.66],
    caserta: [41.07, 14.33],
    catania: [37.5, 15.09],
    catanzaro: [38.91, 16.59],
    cesena: [44.14, 12.24],
    chieti: [42.35, 14.17],
    como: [45.81, 9.09],
    cosenza: [39.3, 16.25],
    cremona: [45.13, 10.02],
    crotone: [39.08, 17.13],
    cuneo: [44.38, 7.54],
    enna: [37.57, 14.28],
    fermo: [43.16, 13.72],
    ferrara: [44.84, 11.62],
    firenze: [43.77, 11.26],
    foggia: [41.46, 15.55],
    forli: [44.22, 12.04],
    frosinone: [41.64, 13.35],
    genova: [44.41, 8.95],
    gorizia: [45.94, 13.62],
    grosseto: [42.76, 11.11],
    imperia: [43.89, 8.03],
    isernia: [41.59, 14.23],
    "l'aquila": [42.35, 13.4],
    'la spezia': [44.1, 9.82],
    latina: [41.47, 12.9],
    lecce: [40.35, 18.17],
    lecco: [45.86, 9.4],
    livorno: [43.55, 10.31],
    lodi: [45.31, 9.5],
    lucca: [43.84, 10.5],
    macerata: [43.3, 13.45],
    mantova: [45.16, 10.79],
    massa: [44.04, 10.14],
    matera: [40.67, 16.6],
    messina: [38.19, 15.55],
    milano: [45.46, 9.19],
    modena: [44.65, 10.93],
    monza: [45.58, 9.27],
    napoli: [40.85, 14.27],
    novara: [45.45, 8.62],
    nuoro: [40.32, 9.33],
    oristano: [39.9, 8.59],
    padova: [45.41, 11.88],
    palermo: [38.12, 13.36],
    parma: [44.8, 10.33],
    pavia: [45.19, 9.16],
    perugia: [43.11, 12.39],
    pesaro: [43.91, 12.91],
    pescara: [42.46, 14.21],
    piacenza: [45.05, 9.69],
    pisa: [43.72, 10.4],
    pistoia: [43.93, 10.91],
    pordenone: [45.96, 12.66],
    potenza: [40.64, 15.8],
    prato: [43.88, 11.1],
    ragusa: [36.93, 14.73],
    ravenna: [44.42, 12.2],
    'reggio calabria': [38.11, 15.65],
    'reggio emilia': [44.7, 10.63],
    rieti: [42.4, 12.86],
    rimini: [44.06, 12.57],
    roma: [41.9, 12.5],
    rovigo: [45.07, 11.79],
    salerno: [40.68, 14.77],
    sassari: [40.73, 8.56],
    savona: [44.31, 8.48],
    siena: [43.32, 11.33],
    siracusa: [37.08, 15.29],
    sondrio: [46.17, 9.87],
    taranto: [40.46, 17.25],
    teramo: [42.66, 13.7],
    terni: [42.56, 12.65],
    torino: [45.07, 7.69],
    trapani: [38.02, 12.51],
    trento: [46.07, 11.12],
    treviso: [45.67, 12.24],
    trieste: [45.65, 13.78],
    udine: [46.07, 13.23],
    urbino: [43.73, 12.64],
    varese: [45.82, 8.83],
    venezia: [45.44, 12.32],
    verbania: [45.92, 8.55],
    vercelli: [45.32, 8.42],
    verona: [45.44, 10.99],
    'vibo valentia': [38.68, 16.1],
    vicenza: [45.55, 11.55],
    viterbo: [42.42, 12.11],
  };
  var ALIASES = {
    milan: 'milano',
    turin: 'torino',
    rome: 'roma',
    naples: 'napoli',
    florence: 'firenze',
    venice: 'venezia',
    genoa: 'genova',
    padua: 'padova',
    mestre: 'venezia',
    'forli-cesena': 'forli',
    'pesaro-urbino': 'pesaro',
    'monza e brianza': 'monza',
  };

  function fold(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  }

  function round(n) {
    return Math.round(n * 10) / 10;
  }

  /** The pin of a known city, or null. */
  function placeOf(city) {
    var key = fold(city);
    var ll = PLACES[ALIASES[key] || key];
    if (!ll) return null;
    var merc = (Math.log(Math.tan(Math.PI / 4 + (ll[0] * Math.PI) / 360)) * 180) / Math.PI;
    return { x: round(33.0571 * ll[1] - 205.118), y: round(-32.9833 * merc + 1813.19) };
  }

  var groups = []; // [{ id, city, status, show, link, x, y }]
  var placing = null; // the id of the group whose pin the next click sets
  var fields = null;

  var loading = M.loading();
  wrap.parentNode.insertBefore(loading, wrap);
  Promise.all([M.me, M.api('GET', API + '?part=site')])
    .then(function (r) {
      loading.remove();
      setData(r[1]);
      wrap.hidden = false;
    })
    .catch(function (err) {
      loading.remove();
      if (err.status === 403) {
        msg.appendChild(
          h('div', { class: 'empty-state' }, h('h3', null, 'No access'), h('p', null, err.message))
        );
        return;
      }
      M.appError(err);
    });

  function setData(d) {
    groups = d.groups;
    showState(d.site);
    render();
    fields =
      fields ||
      M.watchFields(list, {
        buttons: function () {
          return [publishBtn];
        },
      });
    fields.saved();
  }

  function showState(site) {
    notLive.hidden = site.live;
    unpublishRow.hidden = !site.live;
    state.textContent = site.pending
      ? site.live
        ? 'Changes not on the site yet.'
        : ''
      : 'The site shows this list' +
        (site.publishedAt ? ' (published ' + M.fmtDateTime(site.publishedAt) + ').' : '.');
  }

  var STATUS = { starting: 'Starting', active: 'Active', paused: 'Paused' };

  function render() {
    M.clear(list);
    if (!groups.length) {
      list.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          h('h3', null, 'No local groups on the board'),
          h('p', null, 'Groups are added on the Local groups board; then they can be shown here.')
        )
      );
    }
    groups.forEach(function (g) {
      list.appendChild(row(g));
    });
    drawPins();
    hint.textContent = placing
      ? 'Click the map where ' + byId(placing).city + ' is.'
      : 'Tick a city to put it on the map; “Move the pin”, then click the map, to place it.';
    map.classList.toggle('is-placing', Boolean(placing));
  }

  function byId(id) {
    return groups.filter(function (g) {
      return g.id === id;
    })[0];
  }

  function row(g) {
    var show = h('input', { type: 'checkbox', 'aria-label': 'Show ' + g.city + ' on the site' });
    show.checked = g.show;
    show.addEventListener('change', function () {
      g.show = show.checked;
      if (g.show && (g.x === null || g.y === null)) {
        var p = placeOf(g.city);
        if (p) {
          g.x = p.x;
          g.y = p.y;
        } else {
          placing = g.id;
        }
      }
      if (!g.show && placing === g.id) placing = null;
      render();
    });
    var link = h('input', {
      class: 'form-input is-compact',
      type: 'url',
      maxlength: '500',
      placeholder: 'Link (optional): https://chat.whatsapp.com/… or a site',
      'aria-label': 'Where ' + g.city + ' links on the site',
    });
    link.value = g.link || '';
    link.addEventListener('input', function () {
      g.link = link.value.trim();
    });
    // The pin as fields, so leaving with a moved pin asks first.
    var x = h('input', { type: 'hidden', value: g.x === null ? '' : String(g.x) });
    var y = h('input', { type: 'hidden', value: g.y === null ? '' : String(g.y) });
    var placed = g.x !== null && g.y !== null;
    return h(
      'div',
      {
        class:
          'panel lg-site-row' +
          (g.show ? ' is-shown' : '') +
          (placing === g.id ? ' is-placing' : ''),
      },
      h(
        'label',
        { class: 'check-row lg-site-city' },
        show,
        h('strong', null, g.city),
        h('span', { class: 'crm-tag' }, STATUS[g.status] || g.status)
      ),
      g.show ? link : null,
      g.show
        ? h(
            'div',
            { class: 'lg-site-pin' },
            h(
              'span',
              { class: 'panel-note', style: 'margin:0' },
              placing === g.id ? 'Click the map…' : placed ? 'On the map' : 'Not on the map yet'
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'link-button',
                onclick: function () {
                  placing = placing === g.id ? null : g.id;
                  render();
                },
              },
              placing === g.id ? 'Cancel' : placed ? 'Move the pin' : 'Place it'
            )
          )
        : null,
      x,
      y
    );
  }

  function svg(tag, attrs, text) {
    var el = document.createElementNS(SVG, tag);
    Object.keys(attrs).forEach(function (k) {
      el.setAttribute(k, attrs[k]);
    });
    if (text) el.textContent = text;
    return el;
  }

  function drawPins() {
    while (pins.firstChild) pins.removeChild(pins.firstChild);
    groups.forEach(function (g) {
      if (!g.show || g.x === null || g.y === null) return;
      var pin = svg('g', { class: 'lg-pin' + (placing === g.id ? ' is-placing' : '') });
      pin.appendChild(svg('circle', { cx: g.x, cy: g.y, r: 4.5 }));
      pin.appendChild(svg('text', { x: g.x + 8, y: g.y + 4 }, g.city + (g.link ? ' ↗' : '')));
      pins.appendChild(pin);
    });
  }

  map.addEventListener('click', function (e) {
    if (!placing) return;
    var ctm = map.getScreenCTM();
    if (!ctm) return;
    var pt = map.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    var p = pt.matrixTransform(ctm.inverse());
    var g = byId(placing);
    g.x = round(Math.max(0, Math.min(420, p.x)));
    g.y = round(Math.max(0, Math.min(560, p.y)));
    placing = null;
    render();
  });

  publishBtn.addEventListener('click', function () {
    var shown = groups.filter(function (g) {
      return g.show;
    });
    if (
      !window.confirm(
        'Publish the map with ' +
          shown.length +
          (shown.length === 1 ? ' city' : ' cities') +
          '? The site is rebuilt and shows it in a few minutes.'
      )
    )
      return;
    publishBtn.disabled = true;
    M.api('POST', API + '?action=publish', {
      groups: groups.map(function (g) {
        return { id: g.id, show: g.show, link: g.link, x: g.x, y: g.y };
      }),
    })
      .then(function (r) {
        placing = null;
        setData(r);
        M.toast(
          r.build && r.build.started
            ? 'Published: the site updates in a few minutes'
            : 'Saved, but the site was not rebuilt (' + ((r.build && r.build.detail) || '?') + ')',
          !(r.build && r.build.started)
        );
      })
      .catch(function (err) {
        if (err.status === 401) return M.appError(err);
        M.toast(err.message, true);
      })
      .then(function () {
        publishBtn.disabled = false;
      });
  });

  document.getElementById('lgUnpublish').addEventListener('click', function () {
    if (
      !window.confirm(
        'Put the site back on the cities written in the code? Nothing here is deleted, and publishing again brings this list back.'
      )
    )
      return;
    M.api('POST', API + '?action=unpublish')
      .then(function (r) {
        setData(r);
        M.toast('The site goes back to the cities written in the code');
      })
      .catch(M.appError);
  });
})();
