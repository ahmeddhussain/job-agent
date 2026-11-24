// Runs on web.whatsapp.com after the user clicks the add-on there: puts the CV and the message
// into the open chat. It never presses Send or Enter, and reads nothing but the chat's title.
(() => {
  if (window.__jobAgentWa) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const compose = () => document.querySelector('#main footer [contenteditable="true"]');
  async function until(what, ms) {
    for (let t = 0; t < ms; t += 200) {
      const v = what();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }
  const data = () => new DataTransfer();
  const paste = (el, dt) =>
    el.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  function drop(el, dt) {
    for (const t of ['dragenter', 'dragover', 'drop'])
      el.dispatchEvent(
        new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }),
      );
  }
  // The preview WhatsApp opens for a file has its own message box.
  const caption = () =>
    [...document.querySelectorAll('[contenteditable="true"]')].find(
      (e) => !e.closest('footer') && !e.closest('#side') && e.getBoundingClientRect().height > 0,
    );
  async function write(el, text) {
    el.focus();
    const dt = data();
    dt.setData('text/plain', text);
    paste(el, dt);
    const start = text.slice(0, 15);
    if (await until(() => (el.innerText || '').includes(start), 1500)) return true;
    document.execCommand('insertText', false, text.replace(/\n+/g, ' '));
    return !!(await until(() => (el.innerText || '').includes(start), 1000));
  }

  async function prepare({ phone, text, file }) {
    const box = await until(compose, 25000);
    if (!box)
      return {
        error: 'No open chat. Wait until it has loaded, or check the number is on WhatsApp.',
      };
    // An unsaved number is its own title: it must be the job's. A name can't be checked here.
    const header = document.querySelector('#main header');
    const title = ((header && header.innerText) || '').split('\n').find((x) => x.trim()) || '';
    const digits = title.replace(/\D/g, '');
    if (/^[+\d\s()-]+$/.test(title.trim()) && digits && digits !== phone)
      return {
        error: `The open chat is ${title}, not the job's number (+${phone}). Open it from the dashboard again.`,
      };
    if ((box.innerText || '').trim())
      return { error: 'The message box already has text. Send or clear it, then click again.' };

    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const pdf = () => {
      const dt = data();
      dt.items.add(new File([bytes], file.name, { type: 'application/pdf' }));
      return dt;
    };
    box.focus();
    paste(box, pdf());
    let cap = await until(caption, 4000);
    if (!cap) {
      drop(document.querySelector('#main'), pdf());
      cap = await until(caption, 4000);
    }
    const target = cap || box;
    const wrote = text ? await write(target, text) : true;
    return { attached: !!cap, wrote, title, phone };
  }
  window.__jobAgentWa = { prepare };
})();
