// Runs in the page the user clicked the add-on on: lists its empty fields, then types the
// answers. It never submits, never ticks a checkbox and never replaces what is there.
(() => {
  if (window.__jobAgent) return;
  const MAX_FIELDS = 80;
  const MAX_OPTIONS = 80;
  let refs = new Map();
  let pickers = new Map(); // custom dropdown → its choices
  let watched = null; // the fields just listed, to learn from when the user goes on
  const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  // A label's own words, without the choices and buttons inside it.
  const words = (el) => {
    if (!el) return '';
    const c = el.cloneNode(true);
    for (const x of c.querySelectorAll(
      'select, textarea, button, ul, svg, script, style, [role=listbox]',
    ))
      x.remove();
    return txt(c);
  };
  const hidden = (el) => !!el.closest('[aria-hidden="true"], [inert]');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  // Open shadow roots too: several application sites build their forms from web components.
  function* walk(root) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }
  const byId = (el, id) => el.getRootNode().getElementById?.(id) ?? document.getElementById(id);
  const BOX =
    '[role=listitem], .application-question, fieldset, .field, .form-group, [class*="question"], [class*="Field"], [class*="field"], li, label';
  function labelFor(el) {
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map(words).join(' ').trim();
      if (t) return t;
    }
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((i) => txt(byId(el, i)))
        .join(' ')
        .trim();
      if (t) return t;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const box = el.closest(BOX);
    if (box) {
      const h = box.querySelector(
        '[role=heading], legend, .application-label, label, .text, h3, h4, p',
      );
      if (h && words(h)) return words(h);
      if (box.tagName === 'LABEL' && words(box)) return words(box);
    }
    return el.getAttribute('placeholder') || el.name || '';
  }
  // Upload boxes are often bare: the words are on a button next to the hidden input, or only
  // in the names of the boxes around it. Never as far out as another upload box.
  function uploadLabel(el) {
    const own = labelFor(el);
    const names = [];
    let label = own;
    let box = el.parentElement;
    for (let up = 0; box && up < 6; up++, box = box.parentElement) {
      if (box.querySelectorAll('input[type=file]').length > 1) break;
      if (up < 3) names.push(String(box.className || ''), box.id || '');
      if (!label) {
        const c = box.cloneNode(true);
        for (const x of c.querySelectorAll('script, style, svg')) x.remove();
        label = txt(c).slice(0, 200);
      }
    }
    return {
      label,
      hint: `${el.name || el.id || ''} ${names.join(' ')}`.replace(/\s+/g, ' ').trim(),
    };
  }
  // The site's own job search, menus and newsletter boxes are not the application.
  const SITE =
    'header, nav, footer, [role=search], [class*="global-search"], [class*="search-block"], [class*="job-search"], [class*="jobsearch"], [class*="site-search"]';
  const isRequired = (el, label) =>
    !!el.required || el.getAttribute('aria-required') === 'true' || /^\s*[*✱]|[*✱]\s*$/.test(label);

  // The question of a radio group: what its box says besides the choices themselves.
  function groupQuestion(els, choices) {
    let box = els[0].parentElement;
    for (let up = 0; box && up < 7; up++, box = box.parentElement) {
      if (!els.every((e) => box.contains(e))) continue;
      if (box.tagName === 'FORM' || box.tagName === 'BODY') break;
      let rest = words(box);
      for (const c of [...choices].sort((a, b) => b.length - a.length)) rest = rest.replace(c, ' ');
      rest = rest.replace(/\s+/g, ' ').trim();
      if (rest.length > 2) return rest.slice(0, 400);
    }
    const by = els[0].closest('[role=radiogroup], fieldset');
    return (by && by.getAttribute('aria-label')) || els[0].name || '';
  }
  const isCombobox = (el) =>
    el.tagName === 'INPUT' &&
    (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list');
  const choicesOf = (el) => {
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    const list = id ? byId(el, id) : null;
    return list ? [...list.querySelectorAll('[role=option]')].filter(visible) : [];
  };
  const key = (el, k) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        code: k,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  // While the add-on's popup is open the page itself has no focus, so the browser sends no
  // focus events; some widgets wait for them.
  const focusOn = (el) => {
    el.focus();
    if (document.hasFocus()) return;
    el.dispatchEvent(new FocusEvent('focus', { composed: true }));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  };
  // A picker that shows its choice next to the input, not in it.
  const pickedText = (el) => {
    const box = el.closest('[class*="control"]');
    const v =
      box &&
      box.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"]');
    return v ? txt(v) : '';
  };
  const click = (el) => {
    const o = { bubbles: true, composed: true, cancelable: true, button: 0 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
  };
  // Opens a custom dropdown the way a person would: its own button, a key, or a click.
  async function openPicker(el) {
    if (choicesOf(el).length) return choicesOf(el);
    const box = el.closest('[class*="control"]');
    const button = box && box.querySelector('button:not([type="submit"])');
    const ways = [() => key(el, 'ArrowDown'), () => click(box || el)];
    if (button) ways.unshift(() => click(button));
    focusOn(el);
    await sleep(60); // widgets note the focus before they accept a key
    for (const open of ways) {
      open();
      for (let i = 0; i < 3; i++) {
        await sleep(80);
        if (choicesOf(el).length) return choicesOf(el);
      }
    }
    return [];
  }
  // Opens a custom dropdown, reads its choices, closes it again.
  async function readChoices(el) {
    const opts = (await openPicker(el)).map(txt).filter(Boolean);
    key(el, 'Escape');
    el.blur();
    if (!document.hasFocus())
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    return opts.length > 1 && opts.length <= MAX_OPTIONS ? opts : [];
  }

  async function scan() {
    refs = new Map();
    pickers = new Map();
    watched = null;
    const fields = [];
    const groups = new Map();
    let n = 0;
    let kept = 0;
    let boxes = 0;
    const add = (f, ref) => {
      if (fields.length >= MAX_FIELDS) return;
      refs.set(f.id, ref);
      fields.push(f);
    };
    const all = [...walk(document)];
    for (const el of all) {
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') continue;
      const type = tag === 'INPUT' ? el.type || 'text' : tag.toLowerCase();
      if (
        [
          'hidden',
          'submit',
          'button',
          'reset',
          'image',
          'search',
          'password',
          'color',
          'range',
        ].includes(type)
      )
        continue;
      if (el.disabled || el.readOnly || (type !== 'file' && type !== 'radio' && hidden(el)))
        continue;
      const name = (el.name || el.id || '').slice(0, 200);
      if (/captcha|turnstile/i.test(name)) continue;
      if (type === 'checkbox') {
        if (visible(el)) boxes++;
        continue;
      }
      if (type === 'radio') {
        const lab = el.closest('label') || (el.labels && el.labels[0]);
        if (!visible(el) && !(lab && visible(lab))) continue;
        const box = el.closest('[role=radiogroup], [role=group], fieldset, [role=listitem], li');
        const groupKey = el.name || box || el;
        let g = groups.get(groupKey);
        if (!g) {
          g = {
            id: `q${groups.size}`,
            name,
            required: false,
            options: [],
            els: [],
            checked: false,
          };
          groups.set(groupKey, g);
        }
        g.required = g.required || isRequired(el, '');
        g.checked = g.checked || el.checked;
        g.options.push({ id: String(g.els.length), label: (txt(lab) || el.value).slice(0, 200) });
        g.els.push(el);
        continue;
      }
      if (type === 'file') {
        if (el.files && el.files.length) {
          kept++;
          continue;
        }
      } else {
        if (!visible(el)) continue;
        if (String(el.value || '').trim() !== '') {
          kept++;
          continue;
        }
      }
      if (type !== 'file' && el.closest(SITE)) continue;
      const upload = type === 'file' ? uploadLabel(el) : null;
      const label = (upload ? upload.label : labelFor(el)).slice(0, 400);
      if (/^(search|find) /i.test(label)) continue;
      const f = {
        id: `f${n++}`,
        kind:
          tag === 'SELECT'
            ? 'select'
            : tag === 'TEXTAREA'
              ? 'textarea'
              : type === 'file'
                ? 'file'
                : 'text',
        inputType: type.slice(0, 30),
        name: upload ? upload.hint.slice(0, 200) : name,
        label,
        required: isRequired(el, label),
      };
      if (tag === 'SELECT') {
        const opts = [...el.options]
          .map((o, i) => ({ id: String(i), label: txt(o).slice(0, 200), value: o.value }))
          .filter((o) => o.value !== '' && o.label !== '');
        // A long list (countries, cities) is answered as text and matched here.
        if (opts.length > MAX_OPTIONS) f.kind = 'text';
        else f.options = opts.map(({ id, label: l }) => ({ id, label: l }));
      }
      if (isCombobox(el)) {
        if (pickedText(el)) {
          kept++;
          continue;
        }
        const opts = await readChoices(el);
        if (opts.length) {
          f.kind = 'select';
          f.options = opts.map((o, i) => ({ id: String(i), label: o.slice(0, 200) }));
          pickers.set(el, opts);
        }
      }
      add(f, el);
    }
    for (const g of groups.values()) {
      if (g.checked) {
        kept++;
        continue;
      }
      if (g.options.length > MAX_OPTIONS) continue;
      const q = groupQuestion(
        g.els,
        g.options.map((o) => o.label),
      );
      add(
        {
          id: g.id,
          kind: 'radio',
          inputType: 'radio',
          name: g.name,
          label: q,
          required: g.required || isRequired(g.els[0], q),
          options: g.options,
        },
        g.els,
      );
    }
    // A form embedded from another site can't be reached from here: name it instead.
    const frames = all
      .filter((e) => e.tagName === 'IFRAME' && visible(e))
      .map((e) => e.src)
      .filter(
        (s) =>
          /^https:/.test(s) &&
          /greenhouse|lever|ashby|workable|smartrecruiters|bamboohr|recruitee|teamtailor|jobvite|icims|workday|apply|career|job/i.test(
            s,
          ) &&
          !/captcha|challenges\.cloudflare/i.test(s),
      );
    return { url: location.href, fields, kept, boxes, frames: frames.slice(0, 3) };
  }

  const fire = (el, ...types) => {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true, composed: true }));
  };
  // React and others watch the native setter, not assignments on the element.
  function setText(el, value) {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: value,
        inputType: 'insertText',
      }),
    );
    fire(el, 'change');
  }
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  function choose(el, index) {
    const o = el.options[index];
    if (!o) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(
      el,
      index,
    );
    fire(el, 'input', 'change');
    return el.selectedIndex === index;
  }
  // Takes the picker's own choice, from its list or after typing; "Cairo, Egypt" also tries
  // "Cairo". Anything it doesn't offer is left for the user.
  async function combobox(el, value) {
    const wants = [...new Set([value, value.split(',')[0]].map((v) => v.trim()))].filter(Boolean);
    const take = (opts) => {
      for (const want of wants) {
        const starts = opts.filter((o) => txt(o).toLowerCase().startsWith(want.toLowerCase()));
        const pick =
          opts.find((o) => same(txt(o), want)) || (starts.length === 1 ? starts[0] : null);
        if (pick) {
          click(pick);
          return true;
        }
      }
      return false;
    };
    if (take(await openPicker(el))) return true;
    for (const want of wants) {
      focusOn(el);
      setText(el, want);
      for (let i = 0; i < 10; i++) {
        await sleep(150);
        if (take(choicesOf(el))) return true;
      }
    }
    setText(el, '');
    key(el, 'Escape');
    return false;
  }
  function attach(el, file) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], file.name, { type: 'application/pdf' }));
    el.files = dt.files;
    fire(el, 'input', 'change');
    return el.files.length === 1;
  }

  // What a listed field says now, as a person would say it.
  function valueOf(ref) {
    if (Array.isArray(ref)) {
      const el = ref.find((r) => r.checked);
      return el ? txt(el.closest('label') || (el.labels && el.labels[0])) || el.value : '';
    }
    if (!ref.isConnected || ref.type === 'file') return '';
    if (ref.tagName === 'SELECT') {
      const o = ref.options[ref.selectedIndex];
      return o && o.value !== '' ? txt(o) : '';
    }
    return (isCombobox(ref) && pickedText(ref)) || String(ref.value || '').trim();
  }
  const GO_ON =
    /submit|next|continue|save|apply|send|update|review|proceed|finish|تقديم|التالي|إرسال|ارسال|حفظ|متابعة/i;
  function sendLearned() {
    if (!watched) return;
    const items = [];
    for (const [id, f] of watched.fields) {
      const value = valueOf(refs.get(id));
      if (!value || value.length > 400) continue;
      const { label, name, kind, inputType } = f;
      items.push({
        label,
        name,
        kind,
        inputType,
        value,
        source: watched.ours.get(id) === value ? 'kept' : 'typed',
      });
    }
    const key = JSON.stringify(items);
    if (!items.length || key === watched.sent) return;
    watched.sent = key;
    chrome.runtime
      .sendMessage({ type: 'learn', jobId: watched.jobId, url: watched.url, items })
      .catch(() => undefined);
  }
  // Only the user's own click on a button that goes on, or the form's submission.
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted || !watched) return;
      const b = e
        .composedPath()
        .find((x) => x.matches && x.matches('button, [role=button], input[type=submit], a'));
      if (b && GO_ON.test(txt(b) || b.value || b.getAttribute('aria-label') || '')) sendLearned();
    },
    true,
  );
  document.addEventListener('submit', sendLearned, true);

  // Some sites read the CV and fill the form themselves: wait until it stops changing.
  async function settled() {
    const look = () =>
      [...walk(document)]
        .filter((e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && e.type !== 'password')
        .map((e) => `${e.name}=${String(e.value).length}`)
        .join();
    let before = look();
    let quiet = 0;
    for (let t = 0; t < 8000 && (t < 2000 || quiet < 1000); t += 250) {
      await sleep(250);
      const now = look();
      quiet = now === before ? quiet + 250 : 0;
      before = now;
    }
  }

  async function fill({ answers, files, jobId, fields }) {
    let filled = 0;
    let attached = 0;
    const failed = [];
    // Files first: some sites read the CV and fill other fields themselves.
    for (const [id, file] of Object.entries(files)) {
      const el = refs.get(id);
      try {
        if (el && !el.files.length && attach(el, file)) attached++;
        else failed.push(file.name);
      } catch {
        failed.push(file.name);
      }
    }
    if (attached) {
      await settled();
      // The site may redraw the form after reading the CV: find the same fields again.
      const now = [...walk(document)];
      for (const [id, ref] of refs) {
        if (Array.isArray(ref) || ref.isConnected || !(ref.id || ref.name)) continue;
        const twins = now.filter(
          (e) => e.tagName === ref.tagName && e.id === ref.id && e.name === ref.name,
        );
        if (twins.length !== 1) continue;
        if (pickers.has(ref)) pickers.set(twins[0], pickers.get(ref));
        refs.set(id, twins[0]);
      }
    }
    for (const [id, a] of Object.entries(answers)) {
      const ref = refs.get(id);
      if (!ref) continue;
      let ok;
      let label = '';
      try {
        if (Array.isArray(ref)) {
          const el = ref[Number(a.options[0])];
          label = el ? el.name : '';
          if (!el || ref.some((r) => r.checked)) continue;
          (el.closest('label') || el).click();
          if (!el.checked) el.click();
          ok = el.checked;
        } else {
          label = labelFor(ref);
          if (!ref.isConnected) ok = false;
          else if (String(ref.value || '').trim() !== '')
            continue; // filled meanwhile: keep it
          else if (ref.tagName === 'SELECT') {
            const index =
              a.options.length > 0
                ? Number(a.options[0])
                : [...ref.options].findIndex((o) => same(txt(o), a.value || ''));
            ok = index >= 0 && choose(ref, index);
          } else if (isCombobox(ref)) {
            const want = pickers.has(ref) ? pickers.get(ref)[Number(a.options[0])] : a.value;
            ok = want ? await combobox(ref, want) : false;
          } else {
            ref.focus();
            setText(ref, a.value || '');
            fire(ref, 'blur');
            ok = String(ref.value).trim() !== '';
          }
        }
      } catch {
        ok = false;
      }
      if (ok) filled++;
      else failed.push(label || id);
    }
    if (jobId) {
      const learnable = (fields || []).filter((f) => f.kind !== 'file' && f.kind !== 'textarea');
      watched = {
        jobId,
        url: location.href,
        fields: new Map(learnable.map((f) => [f.id, f])),
        ours: new Map(Object.keys(answers).map((id) => [id, valueOf(refs.get(id) || [])])),
        sent: '',
      };
    }
    return { filled, attached, failed };
  }
  window.__jobAgent = { scan, fill };
})();
