// Moves data between the page and the user's own dashboard on 127.0.0.1. Nothing else is
// contacted, and the page is only touched after the user opens the add-on on it.
const DEFAULT_PORT = 8080;

async function api(path, body) {
  const { port } = await chrome.storage.local.get('port');
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port || DEFAULT_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('The dashboard is not running: ./agent.sh dashboard');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `dashboard error ${res.status}`);
  return data;
}

const run = async (tabId, func, args = []) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r.result;
};

async function scan(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page.js'] });
  return run(tabId, () => window.__jobAgent.scan());
}

const status = new Map(); // tab id → what the popup shows
const set = (tabId, s) => {
  status.set(tabId, s);
  chrome.runtime.sendMessage({ type: 'status', tabId, status: s }).catch(() => undefined); // popup closed
};

const learning = async () => (await chrome.storage.local.get('learn')).learn !== false;

async function whatsapp(tabId, jobId) {
  if (status.get(tabId)?.running) return;
  set(tabId, { running: true, text: 'Preparing the message…' });
  try {
    const m = await api('/api/ext/whatsapp', { job_id: jobId });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['whatsapp.js'] });
    const r = await run(tabId, (x) => window.__jobAgentWa.prepare(x), [m]);
    if (r.error) throw new Error(r.error);
    const left = [];
    if (!r.attached) left.push(`attach ${m.file.name} (the job's CV link in the dashboard)`);
    if (!r.wrote) left.push('the message: copy it from the dashboard');
    left.push(
      `check the chat is +${r.phone}${r.title ? ` (shown as ${r.title})` : ''}`,
      'read it, then press Send',
    );
    set(tabId, {
      running: false,
      text: r.attached && r.wrote ? 'CV and message are in. Not sent.' : 'Partly done. Not sent.',
      left,
    });
  } catch (err) {
    set(tabId, { running: false, text: String(err.message || err), error: true });
  }
}

async function fill(tabId, jobId) {
  if (status.get(tabId)?.running) return;
  set(tabId, { running: true, text: 'Reading the form…' });
  try {
    const page = await scan(tabId);
    if (page.fields.length === 0) {
      set(tabId, {
        running: false,
        text: page.frames.length
          ? 'The form is embedded from another site. Open it on its own, then use the add-on there:'
          : page.kept
            ? `Nothing empty to fill (${page.kept} fields already have a value).`
            : 'No form on this page.',
        frames: page.frames,
      });
      return;
    }
    set(tabId, { running: true, text: `Answering ${page.fields.length} fields…` });
    const a = await api('/api/ext/answer', { job_id: jobId, url: page.url, fields: page.fields });
    set(tabId, { running: true, text: 'Typing…' });
    const r = await run(tabId, (x) => window.__jobAgent.fill(x), [
      {
        answers: a.answers,
        files: a.files,
        jobId: (await learning()) ? jobId : 0,
        fields: page.fields.map(({ id, label, name, kind, inputType }) => ({
          id,
          label,
          name,
          kind,
          inputType,
        })),
      },
    ]);
    const left = [...new Set([...a.left, ...r.failed])].filter(Boolean);
    set(tabId, {
      running: false,
      text: `Filled ${r.filled} fields, attached ${r.attached} file${r.attached === 1 ? '' : 's'}${page.kept ? `, kept ${page.kept} you already had` : ''}.`,
      left,
      boxes: page.boxes,
    });
  } catch (err) {
    set(tabId, { running: false, text: String(err.message || err), error: true });
  }
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (m.type === 'learn' && sender.tab) {
    const { jobId, items } = m;
    learning()
      .then(
        (on) => on && api('/api/ext/learn', { job_id: jobId, url: sender.tab.url || m.url, items }),
      )
      .catch(() => undefined);
    return false;
  }
  if (sender.tab) return false; // everything else comes from the popup only
  if (m.type === 'jobs') {
    api('/api/ext/jobs', { url: m.url }).then(reply, (e) => reply({ error: e.message }));
    return true;
  }
  if (m.type === 'fill') (m.whatsapp ? whatsapp : fill)(m.tabId, m.jobId);
  if (m.type === 'get') reply(status.get(m.tabId) || null);
  return false;
});
chrome.tabs.onRemoved.addListener((id) => status.delete(id));
chrome.tabs.onUpdated.addListener((id, c) => c.status === 'loading' && status.delete(id));
