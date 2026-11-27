const App = {
  async api(path, options = {}) {
    const opts = { ...options };
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = { ...opts.headers, 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, { credentials: 'same-origin', ...opts });
    if (res.status === 401) {
      window.location.href = '/';
      throw new Error('Neautorizováno');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Došlo k chybě');
    return data;
  },

  getCookie(name) {
    const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return m ? m[2] : null;
  },
};

// ---------------------------------------------------------------
// LOGIN PAGE
// ---------------------------------------------------------------
if (document.getElementById('loginForm')) {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('loginError');
    errBox.classList.remove('show');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Přihlášení selhalo');
      window.location.href = data.role === 'admin' ? '/admin.html' : '/dashboard.html';
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  });
}

// ---------------------------------------------------------------
// LOGOUT + user label (shared)
// ---------------------------------------------------------------
async function loadUserAndGuard() {
  try {
    const user = await App.api('/api/me');
    if (document.getElementById('userLabel')) {
      const badge = user.role === 'admin' ? ' (správce)' : '';
      document.getElementById('userLabel').textContent = `${user.name}${badge}`;
    }
    const isAdminPage = window.location.pathname.endsWith('admin.html');
    if (isAdminPage && user.role !== 'admin') {
      window.location.href = '/dashboard.html';
      return null;
    }
    if (!isAdminPage && user.role === 'admin') {
      // Admins can see dashboard too, keep them there.
    }
    return user;
  } catch {
    return null;
  }
}

async function bindLogout() {
  const btn = document.getElementById('logoutBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      window.location.href = '/';
    });
  }
}

// ---------------------------------------------------------------
// REPORTOR DASHBOARD
// ---------------------------------------------------------------
if (document.getElementById('reportForm')) {
  (async function initDashboard() {
    const user = await loadUserAndGuard();
    if (!user) return;
    await bindLogout();

    // Default date = today.
    const dateInput = document.getElementById('date');
    const today = new Date().toISOString().slice(0, 10);
    dateInput.value = today;

    await loadReports();
    bindForm();
    bindTableActions();
  })();

  async function loadReports() {
    const rows = await App.api('/api/reports/mine');
    const tbody = document.querySelector('#reportsTable tbody');
    const noReports = document.getElementById('noReports');
    tbody.innerHTML = '';
    if (!rows.length) {
      noReports.style.display = 'block';
      return;
    }
    noReports.style.display = 'none';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id;
      tr.innerHTML = `
        <td class="date-cell">${formatDate(r.date)}</td>
        <td class="num">${formatHours(r.hours)} h</td>
        <td>${escapeHtml(r.description)}</td>
        <td>
          <div class="actions">
            <button class="btn small secondary" data-action="edit">Upravit</button>
            <button class="btn small danger" data-action="delete">Smazat</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    }
  }

  function bindForm() {
    document.getElementById('reportForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('formError');
      errBox.classList.remove('show');
      const body = {
        date: document.getElementById('date').value,
        hours: Number(document.getElementById('hours').value),
        description: document.getElementById('description').value.trim(),
      };
      const editingId = document.getElementById('reportForm').dataset.editingId;
      try {
        if (editingId) {
          await App.api(`/api/reports/${editingId}`, { method: 'PUT', body });
        } else {
          await App.api('/api/reports', { method: 'POST', body });
        }
        resetForm();
        await loadReports();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
      }
    });
  }

  function resetForm() {
    const form = document.getElementById('reportForm');
    delete form.dataset.editingId;
    document.getElementById('date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('hours').value = '8';
    document.getElementById('description').value = '';
  }

  function bindTableActions() {
    document.getElementById('reportsTable').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = e.target.closest('tr');
      const id = tr.dataset.id;
      const errBox = document.getElementById('formError');
      errBox.classList.remove('show');

      if (btn.dataset.action === 'delete') {
        if (!confirm('Opravdu chcete smazat tento záznam?')) return;
        try {
          await App.api(`/api/reports/${id}`, { method: 'DELETE' });
          await loadReports();
        } catch (err) {
          alert(err.message);
        }
        return;
      }

      if (btn.dataset.action === 'edit') {
        const dateCell = tr.querySelector('.date-cell').textContent;
        const descCell = tr.querySelector('td:nth-child(3)').textContent;
        // Reconstruct date string from display.
        const [dd, mm, yyyy] = dateCell.split('.');
        const editId = id;
        const target = e.target.closest('tr').querySelector('td:nth-child(2)').textContent;
        const hours = parseFloat(target);
        document.getElementById('date').value = `${yyyy}-${mm}-${dd}`;
        document.getElementById('hours').value = hours;
        document.getElementById('description').value = descCell;
        document.getElementById('reportForm').dataset.editingId = editId;
        const submit = document.getElementById('reportForm').querySelector('button[type=submit]');
        submit.textContent = 'Uložit změny';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
}

// ---------------------------------------------------------------
// ADMIN PAGE
// ---------------------------------------------------------------
if (document.getElementById('summaryChart')) {
  (async function initAdmin() {
    const user = await loadUserAndGuard();
    if (!user) return;
    await bindLogout();

    const ctx = document.getElementById('summaryChart').getContext('2d');
    let chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Hodiny', data: [], backgroundColor: 'rgba(43,108,176,0.8)', borderRadius: 4 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Hodiny' } } },
      },
    });

    let currentView = 'day';
    async function loadChart(view) {
      const data = await App.api(`/api/summary/${view}`);
      chart.data.labels = data.labels;
      chart.data.datasets[0].data = data.data;
      chart.update();
    }

    document.getElementById('chartToggle').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-view]');
      if (!btn) return;
      document.querySelectorAll('#chartToggle button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      await loadChart(currentView);
    });

    await loadChart('day');

    // User filter + table.
    const filter = document.getElementById('userFilter');
    const tbody = document.querySelector('#reportsTable tbody');
    const noReports = document.getElementById('noReports');

    let all = [];
    const loadAll = async () => {
      all = await App.api('/api/reports');
    };

    const usersSet = new Map(); // userId -> label
    function renderTable() {
      const val = filter.value;
      const rows = val === 'all' ? all : all.filter((r) => r.user_id == val);
      tbody.innerHTML = '';
      if (!rows.length) {
        noReports.style.display = 'block';
        return;
      }
      noReports.style.display = 'none';
      for (const r of rows) {
        const tr = document.createElement('tr');
        const uname = r.user_name || r.username;
        const badge = r.user_role === 'admin'
          ? `<span class="badge admin">správce</span>`
          : `<span class="badge reporter">reportér</span>`;
        tr.innerHTML = `
          <td>${escapeHtml(uname)} ${badge}</td>
          <td>${formatDate(r.date)}</td>
          <td class="num">${formatHours(r.hours)} h</td>
          <td>${escapeHtml(r.description)}</td>
        `;
        tbody.appendChild(tr);
      }
    }

    await loadAll();
    for (const r of all) {
      const key = r.user_id;
      if (!usersSet.has(key)) {
        usersSet.set(key, `${r.user_name || r.username}`);
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = r.user_name || r.username;
        filter.appendChild(opt);
      }
    }
    filter.addEventListener('change', renderTable);
    renderTable();
  })();
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function formatHours(h) {
  return (Math.round(h * 100) / 100).toString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
