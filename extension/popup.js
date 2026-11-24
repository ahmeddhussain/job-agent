const $ = (id) => document.getElementById(id);
let tabId = null;
let whatsapp = false;

function show(s) {
  if (!s) return;
  $('go').disabled = s.running || !$('job').value;
  $('go').textContent = s.running
    ? 'Working…'
    : whatsapp
      ? 'Put in CV and message'
      : 'Fill what is empty';
  $('msg').className = s.error ? 'error' : '';
  $('msg').textContent = s.text;
  const list = document.createElement('ul');
  for (const l of s.left || []) {
    const li = document.createElement('li');
    li.textContent = l;
    list.append(li);
  }
  if (s.boxes) {
    const li = document.createElement('li');
    li.textContent = `${s.boxes} checkbox${s.boxes === 1 ? '' : 'es'} on the page`;
    list.append(li);
  }
  if (list.childElementCount) $('msg').append(' Left for you:', list);
  for (const f of s.frames || []) {
    const a = document.createElement('a');
    a.href = f;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = new URL(f).hostname;
    const p = document.createElement('div');
    p.append(a);
    $('msg').append(p);
  }
}

const go = () => {
  show({ running: true, text: 'Starting…' });
  chrome.runtime.sendMessage({ type: 'fill', whatsapp, tabId, jobId: Number($('job').value) });
};

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  $('port').value = (await chrome.storage.local.get('port')).port || 8080;
  $('learn').checked = (await chrome.storage.local.get('learn')).learn !== false;
  const r = await chrome.runtime.sendMessage({ type: 'jobs', url: tab.url || '' });
  if (r.error || r.refused || !r.jobs.length)
    return show({
      text: r.error || r.refused || 'No job is waiting for you to apply.',
      error: true,
    });
  whatsapp = r.whatsapp;
  if (whatsapp) $('go').textContent = 'Put in CV and message';
  const pick = new Option('Choose the job…', '');
  $('job').append(pick);
  for (const j of r.jobs)
    $('job').append(new Option(`${j.title}${j.company ? ` · ${j.company}` : ''}`, String(j.id)));
  if (r.job_id) $('job').value = String(r.job_id);
  $('go').disabled = !$('job').value;
  const s = await chrome.runtime.sendMessage({ type: 'get', tabId });
  if (s) show(s);
  else if (r.job_id) go(); // clear which job this is: one click is enough
}

$('job').addEventListener('change', () => ($('go').disabled = !$('job').value));
$('go').addEventListener('click', go);
$('port').addEventListener('change', () =>
  chrome.storage.local.set({ port: Number($('port').value) || 8080 }),
);
$('learn').addEventListener('change', () =>
  chrome.storage.local.set({ learn: $('learn').checked }),
);
chrome.runtime.onMessage.addListener(
  (m) => m.type === 'status' && m.tabId === tabId && show(m.status),
);
start().catch((e) => show({ text: e.message, error: true }));
