document.addEventListener('DOMContentLoaded', function () {
let CSRF = '';
let SELECTED = null;
let ALL_ROWS = [];
let ITEMS = [];
let ITEM_NAMES = {};

function showMsg(text, type) {
  var el = document.getElementById('msg');
  if (el) { el.textContent = text; el.className = 'msg msg-' + type; }
}
function clearMsg() {
  var el = document.getElementById('msg');
  if (el) { el.textContent = ''; el.className = 'msg'; }
}

function apiCall(path, method, data) {
  var opts = { method: method || 'GET', headers: { 'Accept': 'application/json' } };
  if (data && method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  if (CSRF && method !== 'GET') opts.headers['x-csrf-token'] = CSRF;
  var clean = path.replace(/^\/+/, '');
  return fetch('/api/' + clean, opts).then(function (r) { return r.json(); });
}

function loadData() {
  return Promise.all([
    apiCall('storage'),
    apiCall('admin/items/catalog?limit=3000'),
  ]).then(function (results) {
    var storageResp = results[0];
    var catalogResp = results[1];
    if (storageResp.error && /session expired/i.test(storageResp.error)) {
      showMsg('Console session expired. Sign in to the console first.', 'error');
      return null;
    }
    if (storageResp.error) { showMsg('Load failed: ' + storageResp.error, 'error'); return null; }
    var storageRows = storageResp.rows || storageResp || [];
    populatePlayerFilter(storageRows);
    renderStorage(storageRows);
    renderCatalog(catalogResp.rows || catalogResp || []);
    return storageRows;
  });
}

function autoConnect() {
  fetch('/api/auth/state').then(function (r) { return r.json(); }).then(function (state) {
    if (!state.authenticated || !state.csrfToken) {
      showMsg('Not authenticated. Sign in to the console first.', 'error');
      return;
    }
    CSRF = state.csrfToken;
    document.getElementById('toolPanel').classList.remove('hidden');
    loadData();
  }).catch(function () {
    showMsg('Could not reach the console.', 'error');
  });
}

function refresh() {
  var btn = document.getElementById('btnRefresh');
  btn.disabled = true; btn.textContent = 'Refreshing...'; clearMsg();
  loadData().then(function (rows) {
    btn.disabled = false; btn.textContent = 'Refresh';
    if (rows) showMsg('Refreshed (' + rows.length + ' containers).', 'success');
  }).catch(function (err) {
    btn.disabled = false; btn.textContent = 'Refresh';
    showMsg('Refresh error: ' + err.message, 'error');
  });
}

function populatePlayerFilter(rows) {
  var owners = {};
  rows.forEach(function (r) {
    var name = (r.owner_name || r.owner || '').trim();
    if (!name) return;
    if (!owners[name]) owners[name] = [];
    owners[name].push(containerLabel(r));
  });
  var sel = document.getElementById('playerFilter');
  var previous = sel.value;
  sel.innerHTML = '<option value="__all__">All players (' + rows.length + ' containers)</option>';
  Object.keys(owners).sort().forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    // Per operator direction: show the player-given/resolved container
    // names right in the dropdown, not just a count, so it's clear
    // which containers a given player owns before selecting them.
    opt.textContent = name + ' -- ' + owners[name].join(', ');
    sel.appendChild(opt);
  });
  // Preserve the selected owner filter across a refresh instead of
  // silently resetting to "All players" every time.
  if (previous && Array.from(sel.options).some(function (o) { return o.value === previous; })) {
    sel.value = previous;
  }
}

function renderStorage(rows, filterOwner) {
  ALL_ROWS = rows;
  const tbody = document.getElementById('storageBody');
  tbody.innerHTML = '';
  var owner = filterOwner !== undefined ? filterOwner : document.getElementById('playerFilter').value;
  var filtered = rows;
  if (owner && owner !== '__all__') {
    filtered = rows.filter(function (r) { return (r.owner_name || r.owner || '') === owner; });
  }
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666">No storage containers found</td></tr>';
    return;
  }
  // Sort alphabetically by owner, then container type, then name, so
  // the list is predictable regardless of API row order.
  filtered.sort(function (a, b) {
    var oa = (a.owner_name || a.owner || '').toLowerCase();
    var ob = (b.owner_name || b.owner || '').toLowerCase();
    if (oa !== ob) return oa < ob ? -1 : 1;
    var ta = (a.type || 'placeable').toLowerCase();
    var tb = (b.type || 'placeable').toLowerCase();
    if (ta !== tb) return ta < tb ? -1 : 1;
    var na = containerLabel(a).toLowerCase();
    var nb = containerLabel(b).toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  filtered.forEach(function (r) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.setAttribute('data-id', r.storage_id || r.id || '');
    tr.addEventListener('click', function () { selectContainer(r, tr); });
    const type = r.type || 'placeable';
    const badge = document.createElement('span');
    badge.className = 'status-badge badge-' + type;
    badge.textContent = type;
    const tdType = document.createElement('td');
    tdType.appendChild(badge);
    tr.appendChild(tdType);

    function td(v) { const d = document.createElement('td'); d.textContent = v || '\u2014'; return d; }
    tr.appendChild(td(containerLabel(r)));
    tr.appendChild(td(r.map_name || r.map || ''));
    tr.appendChild(td(r.owner_name || r.owner || ''));

    var items = (r.item_count != null ? r.item_count : '0') + (r.max_item_count != null ? '/' + r.max_item_count : '');
    var tdItems = document.createElement('td');
    tdItems.textContent = items;
    tr.appendChild(tdItems);

    var vol = (r.current_volume != null ? r.current_volume : '0') + (r.max_item_volume != null ? '/' + r.max_item_volume : '');
    var tdVol = document.createElement('td');
    tdVol.textContent = vol;
    tr.appendChild(tdVol);

    tbody.appendChild(tr);
  });
}

function containerLabel(r) {
  var typeName = r.class_name || (r.class || '').replace(/_Placeable$/g, '').replace(/_/g, ' ') || 'Unknown';
  var custom = (r.name || r.display_name || '').trim();
  var description = custom || typeName;
  var dbName = r.storage_id || r.id || '';
  return description + (dbName ? ' (' + dbName + ')' : '');
}

function selectContainer(r, tr) {
  document.querySelectorAll('#storageBody tr.selected').forEach(function (el) { el.classList.remove('selected'); });
  if (tr) tr.classList.add('selected');
  SELECTED = r;
  document.getElementById('selectedInfo').textContent = containerLabel(r) + ' owned by ' + (r.owner_name || r.owner || '?');
  loadItems();
}

function loadItems() {
  if (!SELECTED) return;
  var sid = SELECTED.storage_id || SELECTED.id;
  var panel = document.getElementById('itemPanel');
  var info = document.getElementById('itemContainerInfo');
  var countEl = document.getElementById('itemCount');
  var tbody = document.getElementById('itemBody');
  var emptyBtn = document.getElementById('btnEmptyContainer');

  info.textContent = 'Loading\u2026';
  panel.style.display = '';
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#666">Loading items\u2026</td></tr>';

  apiCall('storage/' + encodeURIComponent(sid) + '/items').then(function (resp) {
    if (resp.error && /session expired/i.test(resp.error)) {
      clearSession();
      showMsg('Session expired. Reconnect below.', 'error');
      showDisconnected();
      return;
    }
    if (resp.error) {
      info.textContent = 'Error: ' + resp.error;
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#d47c7c">' + resp.error + '</td></tr>';
      emptyBtn.disabled = true;
      document.getElementById('btnRemoveSelected').disabled = true;
      document.getElementById('selectAllItems').checked = false;
      document.getElementById('selectAllItems').disabled = true;
      ITEMS = [];
      countEl.textContent = '0 items';
      return;
    }
    ITEMS = resp.rows || [];
    renderItems(ITEMS);
  }).catch(function (err) {
    info.textContent = 'Fetch error';
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#d47c7c">' + err.message + '</td></tr>';
  });
}

function renderItems(rows) {
  var info = document.getElementById('itemContainerInfo');
  var countEl = document.getElementById('itemCount');
  var tbody = document.getElementById('itemBody');
  var emptyBtn = document.getElementById('btnEmptyContainer');
  var removeBtn = document.getElementById('btnRemoveSelected');
  var selectAll = document.getElementById('selectAllItems');

  info.textContent = containerLabel(SELECTED);
  countEl.textContent = rows.length + (rows.length === 1 ? ' item' : ' items');
  tbody.innerHTML = '';

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#666">No items in this container</td></tr>';
    emptyBtn.disabled = true;
    removeBtn.disabled = true;
    selectAll.checked = false;
    selectAll.disabled = true;
    return;
  }

  emptyBtn.disabled = false;
  selectAll.disabled = false;
  selectAll.checked = false;

  rows.sort(function (a, b) {
    return (a.position_index || 0) - (b.position_index || 0);
  });

  rows.forEach(function (item, idx) {
    var tr = document.createElement('tr');

    var tdChk = document.createElement('td');
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.setAttribute('data-item-id', item.id);
    chk.addEventListener('change', updateRemoveButton);
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    var tdName = document.createElement('td');
    var templateId = item.template_id || item.id || '';
    tdName.textContent = ITEM_NAMES[templateId] || templateId;
    tdName.style.fontFamily = 'var(--font-mono)';
    tr.appendChild(tdName);

    var tdQty = document.createElement('td');
    tdQty.textContent = item.stack_size || 1;
    tr.appendChild(tdQty);

    var tdAct = document.createElement('td');
    var btn = document.createElement('button');
    btn.className = 'btn btn-danger';
    btn.style.fontSize = '0.7rem';
    btn.style.padding = '2px 8px';
    btn.textContent = '×';
    btn.title = 'Remove this item';
    btn.addEventListener('click', function () {
      removeSingleItem(item.id, templateId);
    });
    tdAct.appendChild(btn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  updateRemoveButton();
}

function updateRemoveButton() {
  var checked = document.querySelectorAll('#itemBody input[type=checkbox]:checked').length;
  document.getElementById('btnRemoveSelected').disabled = checked === 0;
}

function removeSingleItem(itemId, templateId) {
  if (!SELECTED) return;
  if (!confirm('Remove ' + (templateId || 'item') + ' (ID: ' + itemId + ')?')) return;

  var sid = SELECTED.storage_id || SELECTED.id;
  var btn = document.getElementById('btnRemoveSelected');
  btn.disabled = true;
  btn.textContent = 'Removing\u2026';

  apiCall('storage/' + encodeURIComponent(sid) + '/remove-items', 'POST', {
    itemIds: [String(itemId)],
    confirmation: 'REMOVE ITEMS FROM STORAGE'
  }).then(function (resp) {
    if (resp.error && /session expired/i.test(resp.error)) {
      clearSession();
      showMsg('Session expired.', 'error');
      showDisconnected();
      return;
    }
    if (resp.error || resp.supported === false) {
      showMsg('Remove failed: ' + (resp.error || resp.reason || 'unknown'), 'error');
      return;
    }
    var removed = resp.result && resp.result.removed;
    showMsg('Removed ' + (removed || 0) + ' item(s).', 'success');
    loadItems();
    refresh();
  }).catch(function (err) {
    showMsg('Remove error: ' + err.message, 'error');
  });
}

function emptyContainer() {
  if (!SELECTED) return;
  if (!ITEMS.length) return;
  if (!confirm('Remove ALL ' + ITEMS.length + ' items from ' + containerLabel(SELECTED) + '?')) return;

  var sid = SELECTED.storage_id || SELECTED.id;
  var allIds = ITEMS.map(function (item) { return String(item.id); });
  var btn = document.getElementById('btnEmptyContainer');
  btn.disabled = true;
  btn.textContent = 'Emptying\u2026';
  clearMsg();

  apiCall('storage/' + encodeURIComponent(sid) + '/remove-items', 'POST', {
    itemIds: allIds,
    confirmation: 'REMOVE ITEMS FROM STORAGE'
  }).then(function (resp) {
    if (resp.error && /session expired/i.test(resp.error)) {
      clearSession();
      showMsg('Session expired.', 'error');
      showDisconnected();
      return;
    }
    if (resp.error || resp.supported === false) {
      showMsg('Empty failed: ' + (resp.error || resp.reason || 'unknown'), 'error');
      return;
    }
    var removed = resp.result && resp.result.removed;
    showMsg('Container emptied: ' + (removed || 0) + ' item(s) removed.', 'success');
    loadItems();
    refresh();
  }).catch(function (err) {
    showMsg('Empty error: ' + err.message, 'error');
  });
}

function removeSelectedItems() {
  if (!SELECTED) return;
  var checked = document.querySelectorAll('#itemBody input[type=checkbox]:checked');
  if (!checked.length) return;
  var ids = Array.from(checked).map(function (el) { return el.getAttribute('data-item-id'); });
  var templates = Array.from(checked).map(function (el) {
    var row = el.closest('tr');
    return row ? row.cells[1].textContent : '?';
  });

  if (!confirm('Remove ' + ids.length + ' selected item(s): ' + templates.slice(0, 3).join(', ') + (templates.length > 3 ? ' and ' + (templates.length - 3) + ' more' : '') + '?')) return;

  var sid = SELECTED.storage_id || SELECTED.id;
  var btn = document.getElementById('btnRemoveSelected');
  btn.disabled = true;
  btn.textContent = 'Removing\u2026';
  clearMsg();

  apiCall('storage/' + encodeURIComponent(sid) + '/remove-items', 'POST', {
    itemIds: ids,
    confirmation: 'REMOVE ITEMS FROM STORAGE'
  }).then(function (resp) {
    if (resp.error && /session expired/i.test(resp.error)) {
      clearSession();
      showMsg('Session expired.', 'error');
      showDisconnected();
      return;
    }
    if (resp.error || resp.supported === false) {
      showMsg('Remove failed: ' + (resp.error || resp.reason || 'unknown'), 'error');
      return;
    }
    var removed = resp.result && resp.result.removed;
    showMsg('Removed ' + (removed || 0) + ' item(s).', 'success');
    loadItems();
    refresh();
  }).catch(function (err) {
    showMsg('Remove error: ' + err.message, 'error');
  });
}

function renderCatalog(rows) {
  // Build display-name lookup for all catalog items (not just fillable)
  // so item lists in storage containers show human-readable names.
  ITEM_NAMES = {};
  rows.forEach(function (item) {
    ITEM_NAMES[item.id] = item.name || item.id;
  });

  const FILLABLE_GROUPS = new Set(['refined_resource', 'component']);
  var items = rows.filter(function (item) {
    return item.group && FILLABLE_GROUPS.has(item.group);
  });
  // Sort alphabetically by type (group), then by display name within
  // each type, so the dropdown groups all components together and all
  // refined resources together in a predictable order.
  items.sort(function (a, b) {
    var ga = (a.group || a.category || '').toLowerCase();
    var gb = (b.group || b.category || '').toLowerCase();
    if (ga !== gb) return ga < gb ? -1 : 1;
    var na = (a.display_name || a.name || a.id || '').toLowerCase();
    var nb = (b.display_name || b.name || b.id || '').toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const sel = document.getElementById('itemSelect');
  const previous = sel.value;
  sel.innerHTML = '<option value="">\u2014 select item \u2014</option>';
  items.forEach(function (item) {
    const opt = document.createElement('option');
    opt.value = item.id || item.item_id || item.name || '';
    opt.textContent = (item.display_name || item.name || item.id) + ' (' + (item.group || item.category || '').replace(/_/g, ' ') + ')';
    sel.appendChild(opt);
  });
  if (previous && Array.from(sel.options).some(function (o) { return o.value === previous; })) {
    sel.value = previous;
  }
}

function fillContainer() {
  if (!SELECTED) {
    showMsg('Select a container from the list first.', 'error');
    return;
  }
  const itemId = document.getElementById('itemSelect').value;
  if (!itemId) {
    showMsg('Select an item.', 'error');
    return;
  }

  var qtyInput = document.getElementById('qty');
  var qty = qtyInput.value.trim() === '' ? 0 : parseInt(qtyInput.value, 10);
  if (qty < 0) qty = 0;

  const btn = 
  document.getElementById('btnFill').addEventListener('click', fillContainer);
  document.getElementById('btnRefresh').addEventListener('click', refresh);
  document.getElementById('btnRemoveSelected').addEventListener('click', removeSelectedItems);
  document.getElementById('btnEmptyContainer').addEventListener('click', emptyContainer);
  document.getElementById('selectAllItems').addEventListener('change', function () {
    var checked = this.checked;
    document.querySelectorAll('#itemBody input[type=checkbox]').forEach(function (el) { el.checked = checked; });
    updateRemoveButton();
  });
  document.getElementById('playerFilter').addEventListener('change', function () {
    renderStorage(ALL_ROWS, this.value);
  });

  autoConnect();
});
