const STATUS_LIST = ['参加', '不参加', '未定', '未回答'];

let supabaseClient = null;
let sessionUser = null;
let currentProfile = null;
let publicData = { events: [], members: [], eventTargetOverrides: [] };
let answerData = null;
let currentAnswerToken = '';
let categoryOptions = [];
let reasonCategoryOptions = [];
let realtimeChannel = null;
let refreshTimer = null;
let adminTablesBound = false;
const messageTimers = new Map();
const STAFF_LOGIN_EMAIL = 'staff@wakasyu.local';
let staffDisplayName = sessionStorage.getItem('staffDisplayName') || '';

let eventFormTargetMemberIds = null;
let eventFormPreAnswers = {};

let availabilityPolls = [];
let currentPoll = null;
let currentPollSlots = [];
let currentPollNotes = [];
let pollMode = 'input';
let pollWeekOffset = 0;
let pollDrag = null;
let pollViewInitialized = false;
let pollRefreshTimer = null;
let pollActingMemberId = '';
let pollPendingChanges = new Map();

document.addEventListener('DOMContentLoaded', initializeApp);

// logo.jpgはInstagramアイコン用の正方形画像（白背景に丸いデザイン）のため、
// ブラウザのタブアイコン（favicon）は画像そのままだと四角く白い余白が出てしまう。
// faviconはCSSで加工できないため、canvasで丸くくり抜いた画像を生成してから設定する。
function setCircularFavicon(src) {
  const img = new Image();
  img.onload = () => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, size, size);
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    link.href = canvas.toDataURL('image/png');
  };
  img.src = src;
}

async function initializeApp() {
  setCircularFavicon('./logo.jpg');
  const config = window.WAKASHU_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey || config.supabaseUrl.includes('YOUR_PROJECT_ID')) {
    document.getElementById('configWarning').classList.remove('hidden');
    document.getElementById('configWarning').textContent = 'config.js に Supabase の URL と anon key を設定してください。';
    return;
  }

  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('forgotPasswordButton').addEventListener('click', requestPasswordReset);
  document.getElementById('passwordResetForm').addEventListener('submit', submitNewPassword);
  document.getElementById('registerForm').addEventListener('submit', submitRegisterForm);
  document.getElementById('staffLoginForm').addEventListener('submit', handleStaffLogin);

  // Supabaseのメールリンクの形式（#access_token=...&type=recovery か ?code=...）に
  // 依存せず確実に拾えるよう、URLの文字列チェックに加えてSDK側のイベントでも検知する。
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      showPasswordResetScreen();
    }
  });

  const params = new URLSearchParams(window.location.search);
  currentAnswerToken = params.get('schedule') || params.get('answer') || '';

  if (params.get('register')) {
    await showRegisterScreen(params.get('register'));
    return;
  }

  if (window.location.hash.includes('type=recovery') || params.get('type') === 'recovery' || params.has('code')) {
    showPasswordResetScreen();
    return;
  }

  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    await enterApp(data.session.user);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  showMessage('loginMessage', 'ログイン中...', true);

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    showMessage('loginMessage', `ログインに失敗しました：${error.message}`, false);
    return;
  }

  await enterApp(data.user);
}

function toggleStaffLoginForm() {
  document.getElementById('staffLoginForm').classList.toggle('hidden');
}

async function handleStaffLogin(event) {
  event.preventDefault();
  const name = document.getElementById('staffName').value.trim();
  const password = document.getElementById('staffPassword').value;
  if (!name) {
    showMessage('loginMessage', 'お名前を入力してください。', false);
    return;
  }
  showMessage('loginMessage', 'ログイン中...', true);

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email: STAFF_LOGIN_EMAIL, password });
  if (error) {
    showMessage('loginMessage', `ログインに失敗しました：${error.message}`, false);
    return;
  }

  staffDisplayName = name;
  sessionStorage.setItem('staffDisplayName', name);
  await enterApp(data.user);
}

async function requestPasswordReset() {
  const email = document.getElementById('loginEmail').value.trim();
  if (!email) {
    showMessage('loginMessage', 'パスワード再設定にはメールアドレスの入力が必要です。', false);
    return;
  }
  const button = document.getElementById('forgotPasswordButton');
  const restore = setButtonBusy(button, '送信中...');
  const redirectTo = window.location.href.split('#')[0].split('?')[0];
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
  restore();
  if (error) {
    showMessage('loginMessage', `送信に失敗しました：${error.message}`, false);
    return;
  }
  showMessage('loginMessage', 'パスワード再設定用のメールを送信しました。メール内のリンクから設定してください。', true);
}

function showPasswordResetScreen() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('passwordResetScreen').classList.remove('hidden');
}

let currentRegisterToken = '';

