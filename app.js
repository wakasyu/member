const CATEGORIES = ['練習', '演奏', 'イベント', 'ミーティング', '準備', '本番', 'その他'];
const STATUS_LIST = ['参加', '不参加', '未定', '未回答'];
const REASON_CATEGORIES = ['体調不良', '仕事', '学校', '私用', '時間変更', 'その他'];

let supabaseClient = null;
let sessionUser = null;
let currentProfile = null;
let publicData = { events: [], members: [] };
let answerData = null;
let currentAnswerToken = '';

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

  const params = new URLSearchParams(window.location.search);
  currentAnswerToken = params.get('schedule') || params.get('answer') || '';

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

async function enterApp(user) {
  sessionUser = user;
  currentProfile = await loadProfile(user);
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('userMeta').textContent = `${currentProfile.display_name || user.email} / ${isAdmin() ? '管理者' : 'メンバー'}`;
  document.getElementById('adminTabButton').classList.toggle('hidden', !isAdmin());
  setupAdminForms();
  await refreshAll();

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
  await supabaseClient.auth.signOut();
  location.reload();
}

async function refreshAll() {
  await loadPublicData();
  if (currentAnswerToken) await loadAnswerData(currentAnswerToken);
}

async function loadPublicData() {
  document.getElementById('publicStatus').textContent = '読み込み中...';

  const [{ data: events, error: eventError }, { data: members, error: memberError }, { data: answers, error: answerError }] = await Promise.all([
    supabaseClient.from('events').select('*').neq('public_state', '削除').order('date', { ascending: true }),
    supabaseClient.from('members').select('*').eq('visible', true).order('name', { ascending: true }),
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
  if (isAdmin()) renderAdmin();
}

function buildPublicEvent(event, members, answers) {
  const targetMembers = getEligibleMembers(event, members);
  const eventAnswers = targetMembers.map(member => {
    const answer = answers.find(item => item.event_id === event.eventId && item.member_id === member.memberId);
    return {
      memberId: member.memberId,
      name: member.name,
      grade: member.grade,
      memberState: member.memberState,
      status: answer ? answer.status : '未回答',
      pendingUntil: answer ? normalizeDate(answer.pending_until) : '',
      comment: answer ? answer.comment || '' : '',
      reason: answer ? answer.reason || '' : ''
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
  fillSelect('categoryFilter', CATEGORIES, 'すべての分類');
  fillSelect('memberFilter', publicData.members.map(member => member.name), '全メンバー');
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
  if (mode === 'event') {
    document.getElementById('memberFilter').value = '';
    document.getElementById('statusFilter').value = '';
    memberWrap.hidden = true;
    statusWrap.hidden = true;
  } else {
    memberWrap.hidden = false;
    statusWrap.hidden = false;
  }
}

function getFilteredPublicEvents(filters) {
  return publicData.events
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

function createMonthHtml(group) {
  return `
    <details class="month" open>
      <summary><span>${escapeHtml(group.label)}</span><span>${group.events.length}件</span></summary>
      <div>
        ${createCategoryOverviewHtml(group.events)}
        <div>${group.events.map(createEventRowHtml).join('')}</div>
      </div>
    </details>
  `;
}

function createEventRowHtml(event) {
  const timeText = [event.startTime, event.endTime].filter(Boolean).join(' - ') || '-';
  const placeHtml = event.placeUrl ? `<a href="${escapeAttr(event.placeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(event.place || '場所リンク')}</a>` : escapeHtml(event.place || '-');
  const answerHtml = (event.answers || []).map(answer => `
    <div class="member-chip">
      <div class="member-head">
        <span class="member-name">${escapeHtml(answer.name)}${answer.memberState === '休会' ? '（休会）' : ''}</span>
        <span class="badge ${statusClass(answer.status)}">${escapeHtml(answer.status)}</span>
      </div>
      ${answer.pendingUntil ? `<div class="comment">判明予定：${escapeHtml(formatDate(answer.pendingUntil))}</div>` : ''}
      ${answer.comment ? `<div class="comment">コメント：${escapeHtml(answer.comment)}</div>` : ''}
      ${answer.reason ? `<div class="comment">理由：${escapeHtml(answer.reason)}</div>` : ''}
    </div>
  `).join('');

  return `
    <article class="event-row">
      <div class="event-main">
        <span class="cat">${escapeHtml(event.category || 'その他')}</span>
        <div class="event-title">${escapeHtml(event.eventName)}</div>
        <div class="meta">
          <div class="meta-label">日付</div><div>${escapeHtml(formatDate(event.date) || '-')}</div>
          <div class="meta-label">時間</div><div>${escapeHtml(timeText)}</div>
          <div class="meta-label">場所</div><div>${placeHtml}</div>
          <div class="meta-label">期限</div><div>${escapeHtml(formatDate(event.answerDeadline) || '-')}</div>
          <div class="meta-label">作成者</div><div>${escapeHtml(event.creator || '-')}</div>
          <div class="meta-label">備考</div><div>${escapeHtml(event.note || '-')}</div>
        </div>
      </div>
      <div class="members">${answerHtml || '<div class="muted">回答対象メンバーがいません。</div>'}</div>
      <div class="counts">
        ${STATUS_LIST.map(status => `<div class="count"><span>${status}</span><span>${Number(event.counts && event.counts[status] || 0)}</span></div>`).join('')}
        <div class="share-actions">
          <button type="button" onclick="openAnswerUrl('${escapeAttr(event.answerUrl)}')">日程調整リンク</button>
          <button type="button" onclick="copyShareText('${escapeAttr(event.eventId)}')">共有文コピー</button>
        </div>
      </div>
    </article>
  `;
}

function renderMemberMode(events, memberName, answerStatus) {
  if (memberName) renderSingleMemberMode(events, memberName, answerStatus);
  else renderAllMembersMode(events, answerStatus);
}

function renderSingleMemberMode(events, memberName, answerStatus) {
  const status = document.getElementById('publicStatus');
  const list = document.getElementById('eventList');
  const target = events.map(event => {
    const answer = findAnswerForMember(event, memberName);
    if (!answer) return null;
    if (answerStatus && answer.status !== answerStatus) return null;
    return { ...event, answers: [answer] };
  }).filter(Boolean);
  const counts = countMemberStatuses(target.map(event => event.answers[0]));
  status.textContent = `人主体：${memberName}の予定を${target.length}件表示中`;
  list.className = '';
  list.innerHTML = createMemberSummaryHtml(counts) + (target.length ? groupByMonth(target).map(createMonthHtml).join('') : '<section class="empty">該当する予定がありません。</section>');
}

function renderAllMembersMode(events, answerStatus) {
  const status = document.getElementById('publicStatus');
  const list = document.getElementById('eventList');
  status.textContent = '人主体：全メンバーの予定を表示中';
  if (!events.length) {
    list.className = '';
    list.innerHTML = '<section class="empty">表示できる予定がありません。</section>';
    return;
  }
  list.className = 'member-board';
  list.innerHTML = publicData.members.map(member => {
    const grouped = groupEventsByMemberStatus(events, member.name, answerStatus);
    return `
      <section class="member-card">
        <h3>${escapeHtml(member.name)}${member.memberState === '休会' ? '（休会）' : ''}</h3>
        ${STATUS_LIST.map(statusText => createStatusGroupHtml(`${statusText}の予定`, statusText, grouped[statusText])).join('')}
      </section>
    `;
  }).join('');
}

function findAnswerForMember(event, memberName) {
  return (event.answers || []).find(answer => answer.name === memberName) || null;
}

function groupEventsByMemberStatus(events, memberName, answerStatus) {
  const grouped = { '参加': [], '不参加': [], '未定': [], '未回答': [] };
  events.forEach(event => {
    const answer = findAnswerForMember(event, memberName);
    if (!answer) return;
    if (answerStatus && answer.status !== answerStatus) return;
    grouped[grouped[answer.status] ? answer.status : '未回答'].push(event);
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

function renderAnswerPage() {
  if (!answerData || !answerData.event) return;
  const event = answerData.event;
  const timeText = [event.startTime, event.endTime].filter(Boolean).join(' - ') || '-';
  document.getElementById('answerStatus').textContent = 'この予定への出欠を回答できます。';
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
    <div style="margin-top:12px"><button type="button" onclick="switchView('public')">予定一覧へ戻る</button></div>
  `;
  fillSelect('answerMember', answerData.members.map(member => ({ value: member.memberId, label: member.name })), '名前を選択');
  document.getElementById('answerMember').value = currentProfile && currentProfile.member_id ? currentProfile.member_id : '';
  document.getElementById('answerMember').onchange = updateAnswerFormForMember;
  updateAnswerFormForMember();
}

function updateAnswerFormForMember() {
  if (!answerData) return;
  const memberId = document.getElementById('answerMember').value;
  const answer = (answerData.answers || []).find(item => item.memberId === memberId);
  document.getElementById('answerStatusSelect').value = answer && answer.status !== '未回答' ? answer.status : '';
  document.getElementById('pendingUntil').value = answer ? answer.pendingUntil || '' : '';
  document.getElementById('answerComment').value = answer ? answer.comment || '' : '';
  setReasonFields(answer ? answer.reason || '' : '');
  updatePendingVisibility();
}

async function submitAnswer() {
  if (!answerData || !answerData.event) {
    showMessage('answerMessage', '日程調整リンクから開いてください。', false);
    return;
  }

  const payload = {
    event_id: answerData.event.eventId,
    member_id: document.getElementById('answerMember').value,
    status: document.getElementById('answerStatusSelect').value,
    pending_until: nullIfEmpty(document.getElementById('pendingUntil').value),
    comment: document.getElementById('answerComment').value.trim(),
    reason: buildReasonText(document.getElementById('answerReasonCategory').value, document.getElementById('answerReason').value.trim()),
    updated_at: new Date().toISOString()
  };

  if (!payload.member_id || !payload.status) {
    showMessage('answerMessage', '名前と回答区分を選択してください。', false);
    return;
  }

  const button = document.getElementById('submitAnswerButton');
  button.disabled = true;
  const previous = answerData.answers.find(answer => answer.memberId === payload.member_id);

  const { error } = await supabaseClient
    .from('answers')
    .upsert(payload, { onConflict: 'event_id,member_id' });

  if (error) {
    showMessage('answerMessage', `送信に失敗しました：${error.message}`, false);
    button.disabled = false;
    return;
  }

  const member = publicData.members.find(item => item.memberId === payload.member_id);
  await appendLog('日程調整回答', answerData.event.eventId, answerData.event.eventName, payload.member_id, member ? member.name : '', previous ? previous.status : '未回答', payload.status, payload.comment || payload.reason);
  showMessage('answerMessage', '回答を反映しました。', true);
  button.disabled = false;
  await refreshAll();
  await loadAnswerData(currentAnswerToken);
}

function updatePendingVisibility() {
  document.getElementById('pendingField').classList.toggle('hidden', document.getElementById('answerStatusSelect').value !== '未定');
}

function setupAdminForms() {
  fillSelect('eventCategory', CATEGORIES, '分類を選択');
}

function renderAdmin() {
  if (!isAdmin()) return;
  renderAdminEvents();
  renderAdminMembers();
  renderAdminLogs();
}

function renderAdminEvents() {
  const rows = publicData.events.map(event => `
    <tr>
      <td>${escapeHtml(event.publicState)}</td>
      <td>${escapeHtml(event.category)}</td>
      <td class="wrap">${escapeHtml(event.eventName)}</td>
      <td>${escapeHtml(formatDate(event.date))}</td>
      <td>${escapeHtml([event.startTime, event.endTime].filter(Boolean).join(' - '))}</td>
      <td class="wrap"><div class="share-actions"><a href="${escapeAttr(event.answerUrl)}" target="_blank" rel="noopener noreferrer">日程調整リンク</a><button type="button" onclick="copyShareText('${escapeAttr(event.eventId)}')">共有文コピー</button></div></td>
      <td><button type="button" onclick='editEvent(${jsonAttr(event)})'>編集</button> <button class="danger" type="button" onclick="deleteEvent('${escapeAttr(event.eventId)}')">削除</button></td>
    </tr>
  `).join('');
  document.getElementById('adminEvents').innerHTML = `<div class="table-wrap"><table><thead><tr><th>状態</th><th>分類</th><th>予定名</th><th>日付</th><th>時間</th><th>日程調整リンク</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="7">予定がありません。</td></tr>'}</tbody></table></div>`;
}

function renderAdminMembers() {
  const rows = publicData.members.map(member => `
    <tr><td>${escapeHtml(member.visible ? '表示' : '非表示')}</td><td>${escapeHtml(member.memberState)}</td><td>${escapeHtml(member.name)}</td><td>${escapeHtml(member.grade)}</td><td>${escapeHtml(member.joinDate ? formatDate(member.joinDate) : '')}</td><td>${escapeHtml(member.leaveDate ? formatDate(member.leaveDate) : '')}</td><td class="wrap">${escapeHtml(member.note || '')}</td><td><button type="button" onclick='editMember(${jsonAttr(member)})'>編集</button></td></tr>
  `).join('');
  document.getElementById('adminMembers').innerHTML = `<div class="table-wrap"><table><thead><tr><th>表示</th><th>状態</th><th>名前</th><th>学年</th><th>入会日</th><th>退会日</th><th>備考</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="8">メンバーがいません。</td></tr>'}</tbody></table></div>`;
}

async function renderAdminLogs() {
  const { data, error } = await supabaseClient.from('logs').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) {
    document.getElementById('adminLogs').textContent = error.message;
    return;
  }
  const rows = (data || []).map(log => `
    <tr><td>${escapeHtml(formatDateTime(log.created_at))}</td><td>${escapeHtml(log.action)}</td><td class="wrap">${escapeHtml(log.event_name || log.event_id || '-')}</td><td>${escapeHtml(log.member_name || '-')}</td><td>${escapeHtml(log.old_status || '-')}</td><td>${escapeHtml(log.new_status || '-')}</td><td class="wrap">${escapeHtml(log.detail || '-')}</td></tr>
  `).join('');
  document.getElementById('adminLogs').innerHTML = `<div class="table-wrap"><table><thead><tr><th>日時</th><th>操作</th><th>予定</th><th>名前</th><th>変更前</th><th>変更後</th><th>詳細</th></tr></thead><tbody>${rows || '<tr><td colspan="7">ログがありません。</td></tr>'}</tbody></table></div>`;
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

  const { error } = await supabaseClient.from('events').upsert(payload);
  if (error) {
    showMessage('eventMessage', error.message, false);
    return;
  }

  await appendLog(document.getElementById('eventId').value ? '予定編集' : '予定追加', eventId, eventName, '', '', '', '', '');
  showMessage('eventMessage', `予定を保存しました。日程調整リンク：${createScheduleUrl(token)}`, true);
  clearEventForm();
  await refreshAll();
}

function editEvent(event) {
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
  if (!isAdmin() || !confirm('この予定を削除扱いにしますか？')) return;
  const event = publicData.events.find(item => item.eventId === eventId);
  const { error } = await supabaseClient.from('events').update({ public_state: '削除', updated_at: new Date().toISOString() }).eq('id', eventId);
  if (error) {
    showMessage('eventMessage', error.message, false);
    return;
  }
  await appendLog('予定削除', eventId, event ? event.eventName : '', '', '', '', '削除', '');
  showMessage('eventMessage', '予定を削除扱いにしました。', true);
  await refreshAll();
}

function clearEventForm() {
  ['eventId', 'eventToken', 'eventName', 'eventDate', 'startTime', 'endTime', 'place', 'placeUrl', 'creator', 'answerDeadline', 'eventNote'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('eventCategory').value = '';
}

async function saveMemberForm() {
  if (!isAdmin()) return;
  const memberId = document.getElementById('memberId').value || crypto.randomUUID();
  const name = document.getElementById('memberName').value.trim();

  if (!name) {
    showMessage('memberMessage', '名前を入力してください。', false);
    return;
  }

  const payload = {
    id: memberId,
    name,
    grade: document.getElementById('grade').value.trim(),
    age: nullIfEmpty(document.getElementById('age').value),
    contact: document.getElementById('contact').value.trim(),
    join_date: nullIfEmpty(document.getElementById('joinDate').value),
    leave_date: nullIfEmpty(document.getElementById('leaveDate').value),
    member_state: document.getElementById('memberState').value || '在籍',
    visible: document.getElementById('visible').value === 'true',
    costume_size: document.getElementById('costumeSize').value.trim(),
    bag_size: document.getElementById('bagSize').value.trim(),
    note: document.getElementById('memberNote').value.trim(),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseClient.from('members').upsert(payload);
  if (error) {
    showMessage('memberMessage', error.message, false);
    return;
  }

  await appendLog(document.getElementById('memberId').value ? 'メンバー編集' : 'メンバー追加', '', '', memberId, name, '', '', '');
  showMessage('memberMessage', 'メンバーを保存しました。', true);
  clearMemberForm();
  await refreshAll();
}

function editMember(member) {
  switchAdminTab('memberForm');
  document.getElementById('memberId').value = member.memberId || '';
  document.getElementById('memberName').value = member.name || '';
  document.getElementById('grade').value = member.grade || '';
  document.getElementById('age').value = member.age || '';
  document.getElementById('contact').value = member.contact || '';
  document.getElementById('joinDate').value = member.joinDate || '';
  document.getElementById('leaveDate').value = member.leaveDate || '';
  document.getElementById('memberState').value = member.memberState || '在籍';
  document.getElementById('visible').value = member.visible ? 'true' : 'false';
  document.getElementById('costumeSize').value = member.costumeSize || '';
  document.getElementById('bagSize').value = member.bagSize || '';
  document.getElementById('memberNote').value = member.note || '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearMemberForm() {
  ['memberId', 'memberName', 'grade', 'age', 'contact', 'joinDate', 'leaveDate', 'costumeSize', 'bagSize', 'memberNote'].forEach(id => {
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
    detail: detail || ''
  });
}

function switchView(name) {
  if (name === 'admin' && !isAdmin()) return;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  document.getElementById(`${name}View`).classList.add('active');
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

function openAnswerUrl(url) {
  if (url) window.open(url, '_blank', 'noopener');
}

function createScheduleUrl(token) {
  const base = String(window.location.href || '').split('?')[0];
  return `${base}?schedule=${encodeURIComponent(token)}`;
}

function copyShareText(eventId) {
  const event = publicData.events.find(item => item.eventId === eventId);
  if (!event) return;
  const text = createShareText(event);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => showTemporaryStatus('共有文をコピーしました。')).catch(() => showSharePrompt(text));
  } else {
    showSharePrompt(text);
  }
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

function showTemporaryStatus(text) {
  const status = document.getElementById('publicStatus');
  if (status) status.textContent = text;
}

function showSharePrompt(text) {
  window.prompt('共有文をコピーしてください。', text);
}

function buildReasonText(category, detail) {
  const cleanCategory = String(category || '').trim();
  const cleanDetail = String(detail || '').trim();
  if (cleanCategory && cleanDetail) return `${cleanCategory}：${cleanDetail}`;
  return cleanCategory || cleanDetail;
}

function setReasonFields(reasonText) {
  const text = String(reasonText || '').trim();
  const categorySelect = document.getElementById('answerReasonCategory');
  const reasonInput = document.getElementById('answerReason');
  categorySelect.value = '';
  reasonInput.value = '';
  if (!text) return;
  const matchedCategory = REASON_CATEGORIES.find(category => text === category || text.startsWith(`${category}：`));
  if (matchedCategory) {
    categorySelect.value = matchedCategory;
    reasonInput.value = text === matchedCategory ? '' : text.slice(matchedCategory.length + 1);
    return;
  }
  reasonInput.value = text;
}

function getEligibleMembers(event, members) {
  const eventDate = parseDate(event.date);
  return members.filter(member => {
    if (!member.visible) return false;
    const joinDate = parseDate(member.joinDate);
    const leaveDate = parseDate(member.leaveDate);
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
    grade: row.grade || '',
    age: row.age || '',
    contact: row.contact || '',
    joinDate: normalizeDate(row.join_date),
    leaveDate: normalizeDate(row.leave_date),
    memberState: row.member_state || '在籍',
    note: row.note || '',
    costumeSize: row.costume_size || '',
    bagSize: row.bag_size || '',
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

function showMessage(id, text, ok) {
  const element = document.getElementById(id);
  element.className = `message ${ok ? 'ok' : 'error'}`;
  element.textContent = text;
}

function jsonAttr(value) {
  return escapeAttr(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
