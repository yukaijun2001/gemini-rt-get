const slotsEl = document.getElementById('slots');
const slotTemplate = document.getElementById('slot');
const startAllBtn = document.getElementById('startAll');
const addSlotBtn = document.getElementById('addSlot');
const clearBtn = document.getElementById('clear');
const summaryEl = document.getElementById('summary');
const liveEl = document.getElementById('live');
const addrBtn = document.getElementById('addr');

let slots = [];
let latestJobs = [];
let concurrency = 2;
let seq = 0;

const STATUS_LABEL = { queued: '排队中', running: '进行中', success: '成功', failed: '失败' };

function spinner() {
  return '<span class="spinner"></span>';
}

function isActive(job) {
  return job && (job.status === 'running' || job.status === 'queued');
}

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

function createSlot({ line = '', jobId = null, submitting = false } = {}) {
  const el = slotTemplate.content.firstElementChild.cloneNode(true);
  const slot = {
    key: ++seq,
    line,
    jobId,
    submitting,
    job: null,
    error: '',
    el,
    input: el.querySelector('.line'),
    run: el.querySelector('.run'),
    remove: el.querySelector('.remove'),
    index: el.querySelector('.slot-index'),
    email: el.querySelector('.slot-email'),
    badge: el.querySelector('.badge'),
    stage: el.querySelector('.stage'),
    stageText: el.querySelector('.stage-text'),
    elapsed: el.querySelector('.elapsed'),
    progress: el.querySelector('.progress'),
    rtRow: el.querySelector('.rt-row'),
    rt: el.querySelector('.rt'),
    copy: el.querySelector('.copy'),
    errorEl: el.querySelector('.error'),
    actions: el.querySelector('.slot-actions'),
    reset: el.querySelector('.reset')
  };

  slot.input.value = line;
  slot.input.addEventListener('input', () => {
    slot.line = slot.input.value;
    updateSlot(slot);
    maybeAddSlot();
  });
  slot.input.addEventListener('keydown', event => {
    if (event.key === 'Enter') startSlot(slot);
  });
  slot.run.addEventListener('click', () => startSlot(slot));
  slot.remove.addEventListener('click', () => removeSlot(slot));
  slot.reset.addEventListener('click', () => resetSlot(slot));
  slot.copy.addEventListener('click', async () => {
    const value = slot.rt.value;
    if (!value) return;
    try {
      await copyText(value);
      flash(slot.copy);
    } catch {
      slot.rt.select();
    }
  });

  slotsEl.append(el);
  slots.push(slot);
  updateSlot(slot);
  return slot;
}

function updateSlot(slot) {
  const job = slot.job;
  const busy = slot.submitting || (job && isActive(job));
  const hasJob = Boolean(job);

  slot.input.parentElement.hidden = Boolean(slot.jobId) || slot.submitting;
  slot.run.disabled = !slot.line.trim();
  slot.remove.hidden = Boolean(slot.jobId) || slot.submitting || slots.length <= 1;

  slot.email.textContent = job?.email || (slot.line ? slot.line.split(/\s*-{3,}\s*/)[0] : '');
  slot.index.textContent = `#${slots.indexOf(slot) + 1}`;

  let label = '空闲';
  let badgeClass = 'badge';
  if (slot.submitting) {
    label = '提交中';
    badgeClass = 'badge queued';
  } else if (slot.jobId && !job) {
    label = '排队中';
    badgeClass = 'badge queued';
  } else if (job) {
    label = STATUS_LABEL[job.status] || job.status;
    badgeClass = `badge ${job.status}`;
  }
  slot.badge.className = badgeClass;
  if (busy || slot.submitting) slot.badge.innerHTML = `${spinner()}${label}`;
  else slot.badge.textContent = label;

  slot.stage.hidden = !job || !job.stage;
  slot.stageText.textContent = job?.stage || '';
  slot.progress.hidden = !(busy || slot.submitting);
  updateElapsed(slot);

  const rt = job?.rt || '';
  if (rt && slot.rt.value !== rt) slot.rt.value = rt;
  slot.rtRow.hidden = !rt;

  slot.errorEl.hidden = !(job?.error || slot.error);
  slot.errorEl.textContent = job?.error || slot.error || '';

  const canReset = job && job.status !== 'running';
  slot.actions.hidden = !canReset;
  slot.reset.textContent = job?.status === 'queued' ? '取消' : '重置';
}

function updateElapsed(slot) {
  const job = slot.job;
  if (!job || !job.startedAt) {
    slot.elapsed.textContent = '';
    return;
  }
  const end = job.finishedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - job.startedAt) / 1000));
  slot.elapsed.textContent = job.status === 'running' ? `运行 ${seconds}s` : `耗时 ${seconds}s`;
}

function updateLive() {
  const running = latestJobs.filter(job => job.status === 'running').length;
  const queued = latestJobs.filter(job => job.status === 'queued').length;
  if (running || queued) {
    liveEl.innerHTML = `${spinner()}并行 ${running}/${concurrency}${queued ? ` · 排队 ${queued}` : ''}`;
    liveEl.className = 'live active';
  } else {
    liveEl.textContent = '待命';
    liveEl.className = 'live';
  }
}