async function callEdgeFunction(name, options) {
  const config = window.WAKASHU_CONFIG || {};
  const url = `${config.supabaseUrl}/functions/v1/${name}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      ...(options && options.headers)
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `通信エラー（${response.status}）`);
  return data;
}

async function showRegisterScreen(token) {
  currentRegisterToken = token;
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('registerScreen').classList.remove('hidden');
  try {
    await callEdgeFunction(`register-member?token=${encodeURIComponent(token)}`, { method: 'GET' });
    document.getElementById('registerIntro').textContent = 'ようこそ！以下の情報を入力して登録してください。';
  } catch (error) {
    document.getElementById('registerForm').classList.add('hidden');
    showMessage('registerMessage', error.message, false);
  }
}

async function submitRegisterForm(event) {
  event.preventDefault();
  const phone = document.getElementById('registerContact').value.trim();
  if (phone && !/^[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}$/.test(phone)) {
    showMessage('registerMessage', '電話番号は「090-1234-5678」のようにハイフン区切りで入力してください。', false);
    return;
  }

  const button = document.getElementById('submitRegisterButton');
  const restore = setButtonBusy(button, '登録中...');
  try {
    await callEdgeFunction('register-member', {
      method: 'POST',
      body: JSON.stringify({
        token: currentRegisterToken,
        email: document.getElementById('registerEmail').value.trim(),
        name: document.getElementById('registerName').value.trim(),
        shortName: document.getElementById('registerShortName').value.trim(),
        contact: phone,
        birthDate: document.getElementById('registerBirthDate').value || null,
        costumeSize: document.getElementById('registerCostumeSize').value.trim(),
        tshirtSize: document.getElementById('registerTshirtSize').value.trim()
      })
    });
    document.getElementById('registerForm').classList.add('hidden');
    showMessage('registerMessage', '登録が完了しました。メールアドレスとパスワード「password」でログインし、ログイン後は必ずパスワードを変更してください。', true);
  } catch (error) {
    showMessage('registerMessage', error.message, false);
  } finally {
    restore();
  }
}

async function submitNewPassword(event) {
  event.preventDefault();
  const password = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('newPasswordConfirm').value;

  if (password.length < 8) {
    showMessage('passwordResetMessage', 'パスワードは8文字以上にしてください。', false);
    return;
  }
  if (password !== confirmPassword) {
    showMessage('passwordResetMessage', '確認用パスワードが一致しません。', false);
    return;
  }

  const button = document.getElementById('submitNewPasswordButton');
  const restore = setButtonBusy(button, '更新中...');
  const { error } = await supabaseClient.auth.updateUser({ password });
  restore();
  if (error) {
    showMessage('passwordResetMessage', `更新に失敗しました：${error.message}`, false);
    return;
  }
  showMessage('passwordResetMessage', 'パスワードを更新しました。ログイン画面に戻ります。', true);
  await supabaseClient.auth.signOut();
  setTimeout(() => {
    window.location.href = window.location.href.split('#')[0].split('?')[0];
  }, 1500);
}

async function enterApp(user) {
  sessionUser = user;
  currentProfile = await loadProfile(user);
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('passwordResetScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  const roleLabel = isAdmin() ? '管理者' : isStaff() ? 'スタッフ' : 'メンバー';
  const displayLabel = isStaff() ? (staffDisplayName || 'スタッフ') : (currentProfile.display_name || user.email);
  document.getElementById('userMeta').textContent = `${displayLabel} / ${roleLabel}`;
  document.getElementById('adminTabButton').classList.toggle('hidden', !isAdmin());
  document.getElementById('eventFormTabButton').classList.toggle('hidden', !(isAdmin() || isStaff()));
  ['top', 'answer', 'poll'].forEach(name => {
    const tabButton = document.querySelector(`.tab[data-tab="${name}"]`);
    if (tabButton) tabButton.classList.toggle('hidden', isStaff());
  });
  switchView(isStaff() ? 'public' : 'top');
  if (!isStaff()) initTopHero();
  await loadOptions();
  setupAdminForms();
  setupAdminTables();
  renderOptionManager();
  await refreshAll();
  setupRealtime();

  if (currentAnswerToken) {
    switchView('answer');
    await loadAnswerData(currentAnswerToken);
  }
}

async function loadProfile(user) {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, display_name, role, member_id')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;
  return data || { id: user.id, display_name: user.email, role: 'member', member_id: null };
}

function isAdmin() {
  return currentProfile && currentProfile.role === 'admin';
}

function isStaff() {
  return currentProfile && currentProfile.role === 'staff';
}

function getDefaultCreatorName() {
  if (isStaff()) return staffDisplayName || '';
  return currentProfile ? (currentProfile.display_name || '') : '';
}

async function signOut() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  sessionStorage.removeItem('staffDisplayName');
  await supabaseClient.auth.signOut();
  location.reload();
}

function setupRealtime() {
  if (realtimeChannel) return;
  realtimeChannel = supabaseClient
    .channel('public-data-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'answers' }, scheduleRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'list_options' }, scheduleOptionsRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'availability_polls' }, schedulePollsRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'availability_slots' }, schedulePollSlotsRefresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'availability_notes' }, schedulePollSlotsRefresh)
    .subscribe();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshAll();
  }, 400);
}

function scheduleOptionsRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadOptions();
    renderOptionManager();
    refreshCategorySelects();
  }, 400);
}

function schedulePollsRefresh() {
  clearTimeout(pollRefreshTimer);
  pollRefreshTimer = setTimeout(async () => {
    await loadAvailabilityPolls();
  }, 400);
}

function schedulePollSlotsRefresh() {
  clearTimeout(pollRefreshTimer);
  pollRefreshTimer = setTimeout(async () => {
    if (!currentPoll) return;
    await loadPollSlots(currentPoll.pollId);
    await loadPollNotes(currentPoll.pollId);
    renderPollView();
  }, 400);
}

async function refreshAll() {
  await loadPublicData();
  if (currentAnswerToken) await loadAnswerData(currentAnswerToken);
}

async function loadOptions() {
  const { data, error } = await supabaseClient.from('list_options').select('*').order('sort_order', { ascending: true });
  if (error) return;
  categoryOptions = (data || []).filter(option => option.option_type === 'event_category');
  reasonCategoryOptions = (data || []).filter(option => option.option_type === 'reason_category');
}

function refreshCategorySelects() {
  fillSelect('categoryFilter', categoryOptions.map(option => option.label), 'すべての分類');
  fillSelect('eventCategory', categoryOptions.map(option => option.label), '分類を選択');
  fillSelect('answerReasonCategory', reasonCategoryOptions.map(option => option.label), '選択なし');
  renderPublic();
}

async function addOption(type, inputId) {
  if (!isAdmin()) return;
  const input = document.getElementById(inputId);
  const label = input.value.trim();
  if (!label) return;
  const list = type === 'event_category' ? categoryOptions : reasonCategoryOptions;
  const sortOrder = list.length ? Math.max(...list.map(option => option.sort_order)) + 1 : 1;
  const { error } = await supabaseClient.from('list_options').insert({ option_type: type, label, sort_order: sortOrder });
  if (error) {
    showMessage('optionMessage', error.message, false);
    return;
  }
  input.value = '';
  await loadOptions();
  renderOptionManager();
  refreshCategorySelects();
}

async function removeOption(id) {
  if (!isAdmin() || !confirm('この選択肢を削除しますか？')) return;
  const { error } = await supabaseClient.from('list_options').delete().eq('id', id);
  if (error) {
    showMessage('optionMessage', error.message, false);
    return;
  }
  await loadOptions();
  renderOptionManager();
  refreshCategorySelects();
}

async function renameOption(id, type, currentLabel) {
  if (!isAdmin()) return;
  const input = prompt('新しい名称を入力してください', currentLabel);
  if (input === null) return;
  const label = input.trim();
  if (!label || label === currentLabel) return;
  const { error } = await supabaseClient.from('list_options').update({ label }).eq('id', id);
  if (error) {
    showMessage('optionMessage', error.message, false);
    return;
  }
  // 既存の予定・回答に保存済みの旧名称も新名称に合わせて更新する
  if (type === 'event_category') {
    await supabaseClient.from('events').update({ category: label }).eq('category', currentLabel);
  } else {
    await supabaseClient.from('answers').update({ reason_category: label }).eq('reason_category', currentLabel);
  }
  await loadOptions();
  await refreshAll();
  renderOptionManager();
  refreshCategorySelects();
}

function renderOptionManager() {
  renderOptionGroup('eventCategoryOptions', categoryOptions, 'event_category');
  renderOptionGroup('reasonCategoryOptions', reasonCategoryOptions, 'reason_category');
}

function renderOptionGroup(containerId, options, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = options.length
    ? options.map(option => `<span class="option-chip">${escapeHtml(option.label)}<button type="button" data-edit-option="${escapeAttr(option.id)}" data-edit-option-type="${escapeAttr(type)}" data-edit-option-label="${escapeAttr(option.label)}" title="名称変更">✎</button><button type="button" data-remove-option="${escapeAttr(option.id)}" title="削除">×</button></span>`).join('')
    : '<span class="muted">まだ選択肢がありません。</span>';
}

async function loadPublicData() {
  document.getElementById('publicStatus').textContent = '読み込み中...';

  const [{ data: events, error: eventError }, { data: members, error: memberError }, { data: answers, error: answerError }, { data: targets, error: targetError }] = await Promise.all([
    supabaseClient.from('events').select('*').order('date', { ascending: true }),
    supabaseClient.from('members').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
    supabaseClient.from('answers').select('*'),
    supabaseClient.from('event_target_members').select('*')
  ]);

  if (eventError || memberError || answerError || targetError) {
    document.getElementById('publicStatus').textContent = `読み込みに失敗しました：${(eventError || memberError || answerError || targetError).message}`;
    return;
  }

  publicData.members = (members || []).map(normalizeMember);
  publicData.eventTargetOverrides = targets || [];
  publicData.events = (events || []).map(event => buildPublicEvent(normalizeEvent(event), publicData.members, answers || [], publicData.eventTargetOverrides));
  setupPublicFilters();
  renderPublic();
  populateAnswerEventSelect();
  renderTopHighlights();
  if (isAdmin()) renderAdmin();
}

async function manualRefresh() {
  const status = document.getElementById('refreshStatus');
  if (status) {
    status.textContent = 'loading...';
    status.classList.remove('hidden');
  }
  await refreshAll();
  if (status) {
    status.textContent = '更新しました';
    setTimeout(() => status.classList.add('hidden'), 1200);
  }
}

let completionTimer = null;
function flashCompletionOverlay(text) {
  const overlay = document.getElementById('completionOverlay');
  if (!overlay) return;
  overlay.querySelector('.completion-badge').textContent = text;
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('show'));
  clearTimeout(completionTimer);
  completionTimer = setTimeout(() => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.classList.add('hidden'), 300);
  }, 1400);
}

function buildPublicEvent(event, members, answers, targetOverrides) {
  const targetMembers = getEligibleMembers(event, members, targetOverrides);
  const eventAnswers = targetMembers.map(member => {
    const answer = answers.find(item => item.event_id === event.eventId && item.member_id === member.memberId);
    return {
      memberId: member.memberId,
      name: member.name,
      shortName: member.shortName,
      grade: member.grade,
      memberState: member.memberState,
      visible: member.visible,
      status: answer ? answer.status : '未回答',
      pendingUntil: answer ? normalizeDate(answer.pending_until) : '',
      comment: answer ? answer.comment || '' : '',
      reasonCategory: answer ? answer.reason_category || '' : '',
      reasonDetail: answer ? answer.reason_detail || '' : ''
    };
  });
  const counts = STATUS_LIST.reduce((acc, status) => {
    acc[status] = eventAnswers.filter(answer => answer.status === status).length;
    return acc;
  }, {});

  return {
    ...event,
    answerUrl: createScheduleUrl(event.answerToken),
    answers: eventAnswers,
    counts
  };
}

function setupPublicFilters() {
  const parsedDates = publicData.events.map(event => parseDate(event.date)).filter(Boolean);
  const years = [...new Set(parsedDates.map(date => date.getFullYear()))].sort((a, b) => a - b);
  const months = [...new Set(parsedDates.map(date => date.getMonth() + 1))].sort((a, b) => a - b);
  fillSelect('yearFilter', years.map(year => ({ value: String(year), label: `${year}年` })), 'すべての年');
  fillSelect('monthFilter', months.map(month => ({ value: String(month), label: `${month}月` })), 'すべての月');
  fillSelect('categoryFilter', categoryOptions.map(option => option.label), 'すべての分類');
  fillSelect('memberFilter', publicData.members.map(member => ({ value: member.memberId, label: memberOptionLabel(member) })), '全メンバー');
}

function renderPublic() {
  const mode = document.getElementById('viewMode').value;
  const filters = {
    category: document.getElementById('categoryFilter').value,
    showPast: document.getElementById('showPast').checked,
    year: document.getElementById('yearFilter').value,
    month: document.getElementById('monthFilter').value
  };
  const events = getFilteredPublicEvents(filters);
  updatePublicToolbarVisibility(mode);
  if (mode === 'member') {
    renderMemberMode(events, document.getElementById('memberFilter').value, document.getElementById('statusFilter').value);
    return;
  }
  renderEventMode(events);
}

function updatePublicToolbarVisibility(mode) {
  const memberWrap = document.getElementById('memberFilterWrap');
  const statusWrap = document.getElementById('statusFilterWrap');
  const inactiveWrap = document.getElementById('showInactiveMembersWrap');
  const isMemberMode = mode === 'member';
  if (!isMemberMode) {
    document.getElementById('memberFilter').value = '';
    document.getElementById('statusFilter').value = '';
  }
  memberWrap.hidden = !isMemberMode;
  statusWrap.hidden = !isMemberMode;
  if (inactiveWrap) inactiveWrap.hidden = !isMemberMode;
}

function getFilteredPublicEvents(filters) {
  return publicData.events
    .filter(event => event.publicState !== '削除')
    .filter(event => filters.showPast || !isPastEvent(event))
    .filter(event => !filters.category || event.category === filters.category)
    .filter(event => {
      const date = parseDate(event.date);
      if (!date) return true;
      if (filters.year && String(date.getFullYear()) !== String(filters.year)) return false;
      if (filters.month && String(date.getMonth() + 1) !== String(filters.month)) return false;
      return true;
    })
    .sort(compareEvents);
}

function renderEventMode(events) {
  const status = document.getElementById('publicStatus');
  const list = document.getElementById('eventList');
  status.textContent = `${events.length}件の予定を表示中`;
  if (!events.length) {
    list.className = '';
    list.innerHTML = '<section class="empty">表示できる予定がありません。</section>';
    return;
  }
  list.className = '';
  list.innerHTML = groupByMonth(events).map(createMonthHtml).join('');
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function createMonthHtml(group) {
  return `
    <details class="month" open>
      <summary><span>${escapeHtml(group.label)}</span><span>${group.events.length}件</span></summary>
      <div>
        ${createCategoryOverviewHtml(group.events)}
        <div>${groupByDay(group.events).map(createDayGroupHtml).join('')}</div>
      </div>
    </details>
  `;
}

function groupByDay(events) {
  const map = new Map();
  events.forEach(event => {
    const key = event.date || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  });
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function createDayGroupHtml([dateKey, dayEvents]) {
  const date = parseDate(dateKey);
  const label = date ? `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}）` : '日付未設定';
  const today = isSameDay(date, new Date());
  return `
    <div class="day-group ${today ? 'is-today' : ''}">
      <div class="day-heading">${escapeHtml(label)}${today ? '<span class="tag-muted">今日</span>' : ''}</div>
      ${dayEvents.map(createEventRowHtml).join('')}
    </div>
  `;
}

function isSameDay(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function createEventRowHtml(event) {
  const timeText = [event.startTime, event.endTime].filter(Boolean).join(' - ');
  const placeHtml = event.placeUrl ? `<a href="${escapeAttr(event.placeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.place || '場所リンク')}</a>` : escapeHtml(event.place || '');
  const deadlineText = formatDate(event.answerDeadline);

  const metaParts = [`<span>${escapeHtml(formatDate(event.date) || '日付未定')}</span>`];
  if (timeText) metaParts.push(`<span>${escapeHtml(timeText)}</span>`);
  if (event.place || event.placeUrl) metaParts.push(`<span>${placeHtml}</span>`);
  if (deadlineText) metaParts.push(`<span>期限 ${escapeHtml(deadlineText)}</span>`);
  if (event.creator) metaParts.push(`<span>作成 ${escapeHtml(event.creator)}</span>`);

  const myMemberId = currentProfile ? currentProfile.member_id : null;
  const locked = isAnswerLocked(event);

  const answerHtml = (event.answers || []).map(answer => {
    const canEdit = !locked && (isAdmin() || answer.memberId === myMemberId);
    return canEdit ? createInlineAnswerChipHtml(event, answer) : createStaticAnswerChipHtml(answer);
  }).join('');

  const countsHtml = STATUS_LIST.map(status => `<span class="badge ${statusClass(status)}">${escapeHtml(status)} ${Number(event.counts && event.counts[status] || 0)}</span>`).join('');

  const needsMyAnswer = myMemberId && !isAdmin() && findAnswerForMember(event, myMemberId) && findAnswerForMember(event, myMemberId).status === '未回答';

  return `
    <article class="event-row ${needsMyAnswer ? 'needs-answer' : ''}">
      <div class="event-row-top">
        <div class="event-row-summary">
          <div class="event-row-head">
            <span class="cat">${escapeHtml(event.category || 'その他')}</span>
            <span class="event-title">${escapeHtml(event.eventName)}</span>
            ${needsMyAnswer ? '<span class="badge pending">要回答</span>' : ''}
          </div>
          <div class="event-meta-line">${metaParts.join('')}</div>
          ${event.note ? `<div class="event-note">備考：${escapeHtml(event.note)}</div>` : ''}
        </div>
        <div class="share-actions">
          <button type="button" data-copy-share="${escapeAttr(event.eventId)}">共有文コピー</button>
        </div>
      </div>
      <div class="event-row-body">
        <div class="members">${answerHtml || '<div class="muted">回答対象メンバーがいません。</div>'}</div>
        <div class="counts-inline">${countsHtml}</div>
      </div>
    </article>
  `;
}

function createStaticAnswerChipHtml(answer) {
  return `
    <div class="member-chip">
      <div class="member-head">
        <span class="member-name">${escapeHtml(displayName(answer))}${memberTagHtml(answer)}</span>
        <span class="badge ${statusClass(answer.status)}">${escapeHtml(answer.status)}</span>
      </div>
      ${answer.pendingUntil ? `<div class="comment">判明予定：${escapeHtml(formatDate(answer.pendingUntil))}</div>` : ''}
      ${answer.comment ? `<div class="comment">コメント：${escapeHtml(answer.comment)}</div>` : ''}
      ${formatReasonText(answer) ? `<div class="comment">理由：${escapeHtml(formatReasonText(answer))}</div>` : ''}
    </div>
  `;
}

function createInlineAnswerChipHtml(event, answer) {
  const status = answer.status;
  const showExtra = status === '未定';
  const reasonOptions = reasonCategoryOptions.map(option =>
    `<option value="${escapeAttr(option.label)}" ${answer.reasonCategory === option.label ? 'selected' : ''}>${escapeHtml(option.label)}</option>`
  ).join('');

  return `
    <div class="member-chip inline-answer" data-event-token="${escapeAttr(event.answerToken)}" data-member-id="${escapeAttr(answer.memberId)}">
      <div class="member-head">
        <span class="member-name">${escapeHtml(displayName(answer))}${memberTagHtml(answer)}</span>
        <div class="inline-status-buttons">
          <button type="button" class="status-btn join ${status === '参加' ? 'active' : ''}" data-set-status="参加">参加</button>
          <button type="button" class="status-btn absent ${status === '不参加' ? 'active' : ''}" data-set-status="不参加">不参加</button>
          <button type="button" class="status-btn pending ${status === '未定' ? 'active' : ''}" data-set-status="未定">未定</button>
          ${status !== '未回答' ? '<button type="button" class="link-button small" data-clear-status>取消</button>' : ''}
        </div>
      </div>
      <div class="inline-extra-fields ${showExtra ? '' : 'hidden'}">
        <label>いつまでに分かるか<input type="date" data-pending-until value="${escapeAttr(answer.pendingUntil || '')}"></label>
        <label>理由カテゴリ<select data-reason-category><option value="">選択なし</option>${reasonOptions}</select></label>
        <label>理由詳細<input type="text" data-reason-detail value="${escapeAttr(answer.reasonDetail || '')}"></label>
        <label>コメント<textarea data-comment>${escapeHtml(answer.comment || '')}</textarea></label>
        <button type="button" class="small" data-save-extra>保存</button>
      </div>
    </div>
  `;
}

function renderMemberMode(events, memberId, answerStatus) {
  if (memberId) renderSingleMemberMode(events, memberId, answerStatus);
  else renderAllMembersMode(events, answerStatus);
}

function renderSingleMemberMode(events, memberId, answerStatus) {
  const status = document.getElementById('publicStatus');
  const list = document.getElementById('eventList');
  const member = publicData.members.find(item => item.memberId === memberId);
  const target = events.map(event => {
    const answer = findAnswerForMember(event, memberId);
    if (!answer) return null;
    if (answerStatus && answer.status !== answerStatus) return null;
    return { ...event, answers: [answer] };
  }).filter(Boolean);
  const counts = countMemberStatuses(target.map(event => event.answers[0]));
  status.textContent = `人主体：${member ? displayName(member) : ''}の予定を${target.length}件表示中`;
  list.className = '';
  list.innerHTML = createMemberSummaryHtml(counts) + (target.length ? groupByMonth(target).map(createMonthHtml).join('') : '<section class="empty">該当する予定がありません。</section>');
}

