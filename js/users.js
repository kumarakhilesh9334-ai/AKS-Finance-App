// ── USERS ─────────────────────────────────────────────────────────────────
// Admin-only: view, add, and remove users.

function renderUsers() {
  $('users-list').innerHTML = S.users.map(u => `
    <div class="user-row">
      <div class="avatar">${u.name.slice(0, 2).toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${u.name}</div>
        <div style="font-size:11px;color:#888">@${u.username} · ${[u.perms.loan ? 'Loans' : '', u.perms.emi ? 'EMIs' : ''].filter(Boolean).join(', ')}</div>
      </div>
      <span class="badge b-${u.role}">${u.role}</span>
      ${u.id !== 'u1' ? `<button class="btn btn-sm" style="color:#A32D2D;border-color:#f09595" onclick="removeUser('${u.id}')">Remove</button>` : ''}
    </div>`).join('');
}

function addUser() {
  const username = v('nu-user');
  const pin      = v('nu-pin');
  const name     = v('nu-name');
  const role     = $('nu-role').value;

  if (!username || !pin || !name) { showAlert('Please fill all fields.', 'e'); return; }
  if (S.users.find(u => u.username === username)) { showAlert('Username already exists.', 'e'); return; }

  S.users.push({
    id: 'u' + Date.now(),
    username,
    pin,
    name,
    role,
    perms: { loan: $('p-loan').checked, emi: $('p-emi').checked },
  });

  $('nu-user').value = '';
  $('nu-pin').value  = '';
  $('nu-name').value = '';
  renderUsers();
  showAlert('User added.');
}

function removeUser(id) {
  if (!confirm('Remove this user?')) return;
  S.users = S.users.filter(u => u.id !== id);
  renderUsers();
}