function updateSummary() {
  const success = latestJobs.filter(job => job.status === 'success').length;
  const failed = latestJobs.filter(job => job.status === 'failed').length;
  summaryEl.textContent = `槽位 ${slots.length} · 成功 ${success} · 失败 ${failed}`;
}

function render() {
  for (const job of latestJobs) {
    if (slots.some(slot => slot.jobId === job.id)) continue;
    createSlot({ jobId: job.id, line: job.email ? `${job.email}----` : '' });
  }

  for (const slot of slots) {
    slot.job = slot.jobId ? latestJobs.find(job => job.id === slot.jobId) || null : null;
    if (slot.job) {
      slot.submitting = false;
      slot.error = '';
    }
  }

  for (const slot of slots) updateSlot(slot);
  updateLive();
  updateSummary();
}

function renumber() {
  slots.forEach((slot, index) => {
    slot.index.textContent = `#${index + 1}`;
  });
}

function maybeAddSlot() {
  const last = slots[slots.length - 1];
  if (!last || last.jobId || last.submitting || last.line.trim()) createSlot();
}

async function startSlot(slot) {
  if (slot.jobId || slot.submitting) return;
  const text = slot.line.trim();
  if (!text) return;

  slot.submitting = true;
  slot.error = '';
  updateSlot(slot);

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '提交失败');

    for (const id of data.ids || []) {
      const duplicate = slots.find(other => other !== slot && other.jobId === id);
      if (duplicate) removeSlotElement(duplicate);
      slot.jobId = id;
    }
    slot.submitting = false;
    const job = latestJobs.find(item => item.id === slot.jobId);
    if (job) slot.job = job;
    maybeAddSlot();
    render();
  } catch (error) {
    slot.submitting = false;
    slot.error = error.message || '提交失败';
    updateSlot(slot);
  }
}

async function resetSlot(slot) {
  if (!slot.jobId) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(slot.jobId)}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || '重置失败');
    }
    latestJobs = latestJobs.filter(job => job.id !== slot.jobId);
    slot.jobId = null;
    slot.job = null;
    slot.submitting = false;
    slot.error = '';
    slot.rt.value = '';
    updateSlot(slot);
    updateLive();
    updateSummary();
  } catch (error) {
    slot.error = error.message || '重置失败';
    updateSlot(slot);
  }
}

function removeSlotElement(slot) {
  const index = slots.indexOf(slot);
  if (index < 0) return;
  slot.el.remove();
  slots.splice(index, 1);
  if (!slots.length) createSlot();
  renumber();
  updateSummary();
}

function removeSlot(slot) {
  if (slot.jobId || slot.submitting) return;
  removeSlotElement(slot);
}

startAllBtn.addEventListener('click', async () => {
  const targets = slots.filter(slot => !slot.jobId && !slot.submitting && slot.line.trim());
  if (!targets.length) {
    const first = slots.find(slot => !slot.jobId);
    first?.input.focus();
    return;
  }
  startAllBtn.disabled = true;
  try {
    for (const slot of targets) await startSlot(slot);
  } finally {
    startAllBtn.disabled = false;
  }
});

addSlotBtn.addEventListener('click', () => {
  const slot = slots.find(item => !item.jobId && !item.line.trim() && !item.submitting);
  if (slot) slot.input.focus();
  else createSlot().input.focus();
});

clearBtn.addEventListener('click', async () => {
  await fetch('/api/jobs', { method: 'DELETE' });
  const response = await fetch('/api/jobs');
  latestJobs = await response.json().catch(() => []);
  const alive = new Set(latestJobs.map(job => job.id));
  for (const slot of slots) {
    if (slot.jobId && !alive.has(slot.jobId)) {
      slot.jobId = null;
      slot.job = null;
      slot.error = '';
      slot.rt.value = '';
    }
  }
  render();
});

const events = new EventSource('/api/events');
events.onmessage = event => {
  latestJobs = JSON.parse(event.data);
  render();
  maybeAddSlot();
};
events.onerror = () => {
  liveEl.innerHTML = `${spinner()}连接中断，正在重连…`;
  liveEl.className = 'live warn';
};

setInterval(() => {
  for (const slot of slots) updateElapsed(slot);
}, 1000);

async function loadInfo() {
  addrBtn.textContent = location.origin;
  addrBtn.dataset.copy = location.origin;
  try {
    const info = await fetch('/api/info').then(response => response.json());
    concurrency = info.concurrency || concurrency;
    const lanUrl = (info.urls || []).find(url => url !== location.origin);
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (lanUrl && isLocal) {
      addrBtn.textContent = `局域网 ${lanUrl}`;
      addrBtn.dataset.copy = lanUrl;
    }
    updateLive();
  } catch {}
}

addrBtn.addEventListener('click', async () => {
  try {
    await copyText(addrBtn.dataset.copy || location.origin);
    flash(addrBtn, '已复制访问地址');
  } catch {}
});

loadInfo();

setTimeout(() => {
  if (!slots.length) createSlot();
}, 2500);