function renderAllMembersMode(events, answerStatus) {
  const status = document.getElementById('publicStatus');
  const list = document.getElementById('eventList');
  const showInactiveCheckbox = document.getElementById('showInactiveMembers');
  const showInactive = showInactiveCheckbox ? showInactiveCheckbox.checked : false;
  const boardMembers = publicData.members.filter(member => showInactive || isActiveRoster(member));
  status.textContent = '人主体：全メンバーの予定を表示中';
  if (!events.length) {
    list.className = '';
    list.innerHTML = '<section class="empty">表示できる予定がありません。</section>';
    return;
  }
  list.className = 'member-board';
  list.innerHTML = boardMembers.map(member => {
    const grouped = groupEventsByMemberStatus(events, member.memberId, answerStatus);
    return `
      <section class="member-card">
        <h3>${escapeHtml(displayName(member))}${memberTagHtml(member)}</h3>
        ${STATUS_LIST.map(statusText => createStatusGroupHtml(`${statusText}の予定`, statusText, grouped[statusText])).join('')}
      </section>
    `;
  }).join('') || '<section class="empty">表示できるメンバーがいません。</section>';
}

function isActiveRoster(member) {
  return member.visible && member.memberState !== '退会';
}

function memberStateLabel(member) {
  if (member.memberState === '退会') return '退会';
  if (member.memberState === '休会') return '休会';
  if (member.visible === false) return '非表示';
  return '';
}

function memberTagHtml(member) {
  const label = memberStateLabel(member);
  return label ? `<span class="tag-muted">${escapeHtml(label)}</span>` : '';
}

function memberOptionLabel(member) {
  const label = memberStateLabel(member);
  const base = displayName(member);
  return label ? `${base}（${label}）` : base;
}

function displayName(member) {
  return (member.shortName && member.shortName.trim()) || member.name;
}

