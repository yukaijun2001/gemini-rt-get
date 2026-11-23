const input = document.getElementById('input');
const startBtn = document.getElementById('start');
const clearBtn = document.getElementById('clear');
const cardsRoot = document.getElementById('cards');
const summary = document.getElementById('summary');
const template = document.getElementById('card');
const addrBtn = document.getElementById('addr');

const nodes = new Map();

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function flash(button, text = '已复制') {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1200);
}

function render(jobs) {
  for (const job of jobs) {
    let node = nodes.get(job.id);
    if (!node) {
      node = template.content.firstElementChild.cloneNode(true);
      node.dataset.id = job.id;
      node.querySelector('.copy').addEventListener('click', async event => {
        const value = node.querySelector('.rt').value;
        if (!value) return;
        try {
          await copyText(value);
          flash(event.currentTarget);
        } catch {
          node.querySelector('.rt').select();
        }
      });
      cardsRoot.append(node);
      nodes.set(job.id, node);
    }

    node.querySelector('.email').textContent = job.email;
    const badge = node.querySelector('.badge');
    badge.textContent = { queued: '排队', running: '进行中', success: '成功', failed: '失败' }[job.status] || job.status;
    badge.className = `badge ${job.status}`;
    node.querySelector('.stage').textContent = job.stage || '';

    const rtInput = node.querySelector('.rt');
    if (job.rt && rtInput.value !== job.rt) rtInput.value = job.rt;
    node.querySelector('.copy').hidden = !job.rt;

    const error = node.querySelector('.error');
    error.hidden = !job.error;
    error.textContent = job.error || '';
  }

  for (const [id, node] of nodes) {
    if (!jobs.some(job => job.id === id)) {
      node.remove();
      nodes.delete(id);
    }
  }

  const success = jobs.filter(job => job.status === 'success').length;
  const failed = jobs.filter(job => job.status === 'failed').length;
  summary.textContent = jobs.length ? `共 ${jobs.length} · 成功 ${success} · 失败 ${failed}` : '等待输入';
}

const events = new EventSource('/api/events');
events.onmessage = event => render(JSON.parse(event.data));

startBtn.addEventListener('click', async () => {
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  startBtn.disabled = true;
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  const data = await response.json().catch(() => ({}));
  startBtn.disabled = false;
  if (!response.ok) {
    summary.textContent = data.message || '提交失败';
    return;
  }
  input.value = '';
  if (window.matchMedia('(max-width: 760px)').matches) {
    cardsRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

clearBtn.addEventListener('click', async () => {
  await fetch('/api/jobs', { method: 'DELETE' });
});

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) startBtn.click();
});

async function showAddress() {
  addrBtn.textContent = location.origin;
  addrBtn.dataset.copy = location.origin;
  try {
    const info = await fetch('/api/info').then(response => response.json());
    const lanUrl = (info.urls || []).find(url => url !== location.origin);
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (lanUrl && isLocal) {
      addrBtn.textContent = `局域网 ${lanUrl}`;
      addrBtn.dataset.copy = lanUrl;
    }
  } catch {}
}

addrBtn.addEventListener('click', async () => {
  try {
    await copyText(addrBtn.dataset.copy || location.origin);
    flash(addrBtn, '已复制访问地址');
  } catch {}
});

showAddress();
