const STATUS_LIST = ['参加', '不参加', '未定', '未回答'];

let supabaseClient = null;
let sessionUser = null;
let currentProfile = null;
let publicData = { events: [], members: [] };
let answerData = null;
let currentAnswerToken = '';
let categoryOptions = [];
let reasonCategoryOptions = [];
let realtimeChannel = null;
let refreshTimer = null;
let adminTablesBound = false;
const messageTimers = new Map();

document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
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

  // Supabaseのメールリンクの形式（#access_token=...&type=recovery か ?code=...）に
  // 依存せず確実に拾えるよう、URLの文字列チェックに加えてSDK側のイベントでも検知する。
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      showPasswordResetScreen();
    }
  });

  const params = new URLSearchParams(window.location.search);
  currentAnswerToken = params.get('schedule') || params.get('answer') || '';

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
  document.getElementById('userMeta').textContent = `${currentProfile.display_name || user.email} / ${isAdmin() ? '管理者' : 'メンバー'}`;
  document.getElementById('adminTabButton').classList.toggle('hidden', !isAdmin());
  switchView('top');
  initTopHero();
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

async function signOut() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
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

function renderOptionManager() {
  renderOptionGroup('eventCategoryOptions', categoryOptions);
  renderOptionGroup('reasonCategoryOptions', reasonCategoryOptions);
}

function renderOptionGroup(containerId, options) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = options.length
    ? options.map(option => `<span class="option-chip">${escapeHtml(option.label)}<button type="button" data-remove-option="${escapeAttr(option.id)}" title="削除">×</button></span>`).join('')
    : '<span class="muted">まだ選択肢がありません。</span>';
}

async function loadPublicData() {
  document.getElementById('publicStatus').textContent = '読み込み中...';

  const [{ data: events, error: eventError }, { data: members, error: memberError }, { data: answers, error: answerError }] = await Promise.all([
    supabaseClient.from('events').select('*').order('date', { ascending: true }),
    supabaseClient.from('members').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }),
    supabaseClient.from('answers').select('*')
  ]);

  if (eventError || memberError || answerError) {
    document.getElementById('publicStatus').textContent = `読み込みに失敗しました：${(eventError || memberError || answerError).message}`;
    return;
  }

  publicData.members = (members || []).map(normalizeMember);
  publicData.events = (events || []).map(event => buildPublicEvent(normalizeEvent(event), publicData.members, answers || []));
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

function buildPublicEvent(event, members, answers) {
  const targetMembers = getEligibleMembers(event, members);
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

  const answerHtml = (event.answers || []).map(answer => `
    <div class="member-chip">
      <div class="member-head">
        <span class="member-name">${escapeHtml(displayName(answer))}${memberTagHtml(answer)}</span>
        <span class="badge ${statusClass(answer.status)}">${escapeHtml(answer.status)}</span>
      </div>
      ${answer.pendingUntil ? `<div class="comment">判明予定：${escapeHtml(formatDate(answer.pendingUntil))}</div>` : ''}
      ${answer.comment ? `<div class="comment">コメント：${escapeHtml(answer.comment)}</div>` : ''}
      ${formatReasonText(answer) ? `<div class="comment">理由：${escapeHtml(formatReasonText(answer))}</div>` : ''}
    </div>
  `).join('');

  const countsHtml = STATUS_LIST.map(status => `<span class="badge ${statusClass(status)}">${escapeHtml(status)} ${Number(event.counts && event.counts[status] || 0)}</span>`).join('');

  return `
    <article class="event-row">
      <div class="event-row-top">
        <div class="event-row-summary">
          <div class="event-row-head">
            <span class="cat">${escapeHtml(event.category || 'その他')}</span>
            <span class="event-title">${escapeHtml(event.eventName)}</span>
          </div>
          <div class="event-meta-line">${metaParts.join('')}</div>
          ${event.note ? `<div class="event-note">備考：${escapeHtml(event.note)}</div>` : ''}
        </div>
        <div class="share-actions">
          <button type="button" data-open-answer="${escapeAttr(event.answerToken)}">日程調整リンク</button>
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
  answerData = { event, members: getEligibleMembers(event, publicData.members), answers: event.answers };
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
      <div class="meta-label">分類</div><div>${escapeHtml(event.category)}</div>
      <div class="meta-label">日付</div><div>${escapeHtml(formatDate(event.date))}</div>
      <div class="meta-label">時間</div><div>${escapeHtml(timeText)}</div>
      <div class="meta-label">場所</div><div>${event.placeUrl ? `<a href="${escapeAttr(event.placeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.place || '場所')}</a>` : escapeHtml(event.place || '-')}</div>
      <div class="meta-label">期限</div><div>${escapeHtml(formatDate(event.answerDeadline) || '-')}</div>
      <div class="meta-label">備考</div><div>${escapeHtml(event.note || '-')}</div>
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
  document.getElementById('creator').value = currentProfile ? (currentProfile.display_name || '') : '';

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
  const upButton = domEvent.target.closest('[data-move-member-up]');
  const downButton = domEvent.target.closest('[data-move-member-down]');
  if (editButton) editMember(editButton.dataset.editMember);
  else if (upButton) moveMember(upButton.dataset.moveMemberUp, 'up');
  else if (downButton) moveMember(downButton.dataset.moveMemberDown, 'down');
}