function computeAge(birthDateStr) {
  const birth = parseDate(birthDateStr);
  if (!birth) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hadBirthdayThisYear = today.getMonth() > birth.getMonth() || (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age;
}

function isPastDeadline(event) {
  const deadline = parseDate(event.answerDeadline);
  if (!deadline) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today > deadline;
}

function isAnswerLocked(event) {
  return isPastDeadline(event) && !isAdmin();
}

function formatReasonText(answer) {
  if (answer.reasonCategory && answer.reasonDetail) return `${answer.reasonCategory}：${answer.reasonDetail}`;
  return answer.reasonCategory || answer.reasonDetail || '';
}

function findAnswerForMember(event, memberId) {
  return (event.answers || []).find(answer => answer.memberId === memberId) || null;
}

function groupEventsByMemberStatus(events, memberId, answerStatus) {
  const grouped = { '参加': [], '不参加': [], '未定': [], '未回答': [] };
  events.forEach(event => {
    const answer = findAnswerForMember(event, memberId);
    if (!answer) return;
    if (answerStatus && answer.status !== answerStatus) return;
    grouped[answer.status].push(event);
  });
  return grouped;
}

function countMemberStatuses(answers) {
  return STATUS_LIST.reduce((acc, status) => {
    acc[status] = answers.filter(answer => answer.status === status).length;
    return acc;
  }, {});
}

function createMemberSummaryHtml(counts) {
  return `<section class="summary">${STATUS_LIST.map(status => `<div class="summary-box"><div class="summary-num">${Number(counts[status] || 0)}</div><div class="summary-label">${escapeHtml(status)}</div></div>`).join('')}</section>`;
}

function createStatusGroupHtml(title, statusText, events) {
  const eventHtml = events.length ? events.map(createMiniEventHtml).join('') : '<div class="comment">該当なし</div>';
  return `<div><div class="member-head"><span class="badge ${statusClass(statusText)}">${escapeHtml(title)}</span><span class="comment">${events.length}件</span></div><div class="mini-list">${eventHtml}</div></div>`;
}

function createMiniEventHtml(event) {
  const timeText = [event.startTime, event.endTime].filter(Boolean).join(' - ') || '-';
  return `<div class="mini"><b>${escapeHtml(event.eventName)}</b><span>${escapeHtml(formatDate(event.date) || '-')} / ${escapeHtml(event.place || '-')} / ${escapeHtml(timeText)}</span></div>`;
}

function createCategoryOverviewHtml(events) {
  const counts = {};
  events.forEach(event => {
    const category = String(event.category || 'その他').trim() || 'その他';
    counts[category] = (counts[category] || 0) + 1;
  });
  return `<div class="month-overview"><span class="muted" style="font-weight:900">分類</span>${Object.keys(counts).map(category => `<span class="cat">${escapeHtml(category)} ${counts[category]}件</span>`).join('')}</div>`;
}

async function loadAnswerData(token) {
  currentAnswerToken = token || currentAnswerToken;
  const event = publicData.events.find(item => item.answerToken === currentAnswerToken);
  if (!event) {
    document.getElementById('answerStatus').textContent = '回答対象の予定が見つかりません。';
    return;
  }
  answerData = { event, members: getEligibleMembers(event, publicData.members, publicData.eventTargetOverrides), answers: event.answers };
  renderAnswerPage();
}

function openAnswerInApp(token) {
  if (!token) return;
  switchView('answer');
  loadAnswerData(token);
}

function populateAnswerEventSelect() {
  const select = document.getElementById('answerEventSelect');
  if (!select) return;
  const memberId = currentProfile ? currentProfile.member_id : null;
  const events = publicData.events
    .filter(event => event.publicState !== '削除')
    .filter(event => isAdmin() || !memberId || (event.answers || []).some(answer => answer.memberId === memberId))
    .sort(compareEvents);
  fillSelect('answerEventSelect', events.map(event => ({ value: event.answerToken, label: `[${event.category || 'その他'}] ${formatDate(event.date)} ${event.eventName}` })), '予定を選択してください');
  if (answerData && answerData.event) select.value = answerData.event.answerToken;
  select.onchange = () => {
    if (select.value) openAnswerInApp(select.value);
  };
}

function populateAnswerMemberSelect() {
  const select = document.getElementById('answerMemberSelect');
  if (!select || !answerData) return;
  fillSelect('answerMemberSelect', answerData.members.map(member => ({ value: member.memberId, label: memberOptionLabel(member) })), 'メンバーを選択');
  if (!select.value && currentProfile && currentProfile.member_id) {
    const ownEligible = answerData.members.some(member => member.memberId === currentProfile.member_id);
    if (ownEligible) select.value = currentProfile.member_id;
  }
  select.onchange = () => renderAnswerPage();
}

function getEffectiveMemberId() {
  if (isAdmin()) {
    const select = document.getElementById('answerMemberSelect');
    return select ? select.value : '';
  }
  return currentProfile ? currentProfile.member_id : null;
}

function renderAnswerPage() {
  populateAnswerEventSelect();
  if (!answerData || !answerData.event) return;
  const event = answerData.event;
  const timeText = [event.startTime, event.endTime].filter(Boolean).join(' - ') || '-';
  document.getElementById('answerEventBox').classList.remove('hidden');
  document.getElementById('answerEventBox').innerHTML = `
    <h3>${escapeHtml(event.eventName)}</h3>
    <div class="meta">
      <div class="meta-item"><span class="meta-label">分類</span><span>${escapeHtml(event.category)}</span></div>
      <div class="meta-item"><span class="meta-label">日付</span><span>${escapeHtml(formatDate(event.date))}</span></div>
      <div class="meta-item"><span class="meta-label">時間</span><span>${escapeHtml(timeText)}</span></div>
      <div class="meta-item"><span class="meta-label">場所</span><span>${event.placeUrl ? `<a href="${escapeAttr(event.placeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.place || '場所')}</a>` : escapeHtml(event.place || '-')}</span></div>
      <div class="meta-item"><span class="meta-label">期限</span><span>${escapeHtml(formatDate(event.answerDeadline) || '-')}</span></div>
      <div class="meta-item meta-item-wide"><span class="meta-label">備考</span><span>${escapeHtml(event.note || '-')}</span></div>
    </div>
  `;

  const memberSelectWrap = document.getElementById('answerMemberFieldWrap');
  if (isAdmin()) {
    memberSelectWrap.classList.remove('hidden');
    populateAnswerMemberSelect();
  } else {
    memberSelectWrap.classList.add('hidden');
  }

  const memberId = getEffectiveMemberId();
  const isEligible = Boolean(memberId) && answerData.members.some(member => member.memberId === memberId);
  const fieldsBox = document.getElementById('answerFormFields');
  document.getElementById('answerStatus').classList.remove('notice');

  if (!memberId) {
    fieldsBox.classList.add('hidden');
    document.getElementById('answerStatus').textContent = isAdmin()
      ? 'この予定に対象メンバーがいません。'
      : 'あなたのアカウントはメンバーに紐付けられていません。管理者に連絡してください。';
    return;
  }
  if (!isEligible) {
    fieldsBox.classList.add('hidden');
    document.getElementById('answerStatus').textContent = 'この予定は在籍期間外のため回答できません。';
    return;
  }

  fieldsBox.classList.remove('hidden');
  const locked = isAnswerLocked(event);
  const statusBox = document.getElementById('answerStatus');
  statusBox.classList.toggle('notice', locked);
  statusBox.textContent = locked
    ? `回答期限（${formatDate(event.answerDeadline)}）を過ぎているため、回答を送信・変更できません。内容を直したい場合は管理者に連絡してください。`
    : 'この予定への出欠を回答できます。';

  const answer = (answerData.answers || []).find(item => item.memberId === memberId);
  document.getElementById('answerStatusSelect').value = answer && answer.status !== '未回答' ? answer.status : '';
  document.getElementById('pendingUntil').value = answer ? answer.pendingUntil || '' : '';
  document.getElementById('answerComment').value = answer ? answer.comment || '' : '';
  document.getElementById('answerReasonCategory').value = answer ? answer.reasonCategory || '' : '';
  document.getElementById('answerReason').value = answer ? answer.reasonDetail || '' : '';
  updatePendingVisibility();
  setAnswerFormDisabled(locked);
  updateClearAnswerVisibility(answer, locked);
}

function setAnswerFormDisabled(disabled) {
  ['answerStatusSelect', 'pendingUntil', 'answerReasonCategory', 'answerReason', 'answerComment', 'submitAnswerButton'].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.disabled = disabled;
  });
}

function updateClearAnswerVisibility(answer, locked) {
  const button = document.getElementById('clearAnswerButton');
  if (!button) return;
  button.classList.toggle('hidden', !answer || answer.status === '未回答' || locked);
}

function proxyLogSuffix(memberId) {
  const actingForSelf = !isAdmin() || memberId === (currentProfile && currentProfile.member_id);
  return actingForSelf ? '' : '（管理者代理入力）';
}

async function submitAnswer() {
  if (!answerData || !answerData.event) {
    showMessage('answerMessage', '予定を選択してください。', false);
    return;
  }
  const memberId = getEffectiveMemberId();
  if (!memberId) {
    showMessage('answerMessage', isAdmin() ? '対象メンバーを選択してください。' : 'あなたのアカウントはメンバーに紐付けられていません。', false);
    return;
  }
  if (isAnswerLocked(answerData.event)) {
    showMessage('answerMessage', '回答期限を過ぎているため送信できません。', false);
    return;
  }

  const status = document.getElementById('answerStatusSelect').value;
  const payload = {
    event_id: answerData.event.eventId,
    member_id: memberId,
    status,
    pending_until: status === '未定' ? nullIfEmpty(document.getElementById('pendingUntil').value) : null,
    comment: document.getElementById('answerComment').value.trim(),
    reason_category: document.getElementById('answerReasonCategory').value,
    reason_detail: document.getElementById('answerReason').value.trim(),
    updated_at: new Date().toISOString()
  };

  if (!payload.status) {
    showMessage('answerMessage', '回答区分を選択してください。', false);
    return;
  }

  const button = document.getElementById('submitAnswerButton');
  const restore = setButtonBusy(button, '送信中...');
  const previous = answerData.answers.find(answer => answer.memberId === payload.member_id);

  const { error } = await supabaseClient
    .from('answers')
    .upsert(payload, { onConflict: 'event_id,member_id' });

  restore();
  if (error) {
    showMessage('answerMessage', `送信に失敗しました：${error.message}`, false);
    return;
  }

  const member = publicData.members.find(item => item.memberId === payload.member_id);
  const detail = [payload.comment || payload.reason_detail, proxyLogSuffix(memberId)].filter(Boolean).join(' ');
  await appendLog('日程調整回答', answerData.event.eventId, answerData.event.eventName, payload.member_id, member ? member.name : '', previous ? previous.status : '未回答', payload.status, detail);
  showMessage('answerMessage', '回答を反映しました。', true);
  flashCompletionOverlay('回答を送信しました');
  await refreshAll();
  await loadAnswerData(currentAnswerToken);
}

async function clearAnswer() {
  if (!answerData || !answerData.event) return;
  const memberId = getEffectiveMemberId();
  if (!memberId) return;
  if (isAnswerLocked(answerData.event)) {
    showMessage('answerMessage', '回答期限を過ぎているため取り消せません。', false);
    return;
  }
  if (!confirm('この回答を取り消して未回答に戻しますか？')) return;

  const button = document.getElementById('clearAnswerButton');
  const restore = setButtonBusy(button, '取消中...');
  const previous = answerData.answers.find(answer => answer.memberId === memberId);

  const { error } = await supabaseClient
    .from('answers')
    .delete()
    .eq('event_id', answerData.event.eventId)
    .eq('member_id', memberId);

  restore();
  if (error) {
    showMessage('answerMessage', `取り消しに失敗しました：${error.message}`, false);
    return;
  }

  const member = publicData.members.find(item => item.memberId === memberId);
  await appendLog('回答取消', answerData.event.eventId, answerData.event.eventName, memberId, member ? member.name : '', previous ? previous.status : '', '未回答', proxyLogSuffix(memberId));
  showMessage('answerMessage', '回答を未回答に戻しました。', true);
  await refreshAll();
  await loadAnswerData(currentAnswerToken);
}

function updatePendingVisibility() {
  document.getElementById('pendingField').classList.toggle('hidden', document.getElementById('answerStatusSelect').value !== '未定');
}

function setupAdminForms() {
  fillSelect('eventCategory', categoryOptions.map(option => option.label), '分類を選択');
  document.getElementById('creator').value = getDefaultCreatorName();

  const memberStateSelect = document.getElementById('memberState');
  if (memberStateSelect && !memberStateSelect.dataset.bound) {
    memberStateSelect.dataset.bound = 'true';
    memberStateSelect.addEventListener('change', () => {
      document.getElementById('visible').value = memberStateSelect.value === '退会' ? 'false' : 'true';
    });
  }
}

function setupAdminTables() {
  if (adminTablesBound) return;
  adminTablesBound = true;
  document.getElementById('adminEvents').addEventListener('click', handleAdminEventsClick);
  document.getElementById('adminMembers').addEventListener('click', handleAdminMembersClick);
  document.getElementById('eventList').addEventListener('click', handlePublicListClick);
  document.getElementById('eventCategoryOptions').addEventListener('click', handleOptionRemoveClick);
  document.getElementById('reasonCategoryOptions').addEventListener('click', handleOptionRemoveClick);
  document.getElementById('topPhotoList').addEventListener('click', handleTopPhotoClick);
  document.getElementById('adminPolls').addEventListener('click', handleAdminPollsClick);
  ['startTimeHour', 'startTimeMinute', 'endTimeHour', 'endTimeMinute'].forEach(id => populateTimeSelect(document.getElementById(id)));
  document.getElementById('eventTargetSection').classList.toggle('hidden', !isAdmin());
  renderEventTargetMemberList();
}

function handleAdminEventsClick(domEvent) {
  const editButton = domEvent.target.closest('[data-edit-event]');
  const deleteButton = domEvent.target.closest('[data-delete-event]');
  const restoreButton = domEvent.target.closest('[data-restore-event]');
  const copyButton = domEvent.target.closest('[data-copy-share]');
  if (editButton) editEvent(editButton.dataset.editEvent);
  else if (deleteButton) deleteEvent(deleteButton.dataset.deleteEvent);
  else if (restoreButton) restoreEvent(restoreButton.dataset.restoreEvent);
  else if (copyButton) copyShareText(copyButton.dataset.copyShare, copyButton);
}

function handleAdminMembersClick(domEvent) {
  const editButton = domEvent.target.closest('[data-edit-member]');
  const deleteButton = domEvent.target.closest('[data-delete-member]');
  const upButton = domEvent.target.closest('[data-move-member-up]');
  const downButton = domEvent.target.closest('[data-move-member-down]');
  if (editButton) editMember(editButton.dataset.editMember);
  else if (deleteButton) deleteMember(deleteButton.dataset.deleteMember);
  else if (upButton) moveMember(upButton.dataset.moveMemberUp, 'up');
  else if (downButton) moveMember(downButton.dataset.moveMemberDown, 'down');
}

function handlePublicListClick(domEvent) {
  const copyButton = domEvent.target.closest('[data-copy-share]');
  const statusButton = domEvent.target.closest('[data-set-status]');
  const clearButton = domEvent.target.closest('[data-clear-status]');
  const saveExtraButton = domEvent.target.closest('[data-save-extra]');
  if (copyButton) {
    copyShareText(copyButton.dataset.copyShare, copyButton);
    return;
  }
  const chip = domEvent.target.closest('.inline-answer');
  if (!chip) return;
  const eventToken = chip.dataset.eventToken;
  const memberId = chip.dataset.memberId;
  if (statusButton) {
    submitInlineAnswer(eventToken, memberId, statusButton.dataset.setStatus);
  } else if (clearButton) {
    clearInlineAnswer(eventToken, memberId);
  } else if (saveExtraButton) {
    const status = chip.querySelector('.status-btn.active')?.dataset.setStatus || '未定';
    submitInlineAnswer(eventToken, memberId, status, {
      pendingUntil: chip.querySelector('[data-pending-until]').value,
      reasonCategory: chip.querySelector('[data-reason-category]').value,
      reasonDetail: chip.querySelector('[data-reason-detail]').value,
      comment: chip.querySelector('[data-comment]').value
    });
  }
}

async function submitInlineAnswer(eventToken, memberId, status, extra) {
  const event = publicData.events.find(item => item.answerToken === eventToken);
  if (!event) return;
  if (isAnswerLocked(event)) {
    alert('回答期限を過ぎているため送信できません。');
    return;
  }
  const previous = findAnswerForMember(event, memberId);
  const payload = {
    event_id: event.eventId,
    member_id: memberId,
    status,
    pending_until: status === '未定' ? nullIfEmpty(extra && extra.pendingUntil) : null,
    comment: (extra && extra.comment) ? extra.comment.trim() : '',
    reason_category: (extra && extra.reasonCategory) || '',
    reason_detail: (extra && extra.reasonDetail) ? extra.reasonDetail.trim() : '',
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseClient.from('answers').upsert(payload, { onConflict: 'event_id,member_id' });
  if (error) {
    alert(error.message);
    return;
  }

  const member = publicData.members.find(item => item.memberId === memberId);
  const detail = [payload.comment || payload.reason_detail, proxyLogSuffix(memberId)].filter(Boolean).join(' ');
  await appendLog('日程調整回答', event.eventId, event.eventName, memberId, member ? member.name : '', previous ? previous.status : '未回答', status, detail);
  flashCompletionOverlay('回答を反映しました');
  await refreshAll();
}

async function clearInlineAnswer(eventToken, memberId) {
  const event = publicData.events.find(item => item.answerToken === eventToken);
  if (!event) return;
  if (isAnswerLocked(event)) {
    alert('回答期限を過ぎているため取り消せません。');
    return;
  }
  if (!confirm('この回答を取り消して未回答に戻しますか？')) return;

  const previous = findAnswerForMember(event, memberId);
  const { error } = await supabaseClient.from('answers').delete().eq('event_id', event.eventId).eq('member_id', memberId);
  if (error) {
    alert(error.message);
    return;
  }

  const member = publicData.members.find(item => item.memberId === memberId);
  await appendLog('回答取消', event.eventId, event.eventName, memberId, member ? member.name : '', previous ? previous.status : '', '未回答', proxyLogSuffix(memberId));
  await refreshAll();
}

function handleOptionRemoveClick(domEvent) {
  const editButton = domEvent.target.closest('[data-edit-option]');
  const removeButton = domEvent.target.closest('[data-remove-option]');
  if (editButton) renameOption(editButton.dataset.editOption, editButton.dataset.editOptionType, editButton.dataset.editOptionLabel);
  else if (removeButton) removeOption(removeButton.dataset.removeOption);
}

function renderAdmin() {
  if (!isAdmin()) return;
  renderAdminEvents();
  renderAdminMembers();
  renderAdminLogs();
  renderOptionManager();
  renderTopPhotoManager();
  renderAdminPolls();
  renderEventTargetMemberList();
}

function renderAdminEvents() {
  const archiveCheckbox = document.getElementById('showArchivedEvents');
  const showArchived = archiveCheckbox ? archiveCheckbox.checked : false;
  const events = publicData.events.filter(event => showArchived || event.publicState !== '削除');
  const rows = events.map(event => {
    const isArchived = event.publicState === '削除';
    const actionButtons = isArchived
      ? `<button type="button" data-restore-event="${escapeAttr(event.eventId)}">復元</button>`
      : `<button type="button" data-edit-event="${escapeAttr(event.eventId)}">編集</button> <button class="danger" type="button" data-delete-event="${escapeAttr(event.eventId)}">削除</button>`;
    return `
    <tr class="${isArchived ? 'is-archived' : ''}">
      <td data-label="状態">${escapeHtml(event.publicState)}</td>
      <td data-label="分類">${escapeHtml(event.category)}</td>
      <td class="wrap" data-label="予定名">${escapeHtml(event.eventName)}</td>
      <td data-label="日付">${escapeHtml(formatDate(event.date))}</td>
      <td data-label="時間">${escapeHtml([event.startTime, event.endTime].filter(Boolean).join(' - '))}</td>
      <td class="wrap" data-label="日程調整リンク"><div class="share-actions"><a href="${escapeAttr(event.answerUrl)}" target="_blank" rel="noopener noreferrer">日程調整リンク</a><button type="button" data-copy-share="${escapeAttr(event.eventId)}">共有文コピー</button></div></td>
      <td data-label="操作">${actionButtons}</td>
    </tr>
  `;
  }).join('');
  document.getElementById('adminEvents').innerHTML = `<div class="table-wrap"><table><thead><tr><th>状態</th><th>分類</th><th>予定名</th><th>日付</th><th>時間</th><th>日程調整リンク</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="7">予定がありません。</td></tr>'}</tbody></table></div>`;
}

function renderAdminMembers() {
  const showAllCheckbox = document.getElementById('showAllMemberColumns');
  const showAll = showAllCheckbox ? showAllCheckbox.checked : false;
  const ordered = publicData.members;
  const rows = ordered.map((member, index) => {
    const age = computeAge(member.birthDate);
    const birthDateHtml = member.birthDate
      ? `${escapeHtml(formatDate(member.birthDate))}${age !== null ? `<span class="muted"> (${age}歳)</span>` : ''}`
      : '';
    const detailCells = showAll ? `
      <td data-label="表示名">${escapeHtml(member.shortName || '')}</td>
      <td data-label="生年月日">${birthDateHtml}</td>
      <td data-label="入会日">${escapeHtml(member.joinDate ? formatDate(member.joinDate) : '')}</td>
      <td data-label="退会日">${escapeHtml(member.leaveDate ? formatDate(member.leaveDate) : '')}</td>
      <td data-label="袴">${escapeHtml(member.costumeSize || '')}</td>
      <td data-label="Tシャツ">${escapeHtml(member.tshirtSize || '')}</td>
      <td class="wrap" data-label="備考">${escapeHtml(member.note || '')}</td>
    ` : '';
    return `
    <tr>
      <td data-label="順"><div class="order-buttons">
        <button type="button" data-move-member-up="${escapeAttr(member.memberId)}" ${index === 0 ? 'disabled' : ''} title="上へ">▲</button>
        <button type="button" data-move-member-down="${escapeAttr(member.memberId)}" ${index === ordered.length - 1 ? 'disabled' : ''} title="下へ">▼</button>
      </div></td>
      <td data-label="表示">${escapeHtml(member.visible ? '表示' : '非表示')}</td>
      <td data-label="状態">${escapeHtml(member.memberState)}</td>
      <td data-label="氏名">${escapeHtml(member.name)}</td>
      <td data-label="学年">${escapeHtml(member.grade)}</td>
      <td class="wrap" data-label="電話番号">${escapeHtml(member.contact || '')}</td>
      <td data-label="担当">${escapeHtml(member.duty || '')}</td>
      ${detailCells}
      <td data-label="操作"><button type="button" data-edit-member="${escapeAttr(member.memberId)}">編集</button> <button type="button" class="danger" data-delete-member="${escapeAttr(member.memberId)}">削除</button></td>
    </tr>
  `;
  }).join('');
  const detailHeaders = showAll ? '<th>表示名</th><th>生年月日</th><th>入会日</th><th>退会日</th><th>袴</th><th>Tシャツ</th><th>備考</th>' : '';
  const colCount = showAll ? 15 : 8;
  document.getElementById('adminMembers').innerHTML = `<div class="table-wrap"><table><thead><tr><th>順</th><th>表示</th><th>状態</th><th>氏名</th><th>学年</th><th>電話番号</th><th>担当</th>${detailHeaders}<th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="${colCount}">メンバーがいません。</td></tr>`}</tbody></table></div>`;
}

function generateInviteToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function createRegisterUrl(token) {
  const base = String(window.location.href || '').split('?')[0].split('#')[0];
  return `${base}?register=${encodeURIComponent(token)}`;
}

async function issueNewMemberInviteLink(buttonEl) {
  if (!isAdmin()) return;
  const token = generateInviteToken();
  const { error } = await supabaseClient.from('member_invites').insert({
    token,
    created_by: sessionUser ? sessionUser.id : null
  });
  if (error) {
    showMessage('newMemberInviteMessage', error.message, false);
    return;
  }
  const url = createRegisterUrl(token);
  showMessage('newMemberInviteMessage', '登録リンクを発行しました。', true);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => flashButtonText(buttonEl, 'コピーしました')).catch(() => showSharePrompt(url));
  } else {
    showSharePrompt(url);
  }
}

async function deleteMember(memberId) {
  if (!isAdmin()) return;
  const member = publicData.members.find(item => item.memberId === memberId);
  if (!member) return;
  if (!confirm(`「${member.name}」を削除します。この人の回答履歴も一緒に削除され、元に戻せません。よろしいですか？`)) return;
  // 万一この人にログインアカウントが紐付いていた場合、参照が残らないようにしておく
  await supabaseClient.from('profiles').update({ member_id: null }).eq('member_id', memberId);
  const { error } = await supabaseClient.from('members').delete().eq('id', memberId);
  if (error) {
    alert(error.message);
    return;
  }
  await appendLog('メンバー削除', '', '', memberId, member.name, '', '', '');
  await refreshAll();
}

async function moveMember(memberId, direction) {
  if (!isAdmin()) return;
  const ordered = [...publicData.members];
  const index = ordered.findIndex(member => member.memberId === memberId);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || targetIndex < 0 || targetIndex >= ordered.length) return;
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];

  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].sortOrder !== i) {
      await supabaseClient.from('members').update({ sort_order: i }).eq('id', ordered[i].memberId);
    }
  }
  await appendLog('メンバー表示順変更', '', '', memberId, ordered[targetIndex] ? ordered[targetIndex].name : '', '', '', '');
  await refreshAll();
}

async function renderAdminLogs() {
  const { data, error } = await supabaseClient.from('logs').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) {
    document.getElementById('adminLogs').textContent = error.message;
    return;
  }
  const rows = (data || []).map(log => `
    <tr>
      <td data-label="日時">${escapeHtml(formatDateTime(log.created_at))}</td>
      <td data-label="実行者">${escapeHtml(log.actor_name || '-')}</td>
      <td data-label="操作">${escapeHtml(log.action)}</td>
      <td class="wrap" data-label="予定">${escapeHtml(log.event_name || log.event_id || '-')}</td>
      <td data-label="名前">${escapeHtml(log.member_name || '-')}</td>
      <td data-label="変更前">${escapeHtml(log.old_status || '-')}</td>
      <td data-label="変更後">${escapeHtml(log.new_status || '-')}</td>
      <td class="wrap" data-label="詳細">${escapeHtml(log.detail || '-')}</td>
    </tr>
  `).join('');
  document.getElementById('adminLogs').innerHTML = `<div class="table-wrap"><table><thead><tr><th>日時</th><th>実行者</th><th>操作</th><th>予定</th><th>名前</th><th>変更前</th><th>変更後</th><th>詳細</th></tr></thead><tbody>${rows || '<tr><td colspan="8">ログがありません。</td></tr>'}</tbody></table></div>`;
}

async function saveEventForm() {
  if (!isAdmin() && !isStaff()) return;
  const eventId = document.getElementById('eventId').value || crypto.randomUUID();
  const token = document.getElementById('eventToken').value || createToken();
  const eventName = document.getElementById('eventName').value.trim();
  const date = document.getElementById('eventDate').value;

  if (!eventName || !date) {
    showMessage('eventMessage', '予定名と日付を入力してください。', false);
    return;
  }

  const isEdit = Boolean(document.getElementById('eventId').value);
  const payload = {
    id: eventId,
    name: eventName,
    category: document.getElementById('eventCategory').value || 'その他',
    date,
    start_time: nullIfEmpty(document.getElementById('startTime').value),
    end_time: nullIfEmpty(document.getElementById('endTime').value),
    place: document.getElementById('place').value.trim(),
    place_url: nullIfEmpty(document.getElementById('placeUrl').value.trim()),
    creator: document.getElementById('creator').value.trim(),
    answer_deadline: nullIfEmpty(document.getElementById('answerDeadline').value),
    note: document.getElementById('eventNote').value.trim(),
    answer_token: token,
    public_state: '公開',
    updated_at: new Date().toISOString()
  };

  const button = document.getElementById('saveEventButton');
  const restore = setButtonBusy(button, '保存中...');
  const { error } = await supabaseClient.from('events').upsert(payload);
  if (error) {
    restore();
    showMessage('eventMessage', error.message, false);
    return;
  }

  if (isAdmin()) {
    const limitTargets = document.getElementById('eventLimitTargets').checked;
    await supabaseClient.from('event_target_members').delete().eq('event_id', eventId);
    let targetMemberIds = publicData.members.map(member => member.memberId);
    if (limitTargets) {
      const checked = Array.from(document.querySelectorAll('#eventTargetMemberList [data-target-member]:checked')).map(el => el.dataset.targetMember);
      targetMemberIds = checked;
      if (checked.length) {
        await supabaseClient.from('event_target_members').insert(checked.map(memberId => ({ event_id: eventId, member_id: memberId })));
      }
    }

    const preAnswerEntries = Array.from(document.querySelectorAll('#eventTargetMemberList [data-preanswer-member]'))
      .map(select => ({ memberId: select.dataset.preanswerMember, status: select.value }))
      .filter(entry => entry.status && targetMemberIds.includes(entry.memberId));
    for (const entry of preAnswerEntries) {
      await supabaseClient.from('answers').upsert({
        event_id: eventId,
        member_id: entry.memberId,
        status: entry.status,
        updated_at: new Date().toISOString()
      }, { onConflict: 'event_id,member_id' });
    }
  }

  restore();
  await appendLog(isEdit ? '予定編集' : '予定追加', eventId, eventName, '', '', '', '', '');
  showMessage('eventMessage', `予定を保存しました。日程調整リンク：${createScheduleUrl(token)}`, true);
  clearEventForm();
  await refreshAll();
}

function editEvent(eventId) {
  const event = publicData.events.find(item => item.eventId === eventId);
  if (!event) return;
  switchView('eventForm');
  document.getElementById('eventId').value = event.eventId || '';
  document.getElementById('eventToken').value = event.answerToken || '';
  document.getElementById('eventName').value = event.eventName || '';
  document.getElementById('eventCategory').value = event.category || '';
  document.getElementById('eventDate').value = event.date || '';
  setTimeSelectValue('startTime', event.startTime || '');
  setTimeSelectValue('endTime', event.endTime || '');
  document.getElementById('place').value = event.place || '';
  const overrides = publicData.eventTargetOverrides.filter(row => row.event_id === event.eventId);
  document.getElementById('eventLimitTargets').checked = overrides.length > 0;
  eventFormTargetMemberIds = overrides.length ? new Set(overrides.map(row => row.member_id)) : null;
  eventFormPreAnswers = {};
  (event.answers || []).forEach(answer => {
    if (answer.status && answer.status !== '未回答') eventFormPreAnswers[answer.memberId] = answer.status;
  });
  document.getElementById('placeUrl').value = event.placeUrl || '';
  document.getElementById('creator').value = event.creator || '';
  document.getElementById('answerDeadline').value = event.answerDeadline || '';
  document.getElementById('eventNote').value = event.note || '';
  renderEventTargetMemberList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteEvent(eventId) {
  if (!isAdmin() || !confirm('この予定を削除扱いにしますか？（あとで復元できます）')) return;
  const event = publicData.events.find(item => item.eventId === eventId);
  const { error } = await supabaseClient.from('events').update({ public_state: '削除', updated_at: new Date().toISOString() }).eq('id', eventId);
  if (error) {
    showMessage('eventMessage', error.message, false);
    return;
  }
  await appendLog('予定削除', eventId, event ? event.eventName : '', '', '', '', '削除', '');
  showMessage('eventMessage', '予定を削除扱いにしました。「削除済みも表示」から復元できます。', true);
  await refreshAll();
}

async function restoreEvent(eventId) {
  if (!isAdmin()) return;
  const event = publicData.events.find(item => item.eventId === eventId);
  const { error } = await supabaseClient.from('events').update({ public_state: '公開', updated_at: new Date().toISOString() }).eq('id', eventId);
  if (error) {
    showMessage('eventMessage', error.message, false);
    return;
  }
  await appendLog('予定復元', eventId, event ? event.eventName : '', '', '', '削除', '公開', '');
  showMessage('eventMessage', '予定を復元しました。', true);
  await refreshAll();
}

function clearEventForm() {
  ['eventId', 'eventToken', 'eventName', 'eventDate', 'place', 'placeUrl', 'creator', 'answerDeadline', 'eventNote'].forEach(id => {
    document.getElementById(id).value = '';
  });
  setTimeSelectValue('startTime', '');
  setTimeSelectValue('endTime', '');
  document.getElementById('eventCategory').value = '';
  document.getElementById('creator').value = getDefaultCreatorName();
  document.getElementById('eventLimitTargets').checked = false;
  eventFormTargetMemberIds = null;
  eventFormPreAnswers = {};
  renderEventTargetMemberList();
}

function renderEventTargetMemberList() {
  const container = document.getElementById('eventTargetMemberList');
  if (!container) return;
  const limit = document.getElementById('eventLimitTargets').checked;
  const date = document.getElementById('eventDate').value;
  const autoEligible = date ? getEligibleMembers({ eventId: '__preview__', date }, publicData.members, []) : publicData.members.filter(isActiveRoster);
  const autoIds = new Set(autoEligible.map(member => member.memberId));
  const checkedIds = limit && eventFormTargetMemberIds ? eventFormTargetMemberIds : autoIds;

  const rows = publicData.members.filter(isActiveRoster).map(member => {
    const checked = checkedIds.has(member.memberId);
    const status = eventFormPreAnswers[member.memberId] || '';
    const included = limit ? checked : true;
    const checkboxHtml = limit
      ? `<label class="inline-check"><input type="checkbox" data-target-member="${escapeAttr(member.memberId)}" ${checked ? 'checked' : ''} onchange="toggleEventTargetMember('${escapeAttr(member.memberId)}', this.checked)"> ${escapeHtml(displayName(member))}</label>`
      : `<span>${escapeHtml(displayName(member))}</span>`;
    return `
      <div class="event-target-row ${included ? '' : 'is-muted'}">
        ${checkboxHtml}
        <select data-preanswer-member="${escapeAttr(member.memberId)}" ${included ? '' : 'disabled'} onchange="eventFormPreAnswers[this.dataset.preanswerMember] = this.value">
          <option value="">未回答</option>
          <option value="参加" ${status === '参加' ? 'selected' : ''}>参加</option>
          <option value="不参加" ${status === '不参加' ? 'selected' : ''}>不参加</option>
          <option value="未定" ${status === '未定' ? 'selected' : ''}>未定</option>
        </select>
      </div>`;
  }).join('');
  container.innerHTML = rows || '<p class="muted">メンバーがいません。</p>';

  if (limit && !eventFormTargetMemberIds) {
    eventFormTargetMemberIds = new Set(autoIds);
  }
}

function toggleEventTargetMember(memberId, checked) {
  if (!eventFormTargetMemberIds) eventFormTargetMemberIds = new Set();
  if (checked) eventFormTargetMemberIds.add(memberId);
  else eventFormTargetMemberIds.delete(memberId);
  renderEventTargetMemberList();
}

function populateTimeSelect(select) {
  if (!select || select.dataset.populated) return;
  select.dataset.populated = 'true';
  const isHour = select.id.endsWith('Hour');
  const max = isHour ? 24 : 60;
  let html = '<option value="">--</option>';
  for (let i = 0; i < max; i++) {
    const value = String(i).padStart(2, '0');
    html += `<option value="${value}">${value}</option>`;
  }
  select.innerHTML = html;
}

function setTimeSelectValue(hiddenId, value) {
  const [h, m] = String(value || '').split(':');
  const hourSelect = document.getElementById(`${hiddenId}Hour`);
  const minuteSelect = document.getElementById(`${hiddenId}Minute`);
  populateTimeSelect(hourSelect);
  populateTimeSelect(minuteSelect);
  if (hourSelect) hourSelect.value = h || '';
  if (minuteSelect) minuteSelect.value = m || '';
  document.getElementById(hiddenId).value = value ? `${h}:${m}` : '';
}

function syncTimeSelectField(hiddenId) {
  const hourSelect = document.getElementById(`${hiddenId}Hour`);
  const minuteSelect = document.getElementById(`${hiddenId}Minute`);
  const hour = hourSelect ? hourSelect.value : '';
  const minute = minuteSelect ? minuteSelect.value : '';
  document.getElementById(hiddenId).value = (hour && minute) ? `${hour}:${minute}` : '';
}

async function saveMemberForm() {
  if (!isAdmin()) return;
  const memberId = document.getElementById('memberId').value || crypto.randomUUID();
  const name = document.getElementById('memberName').value.trim();

  if (!name) {
    showMessage('memberMessage', '名前を入力してください。', false);
    return;
  }

  const memberState = document.getElementById('memberState').value || '在籍';
  let leaveDate = nullIfEmpty(document.getElementById('leaveDate').value);
  if (memberState === '退会' && !leaveDate) {
    leaveDate = new Date().toISOString().slice(0, 10);
    document.getElementById('leaveDate').value = leaveDate;
  }

  const phone = document.getElementById('contact').value.trim();
  if (phone && !/^[0-9]{2,4}-[0-9]{2,4}-[0-9]{3,4}$/.test(phone)) {
    showMessage('memberMessage', '電話番号は「090-1234-5678」のようにハイフン区切りで入力してください。', false);
    return;
  }

  const isEdit = Boolean(document.getElementById('memberId').value);
  const payload = {
    id: memberId,
    name,
    short_name: document.getElementById('shortName').value.trim(),
    grade: document.getElementById('grade').value.trim(),
    birth_date: nullIfEmpty(document.getElementById('birthDate').value),
    contact: phone,
    join_date: nullIfEmpty(document.getElementById('joinDate').value),
    leave_date: leaveDate,
    member_state: memberState,
    visible: document.getElementById('visible').value === 'true',
    costume_size: document.getElementById('costumeSize').value.trim(),
    tshirt_size: document.getElementById('tshirtSize').value.trim(),
    duty: document.getElementById('duty').value.trim(),
    note: document.getElementById('memberNote').value.trim(),
    updated_at: new Date().toISOString()
  };

  const button = document.getElementById('saveMemberButton');
  const restore = setButtonBusy(button, '保存中...');
  const { error } = await supabaseClient.from('members').upsert(payload);
  restore();
  if (error) {
    showMessage('memberMessage', error.message, false);
    return;
  }

  await appendLog(isEdit ? 'メンバー編集' : 'メンバー追加', '', '', memberId, name, '', '', '');
  showMessage('memberMessage', 'メンバーを保存しました。', true);
  clearMemberForm();
  await refreshAll();
}

function editMember(memberId) {
  const member = publicData.members.find(item => item.memberId === memberId);
  if (!member) return;
  switchAdminTab('memberForm');
  document.getElementById('memberId').value = member.memberId || '';
  document.getElementById('memberName').value = member.name || '';
  document.getElementById('shortName').value = member.shortName || '';
  document.getElementById('grade').value = member.grade || '';
  document.getElementById('birthDate').value = member.birthDate || '';
  document.getElementById('contact').value = member.contact || '';
  document.getElementById('joinDate').value = member.joinDate || '';
  document.getElementById('leaveDate').value = member.leaveDate || '';
  document.getElementById('memberState').value = member.memberState || '在籍';
  document.getElementById('visible').value = member.visible ? 'true' : 'false';
  document.getElementById('costumeSize').value = member.costumeSize || '';
  document.getElementById('tshirtSize').value = member.tshirtSize || '';
  document.getElementById('duty').value = member.duty || '';
  document.getElementById('memberNote').value = member.note || '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearMemberForm() {
  ['memberId', 'memberName', 'shortName', 'grade', 'birthDate', 'contact', 'joinDate', 'leaveDate', 'costumeSize', 'tshirtSize', 'duty', 'memberNote'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('memberState').value = '在籍';
  document.getElementById('visible').value = 'true';
}

async function appendLog(action, eventId, eventName, memberId, memberName, oldStatus, newStatus, detail) {
  await supabaseClient.from('logs').insert({
    action,
    event_id: nullIfEmpty(eventId),
    event_name: eventName || '',
    member_id: nullIfEmpty(memberId),
    member_name: memberName || '',
    old_status: oldStatus || '',
    new_status: newStatus || '',
    detail: detail || '',
    actor_id: sessionUser ? sessionUser.id : null,
    actor_name: currentProfile ? (currentProfile.display_name || sessionUser.email) : ''
  });
}

function switchView(name) {
  if (name === 'admin' && !isAdmin()) return;
  if (name === 'eventForm' && !isAdmin() && !isStaff()) return;
  if (isStaff() && ['top', 'answer', 'poll'].includes(name)) return;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.getElementById(`${name}View`).classList.add('active');
  document.body.classList.toggle('top-active', name === 'top');
  const backdrop = document.getElementById('topPhotoBackdrop');
  if (backdrop) backdrop.classList.toggle('hidden', name !== 'top');
  if (name === 'poll') initPollView();
}

async function initPollView() {
  setupPollGridEvents();
  if (!pollViewInitialized) {
    pollViewInitialized = true;
    await loadAvailabilityPolls();
  }
}

let topHeroSlides = [];
let topHeroIndex = 0;
let topHeroTimer = null;
const TOP_PHOTOS_BUCKET = 'top-photos';
let topPhotoFiles = [];

async function loadTopPhotoList() {
  const { data, error } = await supabaseClient.storage.from(TOP_PHOTOS_BUCKET).list('', { sortBy: { column: 'name', order: 'asc' } });
  topPhotoFiles = error ? [] : (data || []).filter(file => file.name && !file.name.endsWith('/'));
}

async function initTopHero() {
  const media = document.getElementById('topHeroMedia');
  if (!media || media.dataset.loaded) return;
  media.dataset.loaded = 'true';
  await loadTopPhotoList();
  if (!topPhotoFiles.length) return;

  const paths = topPhotoFiles.map(file => file.name);
  const { data, error } = await supabaseClient.storage.from(TOP_PHOTOS_BUCKET).createSignedUrls(paths, 3600);
  if (error || !data) return;

  data.forEach(item => {
    if (!item.signedUrl) return;
    const slide = document.createElement('div');
    slide.className = 'top-hero-slide' + (topHeroSlides.length === 0 ? ' active' : '');
    slide.style.backgroundImage = `url("${item.signedUrl}")`;
    media.appendChild(slide);
    topHeroSlides.push(slide);
  });
  renderTopHeroDots();
  if (topHeroSlides.length >= 2) startTopHeroRotation();
}

function resetTopHero() {
  clearInterval(topHeroTimer);
  topHeroTimer = null;
  topHeroSlides = [];
  topHeroIndex = 0;
  const media = document.getElementById('topHeroMedia');
  if (media) {
    media.innerHTML = '';
    delete media.dataset.loaded;
  }
  renderTopHeroDots();
  initTopHero();
}

async function renderTopPhotoManager() {
  const list = document.getElementById('topPhotoList');
  if (!list) return;
  await loadTopPhotoList();
  if (!topPhotoFiles.length) {
    list.innerHTML = '<p class="muted">まだ写真がありません。</p>';
    return;
  }
  const paths = topPhotoFiles.map(file => file.name);
  const { data } = await supabaseClient.storage.from(TOP_PHOTOS_BUCKET).createSignedUrls(paths, 600);
  const urlMap = new Map((data || []).map(item => [item.path, item.signedUrl]));
  list.innerHTML = topPhotoFiles.map(file => `
    <div class="photo-card">
      <img src="${escapeAttr(urlMap.get(file.name) || '')}" alt="${escapeAttr(file.name)}">
      <button type="button" data-remove-photo="${escapeAttr(file.name)}" title="削除">×</button>
    </div>
  `).join('');
}

async function uploadTopPhotos() {
  if (!isAdmin()) return;
  const input = document.getElementById('topPhotoInput');
  const files = Array.from(input.files || []);
  if (!files.length) {
    showMessage('topPhotoMessage', 'ファイルを選択してください。', false);
    return;
  }

  const button = document.getElementById('uploadTopPhotoButton');
  const restore = setButtonBusy(button, 'アップロード中...');
  const errors = [];
  for (const file of files) {
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabaseClient.storage.from(TOP_PHOTOS_BUCKET).upload(safeName, file);
    if (error) errors.push(error.message);
  }
  restore();
  input.value = '';

  if (errors.length) {
    showMessage('topPhotoMessage', `一部アップロードに失敗しました：${errors.join(' / ')}`, false);
  } else {
    showMessage('topPhotoMessage', '写真をアップロードしました。', true);
  }
  await appendLog('トップ写真追加', '', '', '', '', '', '', files.map(file => file.name).join(', '));
  resetTopHero();
  await renderTopPhotoManager();
}

async function removeTopPhoto(name) {
  if (!isAdmin() || !confirm('この写真を削除しますか？')) return;
  const { error } = await supabaseClient.storage.from(TOP_PHOTOS_BUCKET).remove([name]);
  if (error) {
    showMessage('topPhotoMessage', error.message, false);
    return;
  }
  await appendLog('トップ写真削除', '', '', '', '', '', '', name);
  resetTopHero();
  await renderTopPhotoManager();
}

function handleTopPhotoClick(domEvent) {
  const removeButton = domEvent.target.closest('[data-remove-photo]');
  if (removeButton) removeTopPhoto(removeButton.dataset.removePhoto);
}

function renderTopHeroDots() {
  const dots = document.getElementById('topHeroDots');
  if (!dots) return;
  dots.innerHTML = topHeroSlides.map((slide, i) => `<span class="${i === topHeroIndex ? 'active' : ''}"></span>`).join('');
}

function startTopHeroRotation() {
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;
  clearInterval(topHeroTimer);
  topHeroTimer = setInterval(() => {
    if (topHeroSlides.length < 2) return;
    topHeroSlides[topHeroIndex].classList.remove('active');
    topHeroIndex = (topHeroIndex + 1) % topHeroSlides.length;
    topHeroSlides[topHeroIndex].classList.add('active');
    renderTopHeroDots();
  }, 5000);
}

function renderTopHighlights() {
  const nextBox = document.getElementById('topNextEvent');
  const pendingBox = document.getElementById('topPendingAnswers');
  if (!nextBox || !pendingBox) return;

  const upcoming = publicData.events
    .filter(event => event.publicState !== '削除' && !isPastEvent(event))
    .sort(compareEvents);
  const next = upcoming[0];
  nextBox.classList.toggle('clickable', Boolean(next));
  nextBox.onclick = next ? () => switchView('public') : null;
  nextBox.innerHTML = next
    ? `<span class="muted">次の予定：</span>${escapeHtml(next.eventName)}　${escapeHtml(formatDate(next.date))}${next.startTime ? escapeHtml(' ' + next.startTime + '〜') : ''}`
    : `<span class="muted">次の予定：</span>まだありません`;

  const memberId = currentProfile ? currentProfile.member_id : null;
  if (memberId) {
    const pendingEvents = upcoming.filter(event => {
      const answer = findAnswerForMember(event, memberId);
      return answer && answer.status === '未回答';
    });
    const pendingCount = pendingEvents.length;
    pendingBox.classList.toggle('clickable', pendingCount > 0);
    pendingBox.onclick = pendingCount ? () => switchView('public') : null;
    pendingBox.innerHTML = pendingCount
      ? `<span class="muted">あなたの回答：</span>未回答${pendingCount}件<span class="badge pending">要回答</span>`
      : `<span class="muted">あなたの回答：</span>未回答はありません`;
  } else {
    pendingBox.classList.remove('clickable');
    pendingBox.onclick = null;
    pendingBox.innerHTML = `<span class="muted">あなたの回答：</span>アカウント未紐付け`;
  }
}

function switchAdminTab(name) {
  document.querySelectorAll('.subtab').forEach(tab => tab.classList.toggle('active', tab.dataset.adminTab === name));
  document.querySelectorAll('.admin-section').forEach(section => section.classList.toggle('active', section.dataset.adminSection === name));
}

function fillSelect(id, items, placeholder) {
  const select = document.getElementById(id);
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`;
  items.forEach(item => {
    const value = typeof item === 'object' ? item.value : item;
    const label = typeof item === 'object' ? item.label : item;
    select.insertAdjacentHTML('beforeend', `<option value="${escapeAttr(value)}">${escapeHtml(label)}</option>`);
  });
  if (Array.from(select.options).some(option => option.value === current)) select.value = current;
}

