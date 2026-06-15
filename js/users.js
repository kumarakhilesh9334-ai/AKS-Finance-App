function renderUsers() {
  $('users-list').innerHTML = S.users.map(u => {
    const perms = [];
    if (u.perms.loan)      perms.push('New Loan');
    if (u.perms.emi)       perms.push('Log EMI');
    if (u.perms.allLoans)  perms.push('All Loans');
    if (u.perms.approvals) perms.push('Approvals');
    return `<div class="user-row">
      <div class="avatar">${u.name.slice(0, 2).toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:500">${u.name}</div>
        <div style="font-size:11px;color:#888">@${u.username} · ${perms.join(', ') || 'no tabs'}</div>
      </div>
      <span class="badge b-${u.role}">${u.role}</span>
      ${u.id !== 'u1' ? `<button class="btn btn-sm" style="color:#A32D2D;border-color:#f09595" onclick="removeUser('${u.id}')">Remove</button>` : ''}
    </div>`;
  }).join('');
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
      emi:       $('p-emi').checked,
      allLoans:  $('p-allLoans').checked,
      approvals: $('p-approvals').checked,
    },
  };

  // Save to sheet
  try {
    const res = await gasPost({ action:'addUser', ...user });
    if (!res.ok) { showAlert('Failed to add user: ' + (res.error || 'Unknown error'), 'e'); return; }
  } catch(e) { console.warn('Sheet addUser failed, saving locally:', e.message); }

  // Merge response from sheet (or just use local if sheet failed)
  await syncUsersFromSheet();

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
    if (!res.ok) { showAlert('Failed to remove user: ' + (res.error || 'Unknown error'), 'e'); return; }
  } catch(e) { console.warn('Sheet removeUser failed, removing locally:', e.message); }

  await syncUsersFromSheet();
  renderUsers();
}

async function syncUsersFromSheet() {
  try {
    const data = await gasGet('readUsers');
    if (data.ok && Array.isArray(data.users)) {
      const adminUser = DEFAULT_USERS.find(u => u.id === 'u1');
      S.users = [adminUser, ...data.users.filter(u => u.id !== 'u1')];
      saveUsers();
    }
  } catch(e) {
    console.warn('Could not sync users:', e.message);
  }
}