function handlePublicListClick(domEvent) {
  const answerButton = domEvent.target.closest('[data-open-answer]');
  const copyButton = domEvent.target.closest('[data-copy-share]');
  if (answerButton) openAnswerInApp(answerButton.dataset.openAnswer);
  else if (copyButton) copyShareText(copyButton.dataset.copyShare, copyButton);
}

function handleOptionRemoveClick(domEvent) {
  const removeButton = domEvent.target.closest('[data-remove-option]');
  if (removeButton) removeOption(removeButton.dataset.removeOption);
}

function renderAdmin() {
  if (!isAdmin()) return;
  renderAdminEvents();
  renderAdminMembers();
  renderAdminLogs();
  renderOptionManager();
  renderTopPhotoManager();
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
      <td data-label="衣装">${escapeHtml(member.costumeSize || '')}</td>
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
      <td data-label="操作"><button type="button" data-edit-member="${escapeAttr(member.memberId)}">編集</button></td>
    </tr>
  `;
  }).join('');
  const detailHeaders = showAll ? '<th>表示名</th><th>生年月日</th><th>入会日</th><th>退会日</th><th>衣装</th><th>Tシャツ</th><th>備考</th>' : '';
  const colCount = showAll ? 15 : 8;
  document.getElementById('adminMembers').innerHTML = `<div class="table-wrap"><table><thead><tr><th>順</th><th>表示</th><th>状態</th><th>氏名</th><th>学年</th><th>電話番号</th><th>担当</th>${detailHeaders}<th>操作</th></tr></thead><tbody>${rows || `<tr><td colspan="${colCount}">メンバーがいません。</td></tr>`}</tbody></table></div>`;
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
  if (!isAdmin()) return;
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
  restore();
  if (error) {
    showMessage('eventMessage', error.message, false);
    return;
  }

  await appendLog(isEdit ? '予定編集' : '予定追加', eventId, eventName, '', '', '', '', '');
  showMessage('eventMessage', `予定を保存しました。日程調整リンク：${createScheduleUrl(token)}`, true);
  clearEventForm();
  await refreshAll();
}

function editEvent(eventId) {
  const event = publicData.events.find(item => item.eventId === eventId);
  if (!event) return;
  switchAdminTab('eventForm');
  document.getElementById('eventId').value = event.eventId || '';
  document.getElementById('eventToken').value = event.answerToken || '';
  document.getElementById('eventName').value = event.eventName || '';
  document.getElementById('eventCategory').value = event.category || '';
  document.getElementById('eventDate').value = event.date || '';
  document.getElementById('startTime').value = event.startTime || '';
  document.getElementById('endTime').value = event.endTime || '';
  document.getElementById('place').value = event.place || '';
  document.getElementById('placeUrl').value = event.placeUrl || '';
  document.getElementById('creator').value = event.creator || '';
  document.getElementById('answerDeadline').value = event.answerDeadline || '';
  document.getElementById('eventNote').value = event.note || '';
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
  ['eventId', 'eventToken', 'eventName', 'eventDate', 'startTime', 'endTime', 'place', 'placeUrl', 'creator', 'answerDeadline', 'eventNote'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('eventCategory').value = '';
  document.getElementById('creator').value = currentProfile ? (currentProfile.display_name || '') : '';
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
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.getElementById(`${name}View`).classList.add('active');
  document.body.classList.toggle('top-active', name === 'top');
  const backdrop = document.getElementById('topPhotoBackdrop');
  if (backdrop) backdrop.classList.toggle('hidden', name !== 'top');
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
    ? `<p class="muted" style="margin:0 0 4px;font-size:12px;">次の予定</p><p style="margin:0 0 4px;font-size:15px;font-weight:900;">${escapeHtml(next.eventName)}</p><p class="muted" style="margin:0;font-size:13px;">${escapeHtml(formatDate(next.date))}${next.startTime ? escapeHtml(' ' + next.startTime + '〜') : ''}</p>`
    : `<p class="muted" style="margin:0 0 4px;font-size:12px;">次の予定</p><p style="margin:0;font-size:14px;">予定はまだありません</p>`;

  const memberId = currentProfile ? currentProfile.member_id : null;
  if (memberId) {
    const pendingEvents = upcoming.filter(event => {
      const answer = findAnswerForMember(event, memberId);
      return answer && answer.status === '未回答';
    });
    const pendingCount = pendingEvents.length;
    pendingBox.classList.toggle('clickable', pendingCount > 0);
    pendingBox.onclick = pendingCount ? () => openAnswerInApp(pendingEvents[0].answerToken) : null;
    pendingBox.innerHTML = pendingCount
      ? `<p class="muted" style="margin:0 0 4px;font-size:12px;">あなたの回答</p><p style="margin:0 0 4px;font-size:15px;font-weight:900;">未回答が${pendingCount}件あります</p><span class="badge pending">要回答</span>`
      : `<p class="muted" style="margin:0 0 4px;font-size:12px;">あなたの回答</p><p style="margin:0;font-size:14px;">未回答はありません</p>`;
  } else {
    pendingBox.classList.remove('clickable');
    pendingBox.onclick = null;
    pendingBox.innerHTML = `<p class="muted" style="margin:0 0 4px;font-size:12px;">あなたの回答</p><p style="margin:0;font-size:13px;">アカウントがメンバーに紐付けられていません</p>`;
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
  return getTimeValue(a.date) - getTimeValue(b.date) || String(a.eventName || '').localeCompare(String(b.eventName || ''), 'ja');
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

function getEligibleMembers(event, members) {
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