function groupByMonth(events) {
  const map = new Map();
  events.forEach(event => {
    const date = parseDate(event.date);
    const key = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : 'unknown';
    const label = date ? `${date.getMonth() + 1}月` : '日付未設定';
    if (!map.has(key)) map.set(key, { key, label, events: [] });
    map.get(key).events.push(event);
  });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function compareEvents(a, b) {
  return getTimeValue(a.date) - getTimeValue(b.date)
    || getEventStartMinutes(a) - getEventStartMinutes(b)
    || String(a.eventName || '').localeCompare(String(b.eventName || ''), 'ja');
}

function getEventStartMinutes(event) {
  if (!event.startTime) return Number.MAX_SAFE_INTEGER;
  const [h, m] = String(event.startTime).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function isPastEvent(event) {
  const date = parseDate(event.date);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function parseDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getTimeValue(value) {
  const date = parseDate(value);
  return date ? date.getTime() : Number.MAX_SAFE_INTEGER;
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return String(value || '');
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function statusClass(status) {
  if (status === '参加') return 'join';
  if (status === '不参加') return 'absent';
  if (status === '未定') return 'pending';
  return 'none';
}

function createScheduleUrl(token) {
  const base = String(window.location.href || '').split('?')[0].split('#')[0];
  return `${base}?schedule=${encodeURIComponent(token)}`;
}

function copyShareText(eventId, buttonEl) {
  const event = publicData.events.find(item => item.eventId === eventId);
  if (!event) return;
  const text = createShareText(event);
  const onDone = () => flashButtonText(buttonEl, 'コピーしました');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onDone).catch(() => showSharePrompt(text));
  } else {
    showSharePrompt(text);
  }
}

function flashButtonText(button, text) {
  if (!button) return;
  if (button.dataset.flashTimer) clearTimeout(Number(button.dataset.flashTimer));
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.textContent = text;
  const timer = setTimeout(() => {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
    delete button.dataset.flashTimer;
  }, 1500);
  button.dataset.flashTimer = String(timer);
}

function createShareText(event) {
  return [
    `${event.eventName || ''}`,
    `日付：${formatDate(event.date) || '-'}`,
    `時間：${[event.startTime, event.endTime].filter(Boolean).join(' - ') || '-'}`,
    `場所：${event.place || '-'}`,
    `日程調整リンク：${event.answerUrl || '-'}`
  ].join('\n');
}

function showSharePrompt(text) {
  window.prompt('共有文をコピーしてください。', text);
}

function getEligibleMembers(event, members, targetOverrides) {
  const overrides = (targetOverrides || []).filter(row => row.event_id === event.eventId);
  if (overrides.length) {
    const targetIds = new Set(overrides.map(row => row.member_id));
    return members.filter(member => targetIds.has(member.memberId));
  }
  const eventDate = parseDate(event.date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return members.filter(member => {
    const joinDate = parseDate(member.joinDate);
    // 退会扱いなのに退会日が未入力だと日付ベースの判定が効かず、現在・今後の予定に
    // 出続けてしまうため、その場合は「今日」を退会日とみなして扱う。
    let leaveDate = parseDate(member.leaveDate);
    if (!leaveDate && member.memberState === '退会') leaveDate = today;
    if (eventDate && joinDate && eventDate < joinDate) return false;
    if (eventDate && leaveDate && eventDate >= leaveDate) return false;
    return true;
  });
}

function normalizeEvent(row) {
  return {
    eventId: row.id,
    eventName: row.name,
    category: row.category || 'その他',
    date: normalizeDate(row.date),
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
    place: row.place || '',
    placeUrl: row.place_url || '',
    creator: row.creator || '',
    answerDeadline: normalizeDate(row.answer_deadline),
    note: row.note || '',
    answerToken: row.answer_token || '',
    publicState: row.public_state || '公開',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

function normalizeMember(row) {
  return {
    memberId: row.id,
    name: row.name,
    shortName: row.short_name || '',
    grade: row.grade || '',
    birthDate: normalizeDate(row.birth_date),
    contact: row.contact || '',
    joinDate: normalizeDate(row.join_date),
    leaveDate: normalizeDate(row.leave_date),
    memberState: row.member_state || '在籍',
    note: row.note || '',
    costumeSize: row.costume_size || '',
    tshirtSize: row.tshirt_size || '',
    duty: row.duty || '',
    sortOrder: Number.isFinite(row.sort_order) ? row.sort_order : 0,
    visible: row.visible !== false,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}

function normalizeDate(value) {
  return value ? String(value).slice(0, 10) : '';
}

function normalizeTime(value) {
  return value ? String(value).slice(0, 5) : '';
}

function nullIfEmpty(value) {
  const text = String(value || '').trim();
  return text || null;
}

function createToken() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 24);
}

function setButtonBusy(button, busyText) {
  if (!button) return () => {};
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

function showMessage(id, text, ok) {
  const element = document.getElementById(id);
  if (!element) return;
  if (messageTimers.has(id)) {
    clearTimeout(messageTimers.get(id));
    messageTimers.delete(id);
  }
  element.className = `message ${ok ? 'ok' : 'error'}`;
  element.textContent = text;
  const timer = setTimeout(() => {
    element.classList.add('fade-out');
  }, 4000);
  messageTimers.set(id, timer);
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}

// ==========================================================================
// 候補日程調整（期間指定・ドラッグ入力の空き時間集計）
// 特定の1予定への出欠（answers）とは別物。新しい予定を立てる前段階として、
// 期間内の日付×時間帯ごとに各メンバーが空いている時間を申告し合い、
// 重なりが多い時間帯・日を自動で提案する。
// ==========================================================================

function normalizePoll(row) {
  return {
    pollId: row.id,
    title: row.title,
    note: row.note || '',
    periodStart: normalizeDate(row.period_start),
    periodEnd: normalizeDate(row.period_end),
    dayStartMinutes: Number.isFinite(row.day_start_minutes) ? row.day_start_minutes : 540,
    dayEndMinutes: Number.isFinite(row.day_end_minutes) ? row.day_end_minutes : 1320,
    slotMinutes: Number.isFinite(row.slot_minutes) ? row.slot_minutes : 30,
    publicState: row.public_state || '公開',
    createdAt: row.created_at || ''
  };
}

async function loadAvailabilityPolls() {
  const { data, error } = await supabaseClient.from('availability_polls').select('*').order('period_start', { ascending: false });
  if (error) return;
  availabilityPolls = (data || []).map(normalizePoll);
  renderPollSelect();
  if (isAdmin()) renderAdminPolls();
}

function renderPollSelect() {
  const select = document.getElementById('pollSelect');
  if (!select) return;
  const visible = availabilityPolls.filter(poll => poll.publicState !== '削除');
  const previous = select.value;
  select.innerHTML = '<option value="">候補日程調整を選択してください</option>' +
    visible.map(poll => `<option value="${escapeAttr(poll.pollId)}">${escapeHtml(poll.title)}（${escapeHtml(formatDate(poll.periodStart))}〜${escapeHtml(formatDate(poll.periodEnd))}）</option>`).join('');
  if (visible.some(poll => poll.pollId === previous)) {
    select.value = previous;
  } else if (currentPoll) {
    currentPoll = null;
    document.getElementById('pollBox').classList.add('hidden');
    document.getElementById('pollStatus').textContent = 'この候補日程調整は終了しました。候補日程調整を選択してください。';
  }
}

async function onPollSelectChange() {
  const select = document.getElementById('pollSelect');
  const pollId = select.value;
  if (!discardPendingPollChangesIfConfirmed()) {
    select.value = currentPoll ? currentPoll.pollId : '';
    return;
  }
  if (!pollId) {
    currentPoll = null;
    document.getElementById('pollBox').classList.add('hidden');
    document.getElementById('pollStatus').textContent = '候補日程調整を選択してください。';
    return;
  }
  currentPoll = availabilityPolls.find(poll => poll.pollId === pollId);
  if (!currentPoll) return;
  document.getElementById('pollStatus').textContent = '';
  document.getElementById('pollBox').classList.remove('hidden');
  document.getElementById('pollNote').textContent = currentPoll.note || '';
  pollWeekOffset = 0;
  pollMode = 'input';
  pollActingMemberId = '';
  setupPollActingMemberSelect();
  await loadPollSlots(pollId);
  await loadPollNotes(pollId);
  renderPollView();
  updatePollPendingIndicator();
}

function setupPollActingMemberSelect() {
  const wrap = document.getElementById('pollActingMemberWrap');
  if (!wrap) return;
  if (!isAdmin()) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  fillSelect('pollActingMemberSelect', publicData.members.map(member => ({ value: member.memberId, label: memberOptionLabel(member) })), '自分');
  document.getElementById('pollActingMemberSelect').value = pollActingMemberId || '';
}

function onPollActingMemberChange() {
  const select = document.getElementById('pollActingMemberSelect');
  if (!discardPendingPollChangesIfConfirmed()) {
    select.value = pollActingMemberId || '';
    return;
  }
  pollActingMemberId = select.value;
  renderPollView();
}

function getPollActingMemberId() {
  if (isAdmin() && pollActingMemberId) return pollActingMemberId;
  return currentProfile ? currentProfile.member_id : null;
}

async function loadPollSlots(pollId) {
  const { data, error } = await supabaseClient.from('availability_slots').select('*').eq('poll_id', pollId);
  if (error) {
    document.getElementById('pollStatus').textContent = `読み込みに失敗しました：${error.message}`;
    currentPollSlots = [];
    return;
  }
  currentPollSlots = (data || []).map(row => ({
    memberId: row.member_id,
    date: normalizeDate(row.slot_date),
    start: row.slot_start_minutes
  }));
}

async function loadPollNotes(pollId) {
  const { data, error } = await supabaseClient.from('availability_notes').select('*').eq('poll_id', pollId);
  if (error) {
    currentPollNotes = [];
    return;
  }
  currentPollNotes = (data || []).map(row => ({ memberId: row.member_id, note: row.note || '' }));
}

async function savePollNoteField() {
  if (!currentPoll) return;
  const memberId = getPollActingMemberId();
  if (!memberId) return;
  const note = document.getElementById('pollNoteInputField').value.trim();
  const existing = currentPollNotes.find(item => item.memberId === memberId);
  if (existing && existing.note === note) return;
  const { error } = await supabaseClient.from('availability_notes')
    .upsert({ poll_id: currentPoll.pollId, member_id: memberId, note, updated_at: new Date().toISOString() }, { onConflict: 'poll_id,member_id' });
  if (error) {
    alert(error.message);
    return;
  }
  await loadPollNotes(currentPoll.pollId);
}

async function resetPollSelection() {
  if (!currentPoll) return;
  const memberId = getPollActingMemberId();
  if (!memberId) return;
  if (!confirm('この候補日程調整で入力した空き時間をすべてリセットしますか？')) return;
  const { error } = await supabaseClient.from('availability_slots')
    .delete()
    .eq('poll_id', currentPoll.pollId)
    .eq('member_id', memberId);
  if (error) {
    alert(error.message);
    return;
  }
  pollPendingChanges.clear();
  await loadPollSlots(currentPoll.pollId);
  renderPollView();
  updatePollPendingIndicator();
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timeToMinutes(value) {
  const parts = String(value || '0:0').split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function minutesToLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getPollSlotStarts(poll) {
  const starts = [];
  for (let m = poll.dayStartMinutes; m < poll.dayEndMinutes; m += poll.slotMinutes) starts.push(m);
  return starts;
}

// グリッドの行は1時間単位。1時間未満の刻み（15分/30分）はその行の中で
// 縦に並ぶ色分けブロックとして表現し、時刻ラベルは行の境界（1時間ごと）にだけ置く。
function getPollHourStarts(poll) {
  const starts = [];
  const firstHour = Math.floor(poll.dayStartMinutes / 60) * 60;
  for (let h = firstHour; h < poll.dayEndMinutes; h += 60) starts.push(h);
  return starts;
}

function getPollWeekDates(poll, weekOffset) {
  const start = parseDate(poll.periodStart);
  const end = parseDate(poll.periodEnd);
  if (!start || !end) return [];
  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() + weekOffset * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    if (d < start || d > end) continue;
    dates.push(d);
  }
  return dates;
}

function movePollWeek(delta) {
  if (!currentPoll) return;
  const newOffset = pollWeekOffset + delta;
  if (newOffset < 0) return;
  const start = parseDate(currentPoll.periodStart);
  const end = parseDate(currentPoll.periodEnd);
  const candidateStart = new Date(start);
  candidateStart.setDate(candidateStart.getDate() + newOffset * 7);
  if (candidateStart > end) return;
  pollWeekOffset = newOffset;
  renderPollView();
}

function setPollMode(mode) {
  pollMode = mode;
  renderPollView();
}

function renderPollView() {
  if (!currentPoll) return;
  document.getElementById('pollModeInputButton').classList.toggle('active', pollMode === 'input');
  document.getElementById('pollModeResultButton').classList.toggle('active', pollMode === 'result');
  document.getElementById('pollInputControls').classList.toggle('hidden', pollMode !== 'input');
  document.getElementById('pollNoteInputWrap').classList.toggle('hidden', pollMode !== 'input');
  document.getElementById('pollSuggestions').classList.toggle('hidden', pollMode !== 'result');

  const actingMemberId = getPollActingMemberId();
  const actingNote = currentPollNotes.find(item => item.memberId === actingMemberId);
  const noteField = document.getElementById('pollNoteInputField');
  if (noteField && document.activeElement !== noteField) noteField.value = actingNote ? actingNote.note : '';

  const dates = getPollWeekDates(currentPoll, pollWeekOffset);
  const navButtons = document.querySelectorAll('.poll-week-nav button');
  const start = parseDate(currentPoll.periodStart);
  const end = parseDate(currentPoll.periodEnd);
  const nextWeekStart = new Date(start);
  nextWeekStart.setDate(nextWeekStart.getDate() + (pollWeekOffset + 1) * 7);
  if (navButtons[0]) navButtons[0].disabled = pollWeekOffset <= 0;
  if (navButtons[1]) navButtons[1].disabled = nextWeekStart > end;

  if (!dates.length) {
    document.getElementById('pollWeekLabel').textContent = '';
    document.getElementById('pollGridWrap').innerHTML = '<p class="muted">表示できる日付がありません。</p>';
    return;
  }
  document.getElementById('pollWeekLabel').textContent = `${formatDate(toIsoDate(dates[0]))} 〜 ${formatDate(toIsoDate(dates[dates.length - 1]))}`;

  const starts = getPollSlotStarts(currentPoll);
  const myMemberId = actingMemberId;

  let countMap = null;
  let namesMap = null;
  let maxCount = 1;
  if (pollMode === 'result') {
    countMap = new Map();
    namesMap = new Map();
    currentPollSlots.forEach(slot => {
      const key = `${slot.date}_${slot.start}`;
      countMap.set(key, (countMap.get(key) || 0) + 1);
      const member = publicData.members.find(item => item.memberId === slot.memberId);
      const list = namesMap.get(key) || [];
      list.push(member ? displayName(member) : '');
      namesMap.set(key, list);
    });
    if (countMap.size) maxCount = Math.max(...Array.from(countMap.values()));
  }

  const mySelectedKeys = new Set(
    myMemberId ? currentPollSlots.filter(slot => slot.memberId === myMemberId).map(slot => `${slot.date}_${slot.start}`) : []
  );
  pollPendingChanges.forEach((change, key) => {
    if (change.add) mySelectedKeys.add(key);
    else mySelectedKeys.delete(key);
  });

  const headerCells = dates.map(d => {
    const label = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
    return `<div class="poll-col-head">${escapeHtml(label)}</div>`;
  }).join('');

  const hourStarts = getPollHourStarts(currentPoll);
  const rows = hourStarts.map(hourStart => {
    const timeLabel = minutesToLabel(hourStart);
    const subStarts = starts.filter(start => start >= hourStart && start < hourStart + 60);
    const cells = dates.map(d => {
      const iso = toIsoDate(d);
      const subCells = subStarts.map(start => {
        const key = `${iso}_${start}`;
        if (pollMode === 'input') {
          const selected = mySelectedKeys.has(key);
          return `<div class="poll-cell ${selected ? 'selected' : ''}" data-date="${escapeAttr(iso)}" data-start="${start}" title="${escapeAttr(minutesToLabel(start))}"></div>`;
        }
        const count = countMap.get(key) || 0;
        const intensity = count ? Math.min(1, 0.15 + 0.75 * (count / maxCount)) : 0;
        const names = (namesMap.get(key) || []).join('、');
        const tip = `${minutesToLabel(start)} ${count}人${names ? '：' + names : ''}`;
        return `<div class="poll-cell result" style="--intensity:${intensity}" title="${escapeAttr(tip)}"></div>`;
      }).join('');
      return `<div class="poll-hour-block">${subCells}</div>`;
    }).join('');
    return `<div class="poll-row"><div class="poll-time-label">${timeLabel}</div>${cells}</div>`;
  }).join('');

  document.getElementById('pollGridWrap').innerHTML = `
    <div class="poll-grid" style="--poll-cols:${dates.length}">
      <div class="poll-row poll-row-head"><div class="poll-time-label"></div>${headerCells}</div>
      ${rows}
    </div>
  `;

  if (pollMode === 'result') renderPollSuggestions();
}

function computeSuggestions() {
  if (!currentPoll) return { blocks: [], days: [] };
  const starts = getPollSlotStarts(currentPoll);
  const byDateStart = new Map();
  currentPollSlots.forEach(slot => {
    const key = `${slot.date}_${slot.start}`;
    if (!byDateStart.has(key)) byDateStart.set(key, new Set());
    byDateStart.get(key).add(slot.memberId);
  });

  const dates = Array.from(new Set(currentPollSlots.map(slot => slot.date))).sort();

  const dayPeaks = dates.map(date => {
    let peak = 0;
    starts.forEach(start => {
      const set = byDateStart.get(`${date}_${start}`);
      if (set && set.size > peak) peak = set.size;
    });
    return { date, peak };
  }).filter(day => day.peak > 0).sort((a, b) => b.peak - a.peak).slice(0, 3);

  const blocks = [];
  dates.forEach(date => {
    let current = null;
    starts.forEach(start => {
      const set = byDateStart.get(`${date}_${start}`) || new Set();
      const key = set.size ? Array.from(set).sort().join(',') : '';
      if (current && current.key === key && key !== '') {
        current.endExclusive = start + currentPoll.slotMinutes;
      } else {
        if (current && current.key !== '') blocks.push(current);
        current = key ? { date, key, count: set.size, start, endExclusive: start + currentPoll.slotMinutes } : null;
      }
    });
    if (current && current.key !== '') blocks.push(current);
  });

  const topBlocks = blocks
    .sort((a, b) => (b.count - a.count) || ((b.endExclusive - b.start) - (a.endExclusive - a.start)))
    .slice(0, 3);

  return { blocks: topBlocks, days: dayPeaks };
}

function renderPollSuggestions() {
  const { blocks, days } = computeSuggestions();
  const box = document.getElementById('pollSuggestions');
  if (!box) return;

  const blockHtml = blocks.length
    ? blocks.map(block => {
        const names = block.key.split(',').filter(Boolean).map(id => {
          const member = publicData.members.find(item => item.memberId === id);
          return member ? displayName(member) : '';
        }).join('・');
        return `<li>${escapeHtml(formatDate(block.date))} ${minutesToLabel(block.start)}〜${minutesToLabel(block.endExclusive)}　<strong>${block.count}人</strong>（${escapeHtml(names)}）</li>`;
      }).join('')
    : '<li class="muted">まだ十分な回答がありません。</li>';

  const dayHtml = days.length
    ? days.map(day => `<li>${escapeHtml(formatDate(day.date))}　ピーク<strong>${day.peak}人</strong></li>`).join('')
    : '<li class="muted">まだ十分な回答がありません。</li>';

  const notesWithText = currentPollNotes.filter(item => item.note.trim());
  const noteHtml = notesWithText.length
    ? notesWithText.map(item => {
        const member = publicData.members.find(m => m.memberId === item.memberId);
        return `<li><strong>${escapeHtml(member ? displayName(member) : '')}</strong>：${escapeHtml(item.note)}</li>`;
      }).join('')
    : '';

  box.innerHTML = `
    <div class="poll-suggestion-group">
      <h3>みんなが空いている時間帯 候補トップ3</h3>
      <ul>${blockHtml}</ul>
    </div>
    <div class="poll-suggestion-group">
      <h3>参加可能人数が多い日 候補トップ3</h3>
      <ul>${dayHtml}</ul>
    </div>
    ${noteHtml ? `<div class="poll-suggestion-group poll-suggestion-notes"><h3>メンバーからの備考</h3><ul>${noteHtml}</ul></div>` : ''}
  `;
}

function setupPollGridEvents() {
  const wrap = document.getElementById('pollGridWrap');
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = 'true';
  wrap.addEventListener('mousedown', onPollCellDown);
  wrap.addEventListener('mouseover', onPollCellEnter);
  document.addEventListener('mouseup', onPollCellUp);
  wrap.addEventListener('touchstart', onPollCellTouchStart, { passive: false });
  wrap.addEventListener('touchmove', onPollCellTouchMove, { passive: false });
  wrap.addEventListener('touchend', onPollCellUp);
}

function applyPollDragToCell(cell) {
  if (!cell || !cell.dataset.date) return;
  const key = `${cell.dataset.date}_${cell.dataset.start}`;
  if (pollDrag.keys.has(key)) return;
  pollDrag.keys.add(key);
  cell.classList.toggle('selected', pollDrag.add);
}

function onPollCellDown(domEvent) {
  if (pollMode !== 'input') return;
  const cell = domEvent.target.closest('.poll-cell');
  if (!cell || !cell.dataset.date) return;
  domEvent.preventDefault();
  pollDrag = { add: !cell.classList.contains('selected'), keys: new Set() };
  applyPollDragToCell(cell);
}

function onPollCellEnter(domEvent) {
  if (!pollDrag) return;
  const cell = domEvent.target.closest('.poll-cell');
  applyPollDragToCell(cell);
}

function onPollCellTouchStart(domEvent) {
  if (pollMode !== 'input') return;
  const touch = domEvent.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el && el.closest ? el.closest('.poll-cell') : null;
  if (!cell || !cell.dataset.date) return;
  domEvent.preventDefault();
  pollDrag = { add: !cell.classList.contains('selected'), keys: new Set() };
  applyPollDragToCell(cell);
}

function onPollCellTouchMove(domEvent) {
  if (!pollDrag) return;
  domEvent.preventDefault();
  const touch = domEvent.touches[0];
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el && el.closest ? el.closest('.poll-cell') : null;
  applyPollDragToCell(cell);
}

function onPollCellUp() {
  if (!pollDrag) return;
  const drag = pollDrag;
  pollDrag = null;
  if (!drag.keys.size) return;
  drag.keys.forEach(key => {
    pollPendingChanges.set(key, { add: drag.add });
  });
  renderPollView();
  updatePollPendingIndicator();
}

function updatePollPendingIndicator() {
  const indicator = document.getElementById('pollPendingIndicator');
  const button = document.getElementById('pollCommitButton');
  if (!indicator || !button) return;
  const count = pollPendingChanges.size;
  indicator.textContent = count ? `未保存の変更が${count}件あります` : '';
  button.disabled = count === 0;
}

function discardPendingPollChangesIfConfirmed() {
  if (!pollPendingChanges.size) return true;
  if (!confirm('保存されていない変更があります。破棄して続けますか？')) return false;
  pollPendingChanges.clear();
  updatePollPendingIndicator();
  return true;
}

async function commitPendingPollChanges() {
  if (!currentPoll || !pollPendingChanges.size) return;
  const memberId = getPollActingMemberId();
  if (!memberId) {
    alert(isAdmin() ? '代理入力するメンバーを選択してください。' : 'メンバーに紐付いたアカウントでログインしてください。');
    return;
  }

  const toAdd = [];
  const toRemove = [];
  pollPendingChanges.forEach((change, key) => {
    const separatorIndex = key.lastIndexOf('_');
    const date = key.slice(0, separatorIndex);
    const start = Number(key.slice(separatorIndex + 1));
    if (change.add) toAdd.push({ poll_id: currentPoll.pollId, member_id: memberId, slot_date: date, slot_start_minutes: start });
    else toRemove.push({ date, start });
  });

  const button = document.getElementById('pollCommitButton');
  const restore = setButtonBusy(button, '保存中...');

  if (toAdd.length) {
    const { error } = await supabaseClient.from('availability_slots')
      .upsert(toAdd, { onConflict: 'poll_id,member_id,slot_date,slot_start_minutes' });
    if (error) alert(error.message);
  }
  for (const { date, start } of toRemove) {
    await supabaseClient.from('availability_slots')
      .delete()
      .eq('poll_id', currentPoll.pollId)
      .eq('member_id', memberId)
      .eq('slot_date', date)
      .eq('slot_start_minutes', start);
  }

  restore();
  pollPendingChanges.clear();
  await loadPollSlots(currentPoll.pollId);
  renderPollView();
  updatePollPendingIndicator();
}

async function savePollForm() {
  if (!isAdmin()) return;
  const isEdit = Boolean(document.getElementById('pollId').value);
  const pollId = document.getElementById('pollId').value || crypto.randomUUID();
  const title = document.getElementById('pollTitle').value.trim();
  const periodStart = document.getElementById('pollPeriodStart').value;
  const periodEnd = document.getElementById('pollPeriodEnd').value;

  if (!title || !periodStart || !periodEnd) {
    showMessage('pollFormMessage', 'タイトル・期間開始・期間終了は必須です。', false);
    return;
  }
  if (periodEnd < periodStart) {
    showMessage('pollFormMessage', '期間終了は期間開始以降にしてください。', false);
    return;
  }

  const dayStartMinutes = timeToMinutes(document.getElementById('pollDayStart').value || '09:00');
  const dayEndMinutes = timeToMinutes(document.getElementById('pollDayEnd').value || '22:00');
  if (dayEndMinutes <= dayStartMinutes) {
    showMessage('pollFormMessage', '1日の終了時刻は開始時刻より後にしてください。', false);
    return;
  }

  const payload = {
    id: pollId,
    title,
    note: document.getElementById('pollNoteInput').value.trim(),
    period_start: periodStart,
    period_end: periodEnd,
    day_start_minutes: dayStartMinutes,
    day_end_minutes: dayEndMinutes,
    slot_minutes: Number(document.getElementById('pollSlotMinutes').value),
    updated_at: new Date().toISOString()
  };

  const button = document.getElementById('savePollButton');
  const restore = setButtonBusy(button, '保存中...');
  const { error } = await supabaseClient.from('availability_polls').upsert(payload);
  restore();
  if (error) {
    showMessage('pollFormMessage', error.message, false);
    return;
  }

  await appendLog(isEdit ? '候補日程調整編集' : '候補日程調整作成', '', '', '', '', '', '', title);
  showMessage('pollFormMessage', '保存しました。', true);
  clearPollForm();
  await loadAvailabilityPolls();
}

function clearPollForm() {
  document.getElementById('pollId').value = '';
  document.getElementById('pollTitle').value = '';
  document.getElementById('pollPeriodStart').value = '';
  document.getElementById('pollPeriodEnd').value = '';
  document.getElementById('pollDayStart').value = '09:00';
  document.getElementById('pollDayEnd').value = '22:00';
  document.getElementById('pollSlotMinutes').value = '30';
  document.getElementById('pollNoteInput').value = '';
}

function editPollForm(pollId) {
  const poll = availabilityPolls.find(item => item.pollId === pollId);
  if (!poll) return;
  switchAdminTab('polls');
  document.getElementById('pollId').value = poll.pollId;
  document.getElementById('pollTitle').value = poll.title;
  document.getElementById('pollPeriodStart').value = poll.periodStart;
  document.getElementById('pollPeriodEnd').value = poll.periodEnd;
  document.getElementById('pollDayStart').value = minutesToLabel(poll.dayStartMinutes);
  document.getElementById('pollDayEnd').value = minutesToLabel(poll.dayEndMinutes);
  document.getElementById('pollSlotMinutes').value = String(poll.slotMinutes);
  document.getElementById('pollNoteInput').value = poll.note || '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deletePollEntry(pollId) {
  if (!isAdmin() || !confirm('この候補日程調整を削除しますか？（メンバーが入力した空き時間データは残ります）')) return;
  const { error } = await supabaseClient.from('availability_polls').update({ public_state: '削除' }).eq('id', pollId);
  if (error) {
    alert(error.message);
    return;
  }
  await appendLog('候補日程調整削除', '', '', '', '', '', '', '');
  await loadAvailabilityPolls();
}

async function restorePollEntry(pollId) {
  if (!isAdmin()) return;
  const { error } = await supabaseClient.from('availability_polls').update({ public_state: '公開' }).eq('id', pollId);
  if (error) {
    alert(error.message);
    return;
  }
  await appendLog('候補日程調整復元', '', '', '', '', '', '', '');
  await loadAvailabilityPolls();
}

function renderAdminPolls() {
  const container = document.getElementById('adminPolls');
  if (!container) return;
  const rows = availabilityPolls.map(poll => `
    <tr>
      <td data-label="状態">${escapeHtml(poll.publicState === '削除' ? '削除済み' : '公開')}</td>
      <td data-label="タイトル">${escapeHtml(poll.title)}</td>
      <td data-label="期間">${escapeHtml(formatDate(poll.periodStart))}〜${escapeHtml(formatDate(poll.periodEnd))}</td>
      <td data-label="操作">
        <button type="button" data-edit-poll="${escapeAttr(poll.pollId)}">編集</button>
        ${poll.publicState === '削除'
          ? `<button type="button" data-restore-poll="${escapeAttr(poll.pollId)}">復元</button>`
          : `<button type="button" class="danger" data-delete-poll="${escapeAttr(poll.pollId)}">削除</button>`}
      </td>
    </tr>
  `).join('');
  container.innerHTML = `<div class="table-wrap"><table><thead><tr><th>状態</th><th>タイトル</th><th>期間</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="4">候補日程調整がありません。</td></tr>'}</tbody></table></div>`;
}

function handleAdminPollsClick(domEvent) {
  const editButton = domEvent.target.closest('[data-edit-poll]');
  const deleteButton = domEvent.target.closest('[data-delete-poll]');
  const restoreButton = domEvent.target.closest('[data-restore-poll]');
  if (editButton) editPollForm(editButton.dataset.editPoll);
  else if (deleteButton) deletePollEntry(deleteButton.dataset.deletePoll);
  else if (restoreButton) restorePollEntry(restoreButton.dataset.restorePoll);
}
