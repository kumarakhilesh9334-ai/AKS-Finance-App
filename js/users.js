let blockedUsers = [];

async function renderUsers() {
  // Fetch blocked users
  if (S.cu && S.cu.role === 'admin') {
    const d = await gasGet('readBlockedUsers').catch(() => null);
    if (d && d.ok) blockedUsers = d.blocked || [];
  }
  $('users-list').innerHTML = S.users.map(u => {
    const perms = [];
    if (u.perms.loan)      perms.push('New Loan');
    if (u.perms.allLoans)  perms.push('All Loans');
    if (u.perms.approvals) perms.push('Approvals');
    if (u.perms.submit)    perms.push('Submit');
    if (u.perms.stock)     perms.push('Stock');
    const isBlocked = blockedUsers.includes(u.username);
    return `<div class="user-row">
      <div class="avatar">${u.name.slice(0, 2).toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${u.name}</div>
        <div style="font-size:11px;color:#888">@${u.username} · ${perms.join(', ') || 'no tabs'}</div>
      </div>
      ${isBlocked ? '<span class="badge b-default" style="background:#A32D2D">Blocked</span>' : `<span class="badge b-${u.role}">${u.role}</span>`}
      ${isBlocked ? `<button class="btn btn-sm" style="color:#0F6E56;border-color:#0F6E56" onclick="unblockUser('${u.username}')">Unblock</button>` : ''}
      ${!isBlocked && u.id !== 'u1' ? `<button class="btn btn-sm" style="color:#A32D2D;border-color:#f09595" onclick="removeUser('${u.id}')">Remove</button>` : ''}
    </div>`;
  }).join('');
}

async function unblockUser(username) {
  if (!confirm('Unblock @' + username + '?')) return;
  const res = await gasPost({ action: 'unblockUser', username });
  if (res.ok) { showAlert('@' + username + ' unblocked.'); blockedUsers = blockedUsers.filter(u => u !== username); renderUsers(); }
  else showWriteFailure(res, 'Unblock');
}

async function addUser() {
  const username = v('nu-user');
  const pin      = v('nu-pin');
  const name     = v('nu-name');
  const role     = $('nu-role').value;

  if (!username || !pin || !name) { showAlert('Please fill all fields.', 'e'); return; }
  if (S.users.find(u => u.username === username)) { showAlert('Username already exists.', 'e'); return; }

  const user = {
    id: 'u' + Date.now(),
    username,
    pin,
    name,
    role,
    perms: {
      loan:      $('p-loan').checked,
      allLoans:  $('p-allLoans').checked,
      approvals: $('p-approvals').checked,
      stock:     $('p-stock').checked,
    },
  };

  // Save to sheet
  try {
    const res = await gasPost({ action:'addUser', ...user });
    if (!res.ok) { showWriteFailure(res, 'Adding the user'); return; }
    // POST response already carries the fresh user list — no follow-up readUsers GET.
    if (Array.isArray(res.users)) {
      S.users = res.users;
      migrateUserPerms();
      saveUsers();
    }
  } catch(e) { console.warn('Sheet addUser failed:', e.message); }

  $('nu-user').value = '';
  $('nu-pin').value  = '';
  $('nu-name').value = '';
  renderUsers();
  showAlert('User added.');
}

async function removeUser(id) {
  if (!confirm('Remove this user?')) return;
  if (id === 'u1') { showAlert('Cannot remove the default admin.', 'e'); return; }

  try {
    const res = await gasPost({ action:'removeUser', id });
    if (!res.ok) { showWriteFailure(res, 'Removing the user'); return; }
    // POST response already carries the fresh user list — no follow-up readUsers GET.
    if (Array.isArray(res.users)) {
      S.users = res.users;
      migrateUserPerms();
      saveUsers();
    }
  } catch(e) { console.warn('Sheet removeUser failed:', e.message); }

  renderUsers();
}

async function syncUsersFromSheet() {
  try {
    const data = await gasGet('readUsers');
    if (data.ok && Array.isArray(data.users)) {
      S.users = data.users;
      migrateUserPerms();
      saveUsers();
    }
  } catch(e) {
    console.warn('Could not sync users:', e.message);
  }
}