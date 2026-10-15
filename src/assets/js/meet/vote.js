/* /meet/?p=<token>: the page participants answer a poll on.
 *
 * Times are shown in the visitor's own time zone. After answering, the visitor
 * gets an edit link (also remembered in this browser) to change the answer.
 * Text is in the page language, from the strings below: the build-time
 * data-en/data-it mechanism cannot reach text this script creates.
 */
(function () {
  'use strict';
  var M = window.Meet;
  var h = M.h;

  var STRINGS = {
    en: {
      loading: 'Loading…',
      notFound: 'Poll not found',
      notFoundText: 'Check the link you were sent.',
      inviteOnly: 'This poll is by invitation only',
      inviteOnlyText: 'Open it from the personal link in your invitation email.',
      error: 'Something went wrong. Please try again.',
      yes: 'Yes',
      maybe: 'If needed',
      no: 'No',
      yourDetails: 'Your details',
      name: 'Name',
      email: 'Email',
      emailNote: 'Only used for the calendar invite.',
      yourTz: 'Times in ',
      organizerTz: 'organiser: ',
      allYes: 'Yes to all',
      clear: 'Clear',
      submit: 'Send',
      update: 'Update',
      saving: 'Saving…',
      selected: function (y, m) {
        return y + ' yes' + (m ? ', ' + m + ' if needed' : '');
      },
      noneSelected: 'Mark the times that work for you.',
      editing: 'Editing your answer.',
      thanks: function (n) {
        return 'Thanks, ' + n + '!';
      },
      saved: 'You’ll get the calendar invite by email once a time is chosen.',
      editLink: 'Link to edit your answer:',
      copy: 'Copy',
      copied: 'Link copied',
      change: 'Edit my answer',
      answers: 'Answers',
      participant: 'Participant',
      total: 'Available',
      ifNeeded: 'if needed',
      people: function (n) {
        return n + (n === 1 ? ' answer' : ' answers');
      },
      closesOn: 'Answer by ',
      closed: 'This poll is closed',
      scheduled: 'Meeting scheduled',
      startsOn: 'Starting ',
      scheduledText: 'The organiser will send the calendar invite.',
      hidden: 'Answers are private.',
      nameRequired: 'Enter your name.',
      emailRequired: 'Enter a valid email.',
      nameTaken: 'This name is already taken.',
      emailTaken: 'This email has already answered.',
    },
    it: {
      loading: 'Caricamento…',
      notFound: 'Sondaggio non trovato',
      notFoundText: 'Controlla il link che hai ricevuto.',
      inviteOnly: 'Questo sondaggio è solo su invito',
      inviteOnlyText: 'Aprilo dal link personale nella tua email di invito.',
      error: 'Qualcosa è andato storto. Riprova.',
      yes: 'Sì',
      maybe: 'Se serve',
      no: 'No',
      yourDetails: 'I tuoi dati',
      name: 'Nome',
      email: 'Email',
      emailNote: 'Usata solo per l’invito del calendario.',
      yourTz: 'Orari in ',
      organizerTz: 'organizzatore: ',
      allYes: 'Sì a tutto',
      clear: 'Azzera',
      submit: 'Invia',
      update: 'Aggiorna',
      saving: 'Salvataggio…',
      selected: function (y, m) {
        return y + ' sì' + (m ? ', ' + m + ' se serve' : '');
      },
      noneSelected: 'Segna gli orari in cui sei disponibile.',
      editing: 'Stai modificando la tua risposta.',
      thanks: function (n) {
        return 'Grazie, ' + n + '!';
      },
      saved: 'Riceverai l’invito via email quando l’orario sarà scelto.',
      editLink: 'Link per modificare la risposta:',
      copy: 'Copia',
      copied: 'Link copiato',
      change: 'Modifica la risposta',
      answers: 'Risposte',
      participant: 'Partecipante',
      total: 'Disponibili',
      ifNeeded: 'se serve',
      people: function (n) {
        return n + (n === 1 ? ' risposta' : ' risposte');
      },
      closesOn: 'Rispondi entro ',
      closed: 'Il sondaggio è chiuso',
      scheduled: 'Riunione fissata',
      startsOn: 'A partire da ',
      scheduledText: 'L’organizzatore invierà l’invito del calendario.',
      hidden: 'Le risposte sono private.',
      nameRequired: 'Inserisci il tuo nome.',
      emailRequired: 'Inserisci un’email valida.',
      nameTaken: 'Questo nome è già stato usato.',
      emailTaken: 'Questa email ha già risposto.',
    },
  };

  var lang = document.documentElement.lang === 'it' ? 'it' : 'en';
  var T = STRINGS[lang];
  var tz = M.browserTz();
  var params = new URLSearchParams(window.location.search);
  var token = params.get('p') || '';
  var storeKey = 'meet-edit:' + token;
  var view = document.getElementById('voteView');

  // ── Language ──────────────────────────────────────────────────────────────
  // One link is shared for everyone (/meet/?p=…). An inline script in the
  // page's <head> (components/meet-head.njk) already moved to the language
  // picked last time, or the browser's own, before anything was drawn; the
  // IT/EN switch here remembers a new choice and moves between /meet/ and
  // /it/meet/ with the same query.
  var LANG_KEY = 'meet-lang';

  document.querySelectorAll('#langToggle button').forEach(function (button) {
    button.addEventListener('click', function () {
      var code = button.getAttribute('lang');
      try {
        window.localStorage.setItem(LANG_KEY, code);
      } catch (e) {
        /* the switch still works for this visit */
      }
      if (code !== lang) {
        window.location.href = (code === 'it' ? '/it' : '') + '/meet/' + window.location.search;
      }
    });
  });

  function stored() {
    try {
      return window.localStorage.getItem(storeKey);
    } catch (e) {
      return null;
    }
  }

  function forget() {
    try {
      window.localStorage.removeItem(storeKey);
    } catch (e) {
      /* nothing stored */
    }
  }

  function remember(editToken) {
    try {
      window.localStorage.setItem(storeKey, editToken);
    } catch (e) {
      /* the edit link shown on screen still works */
    }
  }

  var editToken = params.get('e') || stored();
  // A guest's personal link to an invite-only poll.
  var inviteToken = params.get('i');
  var poll = null;

  view.appendChild(M.loading(T.loading));
  load();

  function load() {
    var url = '/api/poll?p=' + encodeURIComponent(token);
    if (editToken) url += '&e=' + encodeURIComponent(editToken);
    if (inviteToken) url += '&i=' + encodeURIComponent(inviteToken);
    return M.api('GET', url)
      .then(function (data) {
        poll = data;
        if (editToken && poll.mine) remember(editToken);
        // Not ours any more (e.g. the organiser removed the answer): forget it,
        // so this browser can answer afresh.
        if (editToken && !poll.mine) {
          editToken = null;
          forget();
        }
        renderHeader();
        if (poll.open) renderForm();
        else renderClosed();
      })
      .catch(function (err) {
        var invite = err.code === 'invite_required';
        document.getElementById('pollTitle').textContent = invite
          ? T.inviteOnly
          : err.status === 404
          ? T.notFound
          : T.error;
        M.clear(view).appendChild(
          h(
            'div',
            { class: 'empty-state' },
            h(
              'p',
              { style: 'margin-bottom:0' },
              invite ? T.inviteOnlyText : err.status === 404 ? T.notFoundText : err.message
            )
          )
        );
      });
  }

  function renderHeader() {
    document.title = poll.title + ' | AI Safety for Italy';
    document.getElementById('pollTitle').textContent = poll.title;
    M.clear(document.getElementById('pollMeta')).appendChild(
      h(
        'div',
        { style: 'display:contents' },
        h('span', null, M.icon('clock'), M.fmtDuration(poll.durationMinutes)),
        poll.recurrence
          ? h(
              'span',
              { class: 'repeat' },
              M.icon('repeat'),
              M.recurrenceText(poll.recurrence, poll.finalSlot ? poll.finalSlot.start : null, tz)
            )
          : null,
        poll.location ? h('span', null, M.icon('pin'), M.linkify(poll.location)) : null,
        h('span', null, M.icon('users'), T.people(poll.responseCount)),
        poll.deadline && poll.open
          ? h('span', null, M.icon('hourglass'), T.closesOn + M.fmtDateTime(poll.deadline, tz))
          : null
      )
    );
    var desc = document.getElementById('pollDescription');
    M.clear(desc);
    if (poll.description) {
      desc.appendChild(M.linkify(poll.description));
      desc.hidden = false;
    }
  }

  // ── Closed / scheduled ────────────────────────────────────────────────────

  function renderClosed() {
    M.clear(view);
    if (poll.finalSlot) {
      var s = poll.finalSlot;
      view.appendChild(
        h(
          'div',
          { class: 'final-card' },
          h(
            'div',
            { class: 'cal', 'aria-hidden': 'true' },
            h('span', { class: 'm' }, M.fmt(s.start, tz, { month: 'short' })),
            h('span', { class: 'd' }, M.fmt(s.start, tz, { day: 'numeric' }))
          ),
          h(
            'div',
            null,
            h('span', { class: 'label-mono', style: 'color:rgba(255,255,255,.75)' }, T.scheduled),
            h(
              'h2',
              null,
              (poll.recurrence
                ? M.recurrenceText(poll.recurrence, s.start, tz)
                : M.fmtDay(s.start, tz)) +
                ', ' +
                M.fmtTime(s.start, tz) +
                '–' +
                M.fmtTime(s.end, tz)
            ),
            poll.recurrence ? h('p', null, T.startsOn + M.fmtDay(s.start, tz)) : null,
            h('p', null, T.scheduledText)
          )
        )
      );
    } else {
      view.appendChild(
        h('div', { class: 'empty-state' }, h('h3', { style: 'margin:0' }, T.closed))
      );
    }
    appendAnswers();
  }

  function appendAnswers() {
    if (!poll.responses) {
      view.appendChild(h('p', { class: 'panel-note', style: 'margin-top:1.5rem' }, T.hidden));
      return;
    }
    if (!poll.responses.length) return;
    view.appendChild(
      h(
        'div',
        { style: 'margin-top:2.5rem' },
        h('h2', { style: 'font-size:1.35rem' }, T.answers),
        M.resultsTable(poll, {
          tz: tz,
          finalSlotId: poll.finalSlot && poll.finalSlot.id,
          labels: { name: T.participant, total: T.total, maybe: T.ifNeeded },
        })
      )
    );
  }

  // ── Answer form ───────────────────────────────────────────────────────────

  function renderForm() {
    var votes = {};
    poll.slots.forEach(function (s) {
      votes[s.id] = poll.mine ? poll.mine.votes[s.id] || 0 : 0;
    });
    var maxYes = 0;
    poll.slots.forEach(function (s) {
      maxYes = Math.max(maxYes, (s.yes || 0) + (s.maybe || 0));
    });

    var nameInput = h('input', {
      class: 'form-input is-compact',
      id: 'voteName',
      maxlength: 100,
      autocomplete: 'name',
      required: true,
      value: poll.mine ? poll.mine.name : '',
    });
    var emailInput = h('input', {
      class: 'form-input is-compact',
      id: 'voteEmail',
      type: 'email',
      maxlength: 254,
      autocomplete: 'email',
      required: true,
      // A guest answers as the address they were invited at.
      value: poll.invite ? poll.invite.email : poll.mine ? poll.mine.email : '',
      readonly: Boolean(poll.invite),
    });
    var error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    var nameError = h('p', { class: 'field-error', id: 'voteNameError', hidden: true });
    var emailError = h('p', { class: 'field-error', id: 'voteEmailError', hidden: true });

    function markField(input, message, holder) {
      input.classList.toggle('is-invalid', Boolean(message));
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message) input.setAttribute('aria-describedby', holder.id);
      else input.removeAttribute('aria-describedby');
      holder.textContent = message || '';
      holder.hidden = !message;
    }

    function validEmail(value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
    }

    // A name or email someone else already answered with is flagged while it
    // is typed, and blocks sending until it is changed. `taken` is what the
    // server last said about the current values.
    var taken = { name: false, email: false };
    var checkTimer;
    var checkSeq = 0;

    // Each field's message is either nothing, "required" (set on submit) or
    // "taken" (set from the server); a taken flag clears once the server says
    // the new value is free.
    function refreshFields() {
      [
        [nameInput, nameError, taken.name, T.nameTaken],
        [emailInput, emailError, taken.email, T.emailTaken],
      ].forEach(function (f) {
        if (f[2]) {
          f[1].dataset.kind = 'taken';
          markField(f[0], f[3], f[1]);
        } else if (f[1].dataset.kind === 'taken') {
          f[1].dataset.kind = '';
          markField(f[0], null, f[1]);
        }
      });
      submit.disabled = taken.name || taken.email;
    }

    function checkTaken() {
      var name = nameInput.value.trim();
      var email = validEmail(emailInput.value) ? emailInput.value.trim() : '';
      var seq = ++checkSeq;
      if (!name && !email) {
        taken = { name: false, email: false };
        refreshFields();
        return Promise.resolve();
      }
      var url =
        '/api/poll?check=1&p=' +
        encodeURIComponent(token) +
        '&name=' +
        encodeURIComponent(name) +
        '&email=' +
        encodeURIComponent(email);
      if (editToken) url += '&e=' + encodeURIComponent(editToken);
      if (inviteToken) url += '&i=' + encodeURIComponent(inviteToken);
      return M.api('GET', url).then(
        function (res) {
          if (seq !== checkSeq) return; // a newer check is on its way
          taken = { name: res.nameTaken, email: res.emailTaken };
          refreshFields();
        },
        function () {
          /* the server checks again on submit */
        }
      );
    }

    function scheduleCheck() {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(checkTaken, 350);
    }

    [nameInput, emailInput].forEach(function (input) {
      input.addEventListener('input', function () {
        // Clear a "required" flag as soon as the field is filled in.
        var holder = input === nameInput ? nameError : emailError;
        if (holder.dataset.kind === 'required') {
          var ok = input === nameInput ? input.value.trim() : validEmail(input.value);
          if (ok) {
            holder.dataset.kind = '';
            markField(input, null, holder);
          }
        }
        scheduleCheck();
      });
      input.addEventListener('blur', function () {
        clearTimeout(checkTimer);
        checkTaken();
      });
    });
    var counter = h('p');
    var submit = h(
      'button',
      { class: 'btn btn-primary', type: 'submit' },
      poll.mine ? T.update : T.submit
    );
    var slotRows = {};

    function seg(slot) {
      var group = h('div', {
        class: 'seg',
        role: 'group',
        'aria-label': M.fmtDateTime(slot.start, tz),
      });
      [
        [2, '✓', T.yes],
        [1, '~', T.maybe],
        [0, '✕', T.no],
      ].forEach(function (opt) {
        group.appendChild(
          h(
            'button',
            {
              type: 'button',
              'data-v': opt[0],
              'aria-pressed': String(votes[slot.id] === opt[0]),
              title: opt[2],
              onclick: function () {
                setVote(slot.id, opt[0]);
              },
            },
            h('span', { 'aria-hidden': 'true' }, opt[1]),
            h('span', { class: 'seg-label' }, opt[2])
          )
        );
      });
      return group;
    }

    function setVote(slotId, v) {
      votes[slotId] = v;
      var row = slotRows[slotId];
      row.setAttribute('data-value', v);
      row.querySelectorAll('.seg button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-v')) === v));
      });
      updateCounter();
    }

    function updateCounter() {
      var y = 0;
      var m = 0;
      Object.keys(votes).forEach(function (k) {
        if (votes[k] === 2) y++;
        else if (votes[k] === 1) m++;
      });
      counter.textContent = y || m ? T.selected(y, m) : T.noneSelected;
    }

    function slotRow(slot) {
      var others = poll.responses
        ? h(
            'div',
            { class: 'vote-bar' },
            h(
              'div',
              { class: 'vote-bar-track', 'aria-hidden': 'true' },
              h('span', { class: 'yes', style: 'width:' + pct(slot.yes) + '%' }),
              h('span', { class: 'maybe', style: 'width:' + pct(slot.maybe) + '%' })
            ),
            h('span', null, (slot.yes || 0) + ' ✓' + (slot.maybe ? ' · ' + slot.maybe + ' ~' : ''))
          )
        : h('div');
      var row = h(
        'div',
        { class: 'vote-slot', 'data-value': votes[slot.id] },
        h(
          'div',
          { class: 'vote-time' },
          M.fmtTime(slot.start, tz),
          h('small', null, '→ ' + M.fmtTime(slot.end, tz))
        ),
        others,
        seg(slot)
      );
      slotRows[slot.id] = row;
      return row;
    }

    function pct(n) {
      return poll.responseCount ? ((n || 0) / Math.max(poll.responseCount, maxYes)) * 100 : 0;
    }

    function setAll(v) {
      poll.slots.forEach(function (s) {
        setVote(s.id, v);
      });
    }

    var form = h(
      'form',
      { novalidate: true },
      h(
        'div',
        { class: 'vote-layout' },
        h(
          'div',
          null,
          h(
            'div',
            { class: 'vote-quick' },
            h(
              'button',
              {
                type: 'button',
                class: 'link-button',
                onclick: function () {
                  setAll(2);
                },
              },
              T.allYes
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'link-button',
                onclick: function () {
                  setAll(0);
                },
              },
              T.clear
            )
          ),
          M.groupByDay(poll.slots, tz).map(function (g) {
            return h(
              'div',
              { class: 'vote-day' },
              h('h3', { class: 'vote-day-title' }, g.label),
              g.slots.map(slotRow)
            );
          })
        ),
        h(
          'aside',
          { class: 'vote-side' },
          h(
            'div',
            { class: 'panel form-grid' },
            h('h2', { style: 'font-size:1.2rem;margin:0' }, T.yourDetails),
            poll.mine ? h('p', { class: 'panel-note' }, T.editing) : null,
            h(
              'div',
              null,
              h('label', { class: 'form-label', for: 'voteName' }, T.name),
              nameInput,
              nameError
            ),
            h(
              'div',
              null,
              h('label', { class: 'form-label', for: 'voteEmail' }, T.email),
              emailInput,
              emailError,
              h('p', { class: 'form-note', style: 'margin-top:.4rem;font-size:.8rem' }, T.emailNote)
            ),
            h(
              'p',
              { class: 'panel-note', style: 'font-size:.8rem' },
              M.icon('globe'),
              ' ',
              T.yourTz + M.tzLabel(tz),
              tz !== poll.timezone ? ' (' + T.organizerTz + M.tzLabel(poll.timezone) + ')' : ''
            )
          )
        )
      ),
      error,
      h('div', { class: 'action-bar' }, counter, submit)
    );

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      error.hidden = true;
      var nameBad = !nameInput.value.trim();
      var emailBad = !validEmail(emailInput.value);
      nameError.dataset.kind = nameBad ? 'required' : '';
      emailError.dataset.kind = emailBad ? 'required' : '';
      if (nameBad) markField(nameInput, T.nameRequired, nameError);
      if (emailBad) markField(emailInput, T.emailRequired, emailError);
      if (nameBad || emailBad || taken.name || taken.email) {
        refreshFields();
        var target = nameBad || taken.name ? nameInput : emailInput;
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.focus({ preventScroll: true });
        return;
      }
      submit.disabled = true;
      submit.textContent = T.saving;
      M.api('POST', '/api/poll?p=' + encodeURIComponent(token), {
        name: nameInput.value,
        email: emailInput.value,
        votes: votes,
        editToken: editToken || undefined,
        inviteToken: inviteToken || undefined,
      })
        .then(function (res) {
          editToken = res.editToken;
          remember(editToken);
          return load().then(function () {
            renderThanks(nameInput.value.trim());
          });
        })
        .catch(function (err) {
          submit.textContent = poll.mine ? T.update : T.submit;
          submit.disabled = false;
          if (err.field === 'name' || err.field === 'email') {
            taken[err.field] = true;
            refreshFields();
            var input = err.field === 'name' ? nameInput : emailInput;
            input.scrollIntoView({ block: 'center', behavior: 'smooth' });
            input.focus({ preventScroll: true });
          } else {
            fail(err.message);
          }
        });
    });

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
      error.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    updateCounter();
    M.clear(view).appendChild(form);
    appendAnswers();
  }

  function renderThanks(name) {
    // A guest's personal link already lets them change their answer.
    var link =
      window.location.origin +
      window.location.pathname +
      '?p=' +
      encodeURIComponent(token) +
      (inviteToken
        ? '&i=' + encodeURIComponent(inviteToken)
        : '&e=' + encodeURIComponent(editToken));
    var input = h('input', { class: 'form-input is-compact', readonly: true, value: link });
    M.clear(view).appendChild(
      h(
        'div',
        { class: 'panel success-card' },
        h('div', { class: 'success-icon' }, M.icon('check')),
        h('h2', null, T.thanks(name)),
        h('p', { class: 'lede', style: 'margin:0 auto 1.5rem' }, T.saved),
        h('p', { class: 'panel-note', style: 'margin-bottom:.5rem' }, T.editLink),
        h(
          'div',
          { class: 'copy-field', style: 'max-width:560px;margin:0 auto 1.25rem' },
          input,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              onclick: function () {
                M.copy(link, T.copied);
              },
            },
            T.copy
          )
        ),
        poll.open
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-secondary btn-sm',
                onclick: function () {
                  renderForm();
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                },
              },
              T.change
            )
          : null
      )
    );
    appendAnswers();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
})();
