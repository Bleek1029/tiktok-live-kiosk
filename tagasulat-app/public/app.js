(() => {
  const $ = (id) => document.getElementById(id);
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const time = (t) => new Date(t).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

  let state = { session: null, blacklist: [], badges: {}, totals: null };
  let seenOrders = new Set();
  let firstRender = true;
  let lastLabelId = null;

  async function api(url, method = 'GET', body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'Something went wrong.'); throw new Error(data.error); }
    return data;
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // element helper (uses textContent, so usernames can't inject HTML)
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'onclick') e.addEventListener('click', v);
      else e.setAttribute(k, v);
    }
    kids.flat().forEach((k) => e.append(k instanceof Node ? k : document.createTextNode(k)));
    return e;
  }

  // ---------- render ----------
  function render() {
    const s = state.session;
    const running = !!s;
    $('startBtn').hidden = running;
    $('endBtn').hidden = !running;

    const line = $('sessionLine');
    line.replaceChildren();
    if (running) line.append(el('span', { class: 'live-dot' }), s.name + ' · started ' + time(s.startedAt));
    else line.append('No live running');

    // stats
    const t = state.totals || { orders: 0, pieces: 0, buyers: 0, value: 0 };
    $('stats').replaceChildren(
      ...[['Orders', t.orders], ['Pieces', t.pieces], ['Buyers', t.buyers], ['Total', peso(t.value)]].map(([l, v]) =>
        el('div', { class: 'stat' }, el('b', {}, String(v)), el('span', {}, l)))
    );

    renderFeed(s);
    renderBoard(s);
    renderItems(s);
    renderBans();
    firstRender = false;
  }

  function renderFeed(s) {
    const feed = $('feed');
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    feed.replaceChildren();
    if (!s) { feed.append(el('li', { class: 'empty' }, 'Start a live session to begin recording.')); return; }
    if (!s.chat.length) feed.append(el('li', { class: 'empty' }, 'Waiting for comments…'));
    s.chat.slice(-120).forEach((c) => {
      feed.append(el('li', { class: (c.pinned ? 'pinned ' : '') + (c.blocked ? 'blocked' : '') }, el('b', {}, c.user), c.text));
    });
    if (nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  function renderBoard(s) {
    const cols = { mine: [], confirmed: [], checked_out: [] };
    if (s) s.orders.forEach((o) => { if (cols[o.status]) cols[o.status].push(o); });
    for (const [status, list] of Object.entries(cols)) {
      $('n-' + status).textContent = list.length;
      const box = $('col-' + status);
      box.replaceChildren();
      if (!list.length) box.append(el('p', { class: 'empty' }, status === 'mine' ? 'New pins land here.' : 'Nothing yet.'));
      list.slice().reverse().forEach((o) => box.append(card(o)));
    }
    seenOrders = new Set(s ? s.orders.map((o) => o.id) : []);
  }

  function card(o) {
    const fresh = !firstRender && !seenOrders.has(o.id);
    const badge = state.badges[o.user] || o.badge;
    const total = o.price != null ? peso(o.price * o.qty) : 'no price';
    const acts = [];
    if (o.status === 'mine') acts.push(btn('Confirm', () => confirmOrder(o), true));
    if (o.status === 'confirmed') {
      acts.push(btn('Checked out', () => setStatus(o, 'checked_out'), true));
      acts.push(btn('Reprint', () => printLabel(o)));
    }
    if (o.status !== 'checked_out') acts.push(btn('Qty +', () => api(`/api/orders/${o.id}/edit`, 'POST', { qty: o.qty + 1 })));
    if (o.status === 'checked_out') acts.push(btn('Undo', () => setStatus(o, 'confirmed')));
    acts.push(btn('Cancel', () => setStatus(o, 'cancelled')));
    acts.push(btn('Ban', () => ban(o.user)));

    return el('article', { class: 'card' + (fresh ? ' fresh' : '') },
      el('div', { class: 'pin' }, '#' + o.pin),
      el('div', { class: 'who' }, '@' + o.user, el('span', { class: 'badge ' + badge }, badge)),
      el('div', { class: 'meta' }, el('span', { class: 'qty' }, '×' + o.qty), ' ' + (o.item || 'Item #' + o.pin) + ' · ' + total),
      el('div', { class: 'acts' }, acts)
    );
  }
  const btn = (label, fn, primary) => el('button', { class: 'btn sm' + (primary ? ' primary' : ''), onclick: fn }, label);

  function renderItems(s) {
    const ul = $('itemList');
    ul.replaceChildren();
    const items = s ? Object.entries(s.items) : [];
    if (!items.length) { ul.append(el('li', { class: 'empty' }, 'No prices yet. Add a pin number, item, and price.')); return; }
    items.sort((a, b) => a[0] - b[0]).forEach(([pin, it]) => {
      ul.append(el('li', {}, el('span', {}, `#${pin} ${it.name} · ${peso(it.price)}`),
        el('button', { onclick: () => api('/api/items/' + pin, 'DELETE') }, 'Remove')));
    });
  }

  function renderBans() {
    const ul = $('banList');
    ul.replaceChildren();
    if (!state.blacklist.length) { ul.append(el('li', { class: 'empty' }, 'No banned buyers.')); return; }
    state.blacklist.forEach((b) => {
      ul.append(el('li', {}, el('span', {}, '@' + b.user + (b.reason ? ' · ' + b.reason : '')),
        el('button', { onclick: () => api('/api/blacklist/' + encodeURIComponent(b.user), 'DELETE') }, 'Unban')));
    });
  }

  // ---------- actions ----------
  async function setStatus(o, status) { await api(`/api/orders/${o.id}/status`, 'POST', { status }); }

  async function confirmOrder(o) {
    await setStatus(o, 'confirmed');
    showLabel(o);
    if ($('autoPrint').checked) printLabel(o);
  }

  async function ban(user) {
    if (!confirm(`Ban @${user}? Their open "mine" orders will be cancelled.`)) return;
    await api('/api/blacklist', 'POST', { user, reason: 'Banned during live' });
  }

  function labelNodes(o) {
    return [
      el('div', { class: 'big' }, '#' + o.pin),
      el('div', { class: 'user' }, '@' + o.user),
      el('hr'),
      el('div', { class: 'row' }, el('span', {}, o.item || 'Item #' + o.pin), el('span', {}, '×' + o.qty)),
      o.price != null ? el('div', { class: 'row' }, el('span', {}, 'Total'), el('b', {}, peso(o.price * o.qty))) : '',
      el('hr'),
      el('div', { class: 'row' }, el('span', {}, 'Order ' + o.id), el('span', {}, time(o.t))),
    ];
  }
  function showLabel(o) { lastLabelId = o.id; $('labelPreview').replaceChildren(...labelNodes(o)); }
  function printLabel(o) {
    showLabel(o);
    $('printLabel').replaceChildren(...labelNodes(o));
    window.print();
  }

  // ---------- events ----------
  $('startBtn').onclick = () => { $('sName').value = ''; $('startDlg').showModal(); $('sName').focus(); };
  $('startCancel').onclick = () => $('startDlg').close();
  $('startForm').onsubmit = async (e) => {
    e.preventDefault();
    await api('/api/session/start', 'POST', { name: $('sName').value });
    $('startDlg').close();
  };
  $('endBtn').onclick = async () => {
    if (confirm('End this live? Orders are saved in History.')) await api('/api/session/end', 'POST');
  };

  $('composeForm').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('cText').value.trim();
    if (!text) return;
    await api('/api/chat', 'POST', { user: $('cUser').value || 'guest', text });
    $('cText').value = '';
    $('cText').focus();
  };

  $('itemForm').onsubmit = async (e) => {
    e.preventDefault();
    await api('/api/items', 'POST', { pin: $('iPin').value, name: $('iName').value, price: $('iPrice').value });
    $('iPin').value = $('iName').value = $('iPrice').value = '';
    $('iPin').focus();
  };

  $('historyBtn').onclick = async () => {
    const list = await api('/api/history');
    const body = $('historyBody');
    body.replaceChildren();
    if (!list.length) body.append(el('p', { class: 'empty' }, 'No lives recorded yet.'));
    list.forEach((h) => body.append(el('div', { class: 'hist' },
      el('b', {}, h.name),
      el('b', {}, peso(h.totals.value)),
      el('small', {}, new Date(h.startedAt).toLocaleString('en-PH') + (h.endedAt ? '' : ' · running')),
      el('small', {}, `${h.totals.orders} orders · ${h.totals.buyers} buyers`))));
    $('historyDlg').showModal();
  };

  // fake buyers for testing
  const names = ['maria_clara', 'jun_the_thrifter', 'ate_gina', 'kuya_bong', 'lei.shops', 'mj_cabrera', 'tita_baby', 'rhea_o', 'paolo22', 'janelle_c'];
  const lines = ['mine 1', 'm2', '#3 x2', 'mine 4', 'hello po!', 'pin 5 2pcs', 'mine 1', 'how much po?', 'm6', 'mine 7'];
  let simTimer = null;
  $('simToggle').onchange = (e) => {
    clearInterval(simTimer);
    if (!e.target.checked) return;
    simTimer = setInterval(() => {
      if (!state.session) return;
      const user = names[Math.floor(Math.random() * names.length)];
      const text = lines[Math.floor(Math.random() * lines.length)];
      fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, text }) });
    }, 2200);
  };

  // ---------- live updates ----------
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => { state = JSON.parse(m.data); render(); };
  es.onerror = () => toast('Connection lost. Retrying…');
})();
